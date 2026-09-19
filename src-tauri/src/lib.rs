//! The Tauri shell.
//!
//! Deliberately thin: file IO, dialogs, windows, settings. Everything the writing
//! experience is made of lives in the web layer, so swapping this shell out (the escape
//! hatch if Linux/WebKitGTK ever becomes untenable) does not touch the editor.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::Emitter; // only macOS "open with" events need to send the path to a new window
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
mod pdf;

/// The file this window was launched with (CLI argument, or a macOS "open with" event).
#[derive(Default)]
struct Startup(Mutex<Option<String>>);

/// Self-update. The check runs once per app run and only the first window to ask is told — with
/// one window per document, every other window would otherwise repeat the same offer. The
/// release found is kept here until the person accepts it.
#[derive(Default)]
struct Updates {
    asked: AtomicBool,
    found: Mutex<Option<tauri_plugin_updater::Update>>,
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    /// installing closes the app (Windows hands over to the installer); elsewhere the new
    /// version simply runs from the next launch
    quits: bool,
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
fn startup_path(state: State<'_, Startup>) -> Option<String> {
    state.0.lock().ok()?.clone()
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
async fn confirm_dialog(app: tauri::AppHandle, message: String) -> bool {
    wait_for(|tx| {
        app.dialog()
            .message(message)
            .title("Irori")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                "关闭".into(),
                "取消".into(),
            ))
            .show(move |answer| {
                let _ = tx.send(answer);
            })
    })
    .await
    .unwrap_or(false)
}

/// Whether a newer release is published. Quiet on every failure (offline, rate-limited, no
/// release for this platform): an update check must never be in the way of writing. Debug
/// builds and smoke runs never ask.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Option<UpdateInfo> {
    let updates = app.state::<Updates>();
    if cfg!(debug_assertions)
        || std::env::var_os("IRORI_SMOKE_OUT").is_some()
        || updates.asked.swap(true, Ordering::SeqCst)
    {
        return None;
    }
    let update = app.updater().ok()?.check().await.ok()??;
    let info = UpdateInfo {
        version: update.version.clone(),
        quits: cfg!(windows),
    };
    *updates.found.lock().ok()? = Some(update);
    Some(info)
}

/// Download, verify (against the public key in tauri.conf.json) and install the release that
/// `check_update` found. On failure it stays around, so the person can try again.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Res<()> {
    let updates = app.state::<Updates>();
    let update = updates
        .found
        .lock()
        .map_err(err)?
        .take()
        .ok_or("没有可安装的更新")?;
    let result = update.download_and_install(|_, _| {}, || {}).await;
    if result.is_err() {
        *updates.found.lock().map_err(err)? = Some(update);
    }
    result.map_err(err)
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

#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Res<()> {
    let label = format!("w{}", app.webview_windows().len() + 1);
    let win = window(&app, label).build().map_err(err)?;
    let _ = win.set_focus();
    Ok(())
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
        .manage(Startup(Mutex::new(arg_path())))
        .manage(Updates::default())
        .invoke_handler(tauri::generate_handler![
            startup_path,
            smoke_out,
            window_rect,
            open_dialog,
            confirm_dialog,
            save_dialog,
            print_pdf,
            check_update,
            install_update,
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
                    if let Ok(path) = url.to_file_path() {
                        let path = path.to_string_lossy().to_string();
                        if let Some(state) = app.try_state::<Startup>() {
                            let mut slot = state.0.lock().unwrap();
                            if slot.is_none() {
                                *slot = Some(path.clone());
                                continue; // the first window will pick it up at boot
                            }
                        }
                        let label = format!("w{}", app.webview_windows().len() + 1);
                        if let Ok(win) =
                            WebviewWindowBuilder::new(app, label, WebviewUrl::default())
                                .title("Irori")
                                .build()
                        {
                            let _ = win.emit("irori://open-file", path);
                        }
                    }
                }
            }
        });
}
