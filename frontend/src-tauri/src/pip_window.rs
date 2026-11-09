//! Our own PiP window (Windows). WebView2's video PiP showed the page's origin ("tauri.localhost")
//! and had no room for our buttons, and Document PiP doesn't open there. So the page calls
//! `window.open()` and this turns it into a small always-on-top, borderless Jay-C window, which the
//! page (the opener: same process, so the same MediaStream works there) fills with the video and
//! its buttons (frontend/src/core/pip.js).

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// The PiP window has no title bar: the page calls this on a mouse press to move it.
#[tauri::command]
pub fn pip_drag<R: Runtime>(app: AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("pip-") {
            let _ = window.start_dragging();
        }
    }
}

/// Closes the PiP window. The page's `window.close()` only closed the page inside it (measured: a
/// white window with no buttons stayed). Also runs when the main window goes, or the app kept running.
#[tauri::command]
pub fn pip_close<R: Runtime>(app: AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("pip-") {
            let _ = window.destroy();
        }
    }
}

/// The main window's `on_new_window`: only the PiP (about:blank) opens here. A web link from a chat
/// (`<a target="_blank">`) goes to the default browser; anything else is refused.
pub fn open<R: Runtime>(app: &AppHandle<R>, url: Url, features: NewWindowFeatures) -> NewWindowResponse<R> {
    if url.as_str() != "about:blank" {
        if matches!(url.scheme(), "http" | "https") {
            open_in_browser(&url);
        } else {
            log::warn!("refused a new window for {url}");
        }
        return NewWindowResponse::Deny;
    }
    let label = format!("pip-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .window_features(features)
        .title("Jay-C")
        .always_on_top(true)
        .decorations(false)
        .resizable(true)
        .min_inner_size(200.0, 112.0)
        .build();
    match window {
        Ok(window) => NewWindowResponse::Create { window },
        Err(error) => {
            log::warn!("pip window: {error}");
            NewWindowResponse::Deny
        }
    }
}

/// Opens a web address in the user's default browser (only http and https reach here).
fn open_in_browser(url: &Url) {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let target = HSTRING::from(url.as_str());
    let result = unsafe { ShellExecuteW(None, w!("open"), &target, None, None, SW_SHOWNORMAL) };
    // ShellExecute reports success with a value above 32.
    if result.0 as usize <= 32 {
        log::warn!("couldn't open {url} in the browser");
    }
}
