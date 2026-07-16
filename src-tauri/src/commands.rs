//! Tauri IPC commands for folder pick, scan, settings, and media navigation.

use crate::db::{
    get_first_media as db_first, get_last_root as db_last_root, get_media as db_get_media,
    get_neighbor as db_neighbor, get_random as db_random, get_setting, root_info, set_setting,
    DbState, MediaItem, RootInfo,
};
use crate::scan::{self, ScanResult};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Native directory picker. Returns absolute path or null if cancelled.
#[tauri::command]
pub fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|p| p.to_string()))
}

/// Most recently active / used root with scan label hints.
#[tauri::command]
pub fn get_last_root(state: State<'_, DbState>) -> Result<Option<RootInfo>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_last_root(&conn)
}

/// Root info by id (path, counts, needs_scan for button label).
#[tauri::command]
pub fn get_root_info(state: State<'_, DbState>, root_id: i64) -> Result<Option<RootInfo>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    root_info(&conn, root_id)
}

/// Read a setting value (JSON-encoded string as stored).
#[tauri::command]
pub fn settings_get(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    get_setting(&conn, &key)
}

/// Write a setting value (store as-is; frontend JSON-encodes complex values).
#[tauri::command]
pub fn settings_set(
    state: State<'_, DbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    set_setting(&conn, &key, &value)
}

/// Recursive scan / re-scan of a root folder into SQLite.
#[tauri::command]
pub fn scan_root(state: State<'_, DbState>, path: String) -> Result<ScanResult, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    scan::scan_root(&conn, &path)
}

/// Basic media row by id.
#[tauri::command]
pub fn get_media(state: State<'_, DbState>, id: i64) -> Result<Option<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_get_media(&conn, id)
}

/// First non-missing item under root (alpha by rel_path).
#[tauri::command]
pub fn get_first_media(
    state: State<'_, DbState>,
    root_id: i64,
) -> Result<Option<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_first(&conn, root_id)
}

/// Alpha neighbor; direction = "next" | "prev". Wraps at ends.
#[tauri::command]
pub fn get_neighbor(
    state: State<'_, DbState>,
    id: i64,
    direction: String,
) -> Result<Option<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_neighbor(&conn, id, &direction)
}

/// Random non-missing item in root; optional parent_dir for current-dir random.
#[tauri::command]
pub fn get_random(
    state: State<'_, DbState>,
    root_id: i64,
    parent_dir: Option<String>,
) -> Result<Option<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_random(&conn, root_id, parent_dir.as_deref())
}
