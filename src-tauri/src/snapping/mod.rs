#[cfg(any(windows, test))]
mod geometry;
#[cfg(any(windows, test))]
mod resize;
#[cfg(windows)]
mod windows;

pub fn attach(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    return windows::attach(window);

    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(windows)]
pub fn client_offset(window: &tauri::WebviewWindow) -> Result<(i32, i32), String> {
    windows::client_offset(window)
}
