#[cfg(all(debug_assertions, windows))]
mod spike;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Milestone 6 spike commands (dev builds on Windows only).
    #[cfg(all(debug_assertions, windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        spike::spike_log,
        spike::spike_window_info,
        spike::spike_find_windows,
        spike::spike_list_audio_sessions,
        spike::spike_capture,
    ]);

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Jay-C");
}
