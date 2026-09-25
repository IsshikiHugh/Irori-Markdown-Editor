//! The Tauri shell.
//!
//! Deliberately thin: file IO, dialogs, windows (windows.rs), settings, self-update
//! (update.rs). Everything the writing experience is made of lives in the web layer, so
//! swapping this shell out (the escape hatch if Linux/WebKitGTK ever becomes untenable) does
//! not touch the editor.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "macos")]
mod pdf;
mod update;
mod windows;

use update::Updates;
use windows::{arg_path, open_window, Startup};

#[derive(Serialize)]
struct Stat {
    #[serde(rename = "mtimeMs")]
    mtime_ms: f64,
    size: u64,
}

pub(crate) type Res<T> = Result<T, String>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
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

/// Write a NEW file; never replaces one. `false` when the name is taken. The check is the file
/// system's own (O_EXCL), made in the same step as the create, so neither a case-insensitive
/// volume ("Shot.png" vs "shot.png") nor a file that appeared a moment ago can be overwritten.
#[tauri::command]
fn create_binary(path: String, data: Vec<u8>) -> Res<bool> {
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(err(e)),
    };
    if let Err(e) = file.write_all(&data) {
        // the file is ours (we just created it): do not leave half an image behind
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(err(e));
    }
    Ok(true)
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

/// The argument is named `settings` because that is the key the page sends
/// (`invoke('save_settings', { settings })`); Tauri matches arguments by name.
/// Private to this user: the settings hold the key this Irori signs in to remote servers with.
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Res<()> {
    let file = settings_file(&app)?;
    let text = serde_json::to_string_pretty(&settings).map_err(err)?;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(&file)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(err)?;
    // `mode` only applies to a new file: tighten one written by an earlier version too
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).map_err(err)?;
    }
    Ok(())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Startup::default())
        .manage(Updates::default())
        .invoke_handler(tauri::generate_handler![
            windows::startup_path,
            smoke_out,
            windows::window_rect,
            open_dialog,
            confirm_dialog,
            save_dialog,
            print_pdf,
            open_url,
            update::app_version,
            update::check_update,
            update::download_update,
            update::apply_update,
            update::restart_ack,
            update::restart_ready,
            read_text,
            write_text,
            create_binary,
            mkdirp,
            stat_path,
            list_dir,
            windows::new_window,
            windows::close_window,
            windows::set_title,
            load_settings,
            save_settings
        ])
        .setup(|app| {
            // the first window opens the file it was launched with, or — after an update
            // restart — the documents that were open, the rest of them in windows of their own
            // (a restart passes the original command line again, so after one the list — not
            // the file the app was first launched with — is what was open)
            let mut paths = update::take_reopen(app.handle())
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
                    if !startup
                        .main_booted
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
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
