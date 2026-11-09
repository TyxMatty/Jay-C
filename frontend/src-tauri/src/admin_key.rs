//! The admin key field in the server setup guide: the key the host types becomes the Windows user
//! environment variable ADMIN_KEY (HKCU\Environment), so `npm run server` in a new terminal starts
//! with it. The app registers the same key as this PC's admin key for the local server.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, LPARAM, WPARAM};
use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};

const ENVIRONMENT: PCWSTR = w!("Environment");
const NAME: PCWSTR = w!("ADMIN_KEY");

/// 8–256 characters (the app's key field takes 256), no control characters, no spaces at the ends
/// (a terminal would trim them, and the key would no longer match).
fn valid_key(key: &str) -> bool {
    (8..=256).contains(&key.chars().count()) && !key.chars().any(char::is_control) && key.trim() == key
}

/// Saves `key` as the user's ADMIN_KEY, replacing any earlier one.
#[tauri::command]
pub fn set_admin_key_env(key: String) -> Result<(), String> {
    if !valid_key(&key) {
        return Err("bad-key".into());
    }
    let wide: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let status = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, ENVIRONMENT, NAME, REG_SZ.0, Some(wide.as_ptr().cast()), (wide.len() * 2) as u32) };
    if status != ERROR_SUCCESS {
        return Err(format!("write: {status:?}"));
    }
    // Explorer re-reads the environment, so terminals opened from now on see the key.
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(ENVIRONMENT.as_ptr() as isize), SMTO_ABORTIFHUNG, 3000, None);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_key;

    #[test]
    fn keys_a_terminal_would_change_are_refused() {
        assert!(valid_key("a-long-secret"));
        assert!(valid_key("senha com espaço no meio"));
        assert!(!valid_key("short"));
        assert!(!valid_key(&"a".repeat(257)));
        assert!(!valid_key(" leading-space"));
        assert!(!valid_key("trailing-space "));
        assert!(!valid_key("line\nbreak-here"));
    }
}
