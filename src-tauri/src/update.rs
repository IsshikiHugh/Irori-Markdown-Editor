//! Self-update: find a newer release, download and verify it, then — once every window is
//! ready — install it and restart into it with the same documents open again.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::{err, Res};

/// How often the automatic check may run. Every window asks once an hour; whichever asks first
/// once this much time has passed does the check (and is the one to offer what it finds) — so
/// a copy left open for days still hears about a release, and never in more than one window.
const AUTO_EVERY: Duration = Duration::from_secs(24 * 3600);
/// A window acknowledges "get ready to restart" as soon as it hears it; one that doesn't (it
/// was just closed, or has not finished loading) has nothing to keep and is passed over.
const ACK_WAIT: Duration = Duration::from_secs(5);
/// Getting ready may mean a save panel, so that answer is waited for much longer.
const READY_WAIT: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct Updates {
    last_auto: Mutex<Option<Instant>>,
    found: Mutex<Option<tauri_plugin_updater::Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    /// an update is being applied: a second request (another window's button) is turned away
    applying: AtomicBool,
    /// the window being asked to get ready, and where its answers go
    asking: Mutex<Option<(String, mpsc::Sender<Answer>)>>,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
}

enum Answer {
    Ack,
    /// whether the window may go, and which file to open again afterwards
    Ready(bool, Option<String>),
}

/// Whether a newer release is published. The automatic check is quiet on every failure —
/// offline, rate-limited, no release for this platform — since an update check must never be
/// in the way of writing, and it never runs in debug builds or smoke runs. A `manual` check
/// (the drawer's button) always asks and reports what went wrong.
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle, manual: bool) -> Res<Option<UpdateInfo>> {
    let updates = app.state::<Updates>();
    if cfg!(debug_assertions) {
        return if manual {
            Err("开发版本不检查更新".into())
        } else {
            Ok(None)
        };
    }
    if !manual {
        if std::env::var_os("IRORI_SMOKE_OUT").is_some() {
            return Ok(None);
        }
        let mut last = updates.last_auto.lock().map_err(err)?;
        if last.is_some_and(|t| t.elapsed() < AUTO_EVERY) {
            return Ok(None);
        }
        *last = Some(Instant::now());
    }
    let Some(update) = app.updater().map_err(err)?.check().await.map_err(err)? else {
        return Ok(None);
    };
    let info = UpdateInfo {
        version: update.version.clone(),
    };
    let mut found = updates.found.lock().map_err(err)?;
    if found.as_ref().map(|u| &u.version) != Some(&update.version) {
        *updates.bytes.lock().map_err(err)? = None; // bytes of an older find are of no use
    }
    *found = Some(update);
    Ok(Some(info))
}

/// Download the release `check_update` found and verify it against the public key in
/// tauri.conf.json. Nothing is installed yet: that waits until every window is ready.
#[tauri::command]
pub async fn download_update(app: tauri::AppHandle) -> Res<()> {
    let updates = app.state::<Updates>();
    if updates.bytes.lock().map_err(err)?.is_some() {
        return Ok(());
    }
    let update = updates
        .found
        .lock()
        .map_err(err)?
        .clone()
        .ok_or("没有可安装的更新")?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(err)?;
    *updates.bytes.lock().map_err(err)? = Some(bytes);
    Ok(())
}

/// Install the downloaded update and restart into it, with the same documents open again.
///
/// Every window is asked in turn — brought to the front first, since it may need to ask its own
/// question — to get ready: a named file is saved in place, an unnamed one with text asks to be
/// saved, and a window that is ready stops taking edits. If any window declines, nothing is
/// installed, every window is told to carry on (`irori://restart-cancelled`) and `false` comes
/// back; the download is kept for another try. (Windows: the installer takes over, closes the
/// app and starts the new version itself.)
#[tauri::command]
pub async fn apply_update(app: tauri::AppHandle) -> Res<bool> {
    let updates = app.state::<Updates>();
    if updates.applying.swap(true, Ordering::SeqCst) {
        return Err("已经在更新了".into());
    }
    // a restart never comes back here; anything that does means the windows carry on
    let result = prepare_and_install(&app).await;
    updates.applying.store(false, Ordering::SeqCst);
    let _ = app.emit("irori://restart-cancelled", ());
    result
}

async fn prepare_and_install(app: &tauri::AppHandle) -> Res<bool> {
    let updates = app.state::<Updates>();
    let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
    // the first window first, then the rest in the order they were opened
    windows.sort_by_key(|(label, _)| label.trim_start_matches('w').parse::<usize>().unwrap_or(0));
    let mut paths = Vec::new();
    for (label, win) in windows {
        let (tx, rx) = mpsc::channel();
        *updates.asking.lock().map_err(err)? = Some((label.clone(), tx));
        let _ = win.set_focus();
        app.emit_to(label.as_str(), "irori://prepare-restart", ())
            .map_err(err)?;
        let answer =
            tauri::async_runtime::spawn_blocking(move || match rx.recv_timeout(ACK_WAIT) {
                Ok(Answer::Ack) => match rx.recv_timeout(READY_WAIT) {
                    Ok(Answer::Ready(ok, path)) => Some((ok, path)),
                    _ => Some((false, None)),
                },
                Ok(Answer::Ready(ok, path)) => Some((ok, path)),
                Err(_) => None,
            })
            .await
            .map_err(err)?;
        *updates.asking.lock().map_err(err)? = None;
        match answer {
            None => continue, // gone, or not listening yet: nothing of it to keep
            Some((true, path)) => paths.extend(path),
            Some((false, _)) => return Ok(false),
        }
    }

    let update = updates
        .found
        .lock()
        .map_err(err)?
        .clone()
        .ok_or("没有可安装的更新")?;
    let bytes = updates
        .bytes
        .lock()
        .map_err(err)?
        .take()
        .ok_or("更新还没有下载")?;
    fs::write(
        reopen_file(app)?,
        serde_json::to_string(&paths).map_err(err)?,
    )
    .map_err(err)?;
    if let Err(e) = update.install(&bytes) {
        let _ = fs::remove_file(reopen_file(app)?);
        *updates.bytes.lock().map_err(err)? = Some(bytes);
        return Err(err(e));
    }
    app.restart()
}

/// Pass a window's answer on, if it is the window being asked right now.
fn answer(window: &tauri::Window, state: &Updates, a: Answer) {
    if let Ok(asking) = state.asking.lock() {
        if let Some((label, tx)) = asking.as_ref() {
            if label == window.label() {
                let _ = tx.send(a);
            }
        }
    }
}

/// "Heard it" — sent the moment `irori://prepare-restart` arrives.
#[tauri::command]
pub fn restart_ack(window: tauri::Window, state: State<'_, Updates>) {
    answer(&window, &state, Answer::Ack);
}

/// The window is ready to go (or not), and the file to reopen.
#[tauri::command]
pub fn restart_ready(
    window: tauri::Window,
    state: State<'_, Updates>,
    ok: bool,
    path: Option<String>,
) {
    answer(&window, &state, Answer::Ready(ok, path));
}

/// The documents to open again after an update restart.
fn reopen_file(app: &tauri::AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("reopen.json"))
}

/// Read and forget the reopen list: a crash on the next launch must not keep bringing it back.
pub fn take_reopen(app: &tauri::AppHandle) -> Option<Vec<String>> {
    let file = reopen_file(app).ok()?;
    let raw = fs::read_to_string(&file).ok()?;
    let _ = fs::remove_file(file);
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}
