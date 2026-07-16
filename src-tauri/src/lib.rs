mod commands;
mod db;
mod scan;
mod shell_open;

use db::{db_health, open_and_migrate, DbState};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = open_and_migrate(app.handle()).map_err(|e| {
                Box::<dyn std::error::Error>::from(e)
            })?;
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_health,
            commands::pick_folder,
            commands::pick_file,
            commands::get_last_root,
            commands::get_root_info,
            commands::settings_get,
            commands::settings_set,
            commands::scan_root,
            commands::get_media,
            commands::get_first_media,
            commands::get_neighbor,
            commands::get_random,
            commands::list_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::add_media_tag,
            commands::remove_media_tag,
            commands::add_tag_asset,
            commands::remove_tag_asset,
            shell_open::path_exists,
            shell_open::open_with_default,
            shell_open::open_with_vlc,
            shell_open::open_parent_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
