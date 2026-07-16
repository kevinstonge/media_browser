mod db;

use db::{db_health, open_and_migrate, DbState};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let conn = open_and_migrate(app.handle()).map_err(|e| {
                Box::<dyn std::error::Error>::from(e)
            })?;
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_health])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
