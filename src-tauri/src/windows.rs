//! Windows: one per document. Each one takes the file it opens from here when it boots.

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::{err, Res};

/// The file each window opens at boot, by window label, taken by the window when it asks. The
/// first window's comes from the command line, a macOS "open with" at launch, or the documents
/// that were open before an update restart; any later window is given its file as it is made.
#[derive(Default)]
pub struct Startup {
    pub paths: Mutex<HashMap<String, String>>,
    /// the first window has booted, so a file that arrives now needs a window of its own
    pub main_booted: AtomicBool,
}

/// Labels are never reused: "w" + the count of open windows would collide once one had closed.
static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(2);

#[tauri::command]
pub fn startup_path(window: tauri::Window, state: State<'_, Startup>) -> Option<String> {
    if window.label() == "main" {
        state.main_booted.store(true, Ordering::SeqCst);
    }
    state.paths.lock().ok()?.remove(window.label())
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
pub fn open_window(app: &tauri::AppHandle, path: Option<String>) -> Res<()> {
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
pub fn new_window(app: tauri::AppHandle) -> Res<()> {
    open_window(&app, None)
}

/// ⌘W: takes the same path as clicking the red light (close_requested → unsaved-changes confirm)
/// instead of destroying the window outright.
#[tauri::command]
pub fn close_window(window: tauri::Window) -> Res<()> {
    window.close().map_err(err)
}

#[tauri::command]
pub fn set_title(window: tauri::Window, title: String) -> Res<()> {
    window.set_title(&title).map_err(err)
}

/// Where this window is on screen, in logical points — so a verification screenshot can
/// capture exactly this window and nothing else of whatever the person had open.
#[derive(Serialize)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[tauri::command]
pub fn window_rect(window: tauri::Window) -> Option<Rect> {
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

/// A path handed to us on the command line (`irori note.md`) — on Windows this is also
/// how double-clicking a .md arrives.
pub fn arg_path() -> Option<String> {
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
