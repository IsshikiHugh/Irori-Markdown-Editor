//! The Tauri shell.
//!
//! Deliberately thin: file IO, dialogs, windows, settings. Everything the writing
//! experience is made of lives in the web layer, so swapping this shell out (the escape
//! hatch if Linux/WebKitGTK ever becomes untenable) does not touch the editor.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
mod pdf;

/// The file each window opens at boot, by window label, taken by the window when it asks. The
/// first window's comes from the command line, a macOS "open with" at launch, or the documents
/// that were open before an update restart; any later window is given its file as it is made.
#[derive(Default)]
struct Startup {
    paths: Mutex<HashMap<String, String>>,
    /// the first window has booted, so a file that arrives now needs a window of its own
    main_booted: AtomicBool,
}

/// Labels are never reused: "w" + the count of open windows would collide once one had closed.
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(2);

/// Self-update. The automatic check runs once per app run and only the first window to ask is
/// told — with one window per document, every other window would otherwise repeat the same
/// offer. The release found, and once downloaded its bytes, wait here until the restart.
#[derive(Default)]
struct Updates {
    asked: AtomicBool,
    found: Mutex<Option<tauri_plugin_updater::Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    /// the window asked to get ready for the restart answers through this
    reply: Mutex<Option<mpsc::Sender<Ready>>>,
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
}

/// A window's answer to "the app is about to restart": whether it may go, and which file to
/// open again afterwards.
#[derive(Deserialize)]
struct Ready {
    ok: bool,
    path: Option<String>,
}

#[derive(Serialize)]
struct Stat {
    #[serde(rename = "mtimeMs")]
    mtime_ms: f64,
    size: u64,
}

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn startup_path(window: tauri::Window, state: State<'_, Startup>) -> Option<String> {
    if window.label() == "main" {
        state.main_booted.store(true, Ordering::SeqCst);
    }
    state.paths.lock().ok()?.remove(window.label())
}

/// Wait for a native dialog without blocking the thread that has to *run* it.
///
/// A synchronous `#[tauri::command]` runs on the main thread, and every `blocking_*`
/// dialog API parks that same thread until the panel answers — while the panel needs the
/// main thread to appear at all. That is a deadlock: the app freezes the moment you press
/// ⌘S. So these commands are `async`, hand the dialog a callback, and wait for it on a
/// blocking-pool thread instead.
async fn wait_for<T: Send + 'static>(start: impl FnOnce(std::sync::mpsc::Sender<T>)) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    start(tx);
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok())
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn open_dialog(app: tauri::AppHandle) -> Option<String> {
    wait_for(|tx| {
        app.dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown", "mdown", "txt"])
            .pick_file(move |p| {
                let _ = tx.send(p);
            })
    })
    .await
    .flatten()
    .and_then(|p| p.into_path().ok())
    .map(|p| p.to_string_lossy().to_string())
}

/// `kind` picks the file type: "pdf" for an export, Markdown otherwise.
#[tauri::command]
async fn save_dialog(
    app: tauri::AppHandle,
    suggested_name: Option<String>,
    kind: Option<String>,
) -> Option<String> {
    let (label, ext) = match kind.as_deref() {
        Some("pdf") => ("PDF", "pdf"),
        _ => ("Markdown", "md"),
    };
    wait_for(|tx| {
        app.dialog()
            .file()
            .add_filter(label, &[ext])
            .set_file_name(suggested_name.unwrap_or_else(|| format!("未命名.{ext}")))
            .save_file(move |p| {
                let _ = tx.send(p);
            })
    })
    .await
    .flatten()
    .and_then(|p| p.into_path().ok())
    .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn confirm_dialog(app: tauri::AppHandle, message: String, ok: Option<String>) -> bool {
    wait_for(|tx| {
        app.dialog()
            .message(message)
            .title("Irori")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                ok.unwrap_or_else(|| "关闭".into()),
                "取消".into(),
            ))
            .show(move |answer| {
                let _ = tx.send(answer);
            })
    })
    .await
    .unwrap_or(false)
}

/// Whether a newer release is published. The automatic check (at launch) is quiet on every
/// failure — offline, rate-limited, no release for this platform — since an update check must
/// never be in the way of writing, and it never runs in debug builds or smoke runs. A `manual`
/// check (the drawer's button) always asks and reports what went wrong.
#[tauri::command]
async fn check_update(app: tauri::AppHandle, manual: bool) -> Res<Option<UpdateInfo>> {
    let updates = app.state::<Updates>();
    if cfg!(debug_assertions) {
        return if manual {
            Err("开发版本不检查更新".into())
        } else {
            Ok(None)
        };
    }
    if !manual
        && (std::env::var_os("IRORI_SMOKE_OUT").is_some()
            || updates.asked.swap(true, Ordering::SeqCst))
    {
        return Ok(None);
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
/// tauri.conf.json. Nothing is installed yet: that waits until every window is ready to restart.
#[tauri::command]
async fn download_update(app: tauri::AppHandle) -> Res<()> {
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
/// saved. If any window declines, nothing is installed and `false` comes back; the download is
/// kept for another try. (Windows: the installer takes over, closes the app and starts the new
/// version itself.)
#[tauri::command]
async fn apply_update(app: tauri::AppHandle) -> Res<bool> {
    let updates = app.state::<Updates>();
    let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
    // the first window first, then the rest in the order they were opened
    windows.sort_by_key(|(label, _)| label.trim_start_matches('w').parse::<usize>().unwrap_or(0));
    let mut paths = Vec::new();
    for (label, win) in windows {
        let (tx, rx) = mpsc::channel();
        *updates.reply.lock().map_err(err)? = Some(tx);
        let _ = win.set_focus();
        app.emit_to(label.as_str(), "irori://prepare-restart", ())
            .map_err(err)?;
        // generous: the window may be waiting on a save panel
        let ready = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(600)).ok()
        })
        .await
        .ok()
        .flatten();
        match ready {
            Some(Ready { ok: true, path }) => paths.extend(path),
            _ => return Ok(false),
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
        reopen_file(&app)?,
        serde_json::to_string(&paths).map_err(err)?,
    )
    .map_err(err)?;
    if let Err(e) = update.install(&bytes) {
        let _ = fs::remove_file(reopen_file(&app)?);
        *updates.bytes.lock().map_err(err)? = Some(bytes);
        return Err(err(e));
    }
    app.restart()
}

/// A window's answer to `irori://prepare-restart`.
#[tauri::command]
fn restart_ready(state: State<'_, Updates>, ok: bool, path: Option<String>) {
    if let Some(tx) = state.reply.lock().ok().and_then(|mut r| r.take()) {
        let _ = tx.send(Ready { ok, path });
    }
}

/// The documents to open again after an update restart.
fn reopen_file(app: &tauri::AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("reopen.json"))
}

/// Read and forget the reopen list: a crash on the next launch must not keep bringing it back.
fn take_reopen(app: &tauri::AppHandle) -> Option<Vec<String>> {
    let file = reopen_file(app).ok()?;
    let raw = fs::read_to_string(&file).ok()?;
    let _ = fs::remove_file(file);
    serde_json::from_str(&raw).ok()
}

/// ⌘/Ctrl-click on a link: hand it to the default browser (or mail app). Only web and mail
/// links — a document must not be able to launch programs or open local files this way.
#[tauri::command]
fn open_url(url: String) -> Res<()> {
    let lower = url.to_ascii_lowercase();
    if !["http://", "https://", "mailto:"]
        .iter()
        .any(|s| lower.starts_with(s))
    {
        return Err("只能打开网址".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Print the page to PDF. With a `path` (macOS) the file is written directly, no panel shown;
/// without one the system print dialog opens, whose PDF option is the export on the other
/// platforms. What gets printed is decided by the page's print stylesheet.
#[tauri::command]
async fn print_pdf(window: tauri::WebviewWindow, path: Option<String>) -> Res<()> {
    let Some(path) = path else {
        return window.print().map_err(err);
    };
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        // the print operation must be started on the main thread; if the closure never runs,
        // `tx` is dropped with it and the wait below ends as a failure instead of hanging
        window
            .with_webview(move |wv| unsafe { pdf::start(wv.inner(), wv.ns_window(), &path, tx) })
            .map_err(err)?;
        let ok = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
            .await
            .unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err("PDF 写入失败".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("此平台请使用系统打印对话框导出 PDF".into())
    }
}

#[tauri::command]
fn read_text(path: String) -> Res<String> {
    fs::read_to_string(&path).map_err(err)
}

#[tauri::command]
fn write_text(path: String, content: String) -> Res<()> {
    if let Some(dir) = Path::new(&path).parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(&path, content).map_err(err)
}

#[tauri::command]
fn write_binary(path: String, data: Vec<u8>) -> Res<()> {
    if let Some(dir) = Path::new(&path).parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(&path, data).map_err(err)
}

#[tauri::command]
fn mkdirp(path: String) -> Res<()> {
    fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
fn stat_path(path: String) -> Option<Stat> {
    let meta = fs::metadata(&path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(Stat {
        mtime_ms: mtime,
        size: meta.len(),
    })
}

#[tauri::command]
fn list_dir(path: String) -> Res<Vec<String>> {
    let mut out = Vec::new();
    let dir = match fs::read_dir(&path) {
        Ok(d) => d,
        Err(_) => return Ok(out), // a folder that does not exist yet simply has nothing in it
    };
    for entry in dir.flatten() {
        out.push(entry.file_name().to_string_lossy().to_string());
    }
    Ok(out)
}

/// Every window this app opens looks the same as the one in tauri.conf.json: paper
/// background, light appearance, and — on macOS — a transparent title bar so the dark
/// system bar never sits on top of the page.
fn window(
    app: &tauri::AppHandle,
    label: String,
) -> tauri::WebviewWindowBuilder<'_, tauri::Wry, tauri::AppHandle> {
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("Irori")
        .inner_size(1100.0, 780.0)
        .min_inner_size(480.0, 360.0)
        .theme(Some(tauri::Theme::Light))
        .background_color(tauri::window::Color(0xf7, 0xf3, 0xec, 0xff));
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    b
}

/// A new window, opening `path` when given (a blank page otherwise).
fn open_window(app: &tauri::AppHandle, path: Option<String>) -> Res<()> {
    let label = format!("w{}", NEXT_WINDOW.fetch_add(1, Ordering::SeqCst));
    if let Some(path) = path {
        let startup = app.state::<Startup>();
        startup
            .paths
            .lock()
            .map_err(err)?
            .insert(label.clone(), path);
    }
    let win = window(app, label).build().map_err(err)?;
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Res<()> {
    open_window(&app, None)
}

/// ⌘W: takes the same path as clicking the red light (close_requested → unsaved-changes confirm)
/// instead of destroying the window outright.
#[tauri::command]
fn close_window(window: tauri::Window) -> Res<()> {
    window.close().map_err(err)
}

#[tauri::command]
fn set_title(window: tauri::Window, title: String) -> Res<()> {
    window.set_title(&title).map_err(err)
}

fn settings_file(app: &tauri::AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let file = settings_file(&app).ok()?;
    let raw = fs::read_to_string(file).ok()?;
    serde_json::from_str(&raw).ok()
}

#[derive(Deserialize)]
struct SaveSettings {
    settings: serde_json::Value,
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, payload: SaveSettings) -> Res<()> {
    let file = settings_file(&app)?;
    fs::write(
        file,
        serde_json::to_string_pretty(&payload.settings).map_err(err)?,
    )
    .map_err(err)
}

/// Where this window is on screen, in logical points — so a verification screenshot can
/// capture exactly this window and nothing else of whatever the person had open.
#[derive(Serialize)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[tauri::command]
fn window_rect(window: tauri::Window) -> Option<Rect> {
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        w: size.width as f64 / scale,
        h: size.height as f64 / scale,
    })
}

#[derive(Serialize)]
struct SmokeInfo {
    out: String,
    /// whether a macOS menu exists — ⌘C/⌘V hang off the standard Edit menu, so this is
    /// the difference between "no menu bar" and "no clipboard"
    menu: bool,
    /// keep the window open after writing the report (so it can be photographed)
    hold: bool,
    /// open a save panel and check the main thread is still alive afterwards —
    /// this is the regression guard for the ⌘S freeze
    dialog: bool,
    /// after the report, close the window the same way ⌘W does — the script then checks
    /// the process actually goes away (regression guard for "confirm, but it never closes")
    close: bool,
    /// export the document to `<out>.pdf` through the real print path (no panel) — the
    /// script then checks the file and its page count
    pdf: bool,
}

/// An empty string counts as "set" too, so check the value itself — otherwise `FOO="" app` would
/// accidentally turn on the dialog probe.
fn flag(name: &str) -> bool {
    std::env::var(name).map(|v| !v.is_empty()).unwrap_or(false)
}

/// Smoke check: when IRORI_SMOKE_OUT is set, the window writes a boot report there and
/// quits. It is how "the editor really does run inside the system WebView" becomes a
/// repeatable check instead of someone's memory of having looked at it once.
#[tauri::command]
fn smoke_out(app: tauri::AppHandle) -> Option<SmokeInfo> {
    let out = std::env::var("IRORI_SMOKE_OUT").ok()?;
    Some(SmokeInfo {
        out,
        menu: app.menu().is_some(),
        hold: flag("IRORI_SMOKE_HOLD"),
        dialog: flag("IRORI_SMOKE_DIALOG"),
        close: flag("IRORI_SMOKE_CLOSE"),
        pdf: flag("IRORI_SMOKE_PDF"),
    })
}

/// A path handed to us on the command line (`irori note.md`) — on Windows this is also
/// how double-clicking a .md arrives.
fn arg_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .and_then(|a| fs::canonicalize(&a).ok())
        .map(|p| plain_path(p.to_string_lossy().to_string()))
}

/// On Windows, canonicalize returns verbatim paths like `\\?\C:\...`. The frontend normalizes `\`
/// to `/` before joining the image folder, and `//?/C:/...` is no longer a valid path (the text
/// still loads, but images can be neither saved nor shown). So strip the prefix and restore a
/// plain `C:\...` / `\\server\share\...`.
fn plain_path(p: String) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Startup::default())
        .manage(Updates::default())
        .invoke_handler(tauri::generate_handler![
            startup_path,
            smoke_out,
            window_rect,
            open_dialog,
            confirm_dialog,
            save_dialog,
            print_pdf,
            app_version,
            open_url,
            check_update,
            download_update,
            apply_update,
            restart_ready,
            read_text,
            write_text,
            write_binary,
            mkdirp,
            stat_path,
            list_dir,
            new_window,
            close_window,
            set_title,
            load_settings,
            save_settings
        ])
        .setup(|app| {
            // the first window opens the file it was launched with, or — after an update
            // restart — the documents that were open, the rest of them in windows of their own
            // (a restart passes the original command line again, so after one the list — not
            // the file the app was first launched with — is what was open)
            let mut paths = take_reopen(app.handle())
                .unwrap_or_else(|| arg_path().into_iter().collect())
                .into_iter();
            if let Some(first) = paths.next() {
                let startup = app.state::<Startup>();
                startup
                    .paths
                    .lock()
                    .map_err(err)?
                    .insert("main".into(), first);
            }
            for path in paths {
                open_window(app.handle(), Some(path))?;
            }
            // Make the webview first responder: otherwise keyboard events don't reach the page
            // right after the window comes up, and shortcuts only work once the user clicks into
            // the text
            for (_, win) in app.webview_windows() {
                let _ = win.set_focus();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Irori")
        .run(|_app, _event| {
            // macOS: double-clicking a .md (or dropping one on the dock icon) arrives here.
            // One window per document, so each opened file gets its own window.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let app = _app;
                for url in urls {
                    let Ok(path) = url.to_file_path() else {
                        continue;
                    };
                    let path = path.to_string_lossy().to_string();
                    let startup = app.state::<Startup>();
                    if !startup.main_booted.load(Ordering::SeqCst) {
                        if let Ok(mut paths) = startup.paths.lock() {
                            if !paths.contains_key("main") {
                                paths.insert("main".into(), path);
                                continue; // the first window will pick it up at boot
                            }
                        }
                    }
                    let _ = open_window(app, Some(path));
                }
            }
        });
}
