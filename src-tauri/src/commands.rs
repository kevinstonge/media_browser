//! Tauri IPC commands for folder pick, scan, settings, tags, and media navigation.

use crate::db::{
    add_media_tag as db_add_media_tag, add_tag_asset as db_add_tag_asset,
    create_tag as db_create_tag, delete_tag as db_delete_tag,
    get_first_media as db_first, get_first_media_in_dir as db_first_in_dir,
    get_last_root as db_last_root, get_media as db_get_media, get_neighbor as db_neighbor,
    get_random as db_random, get_setting, list_media_in_dir as db_list_media_in_dir,
    list_parent_dirs as db_list_parent_dirs, list_tags as db_list_tags,
    remove_media_tag as db_remove_media_tag, remove_tag_asset as db_remove_tag_asset, root_info,
    root_info_by_path, set_setting, DbState, MediaItem, RootInfo, Tag, TagAsset,
};
use crate::scan::{self, ScanResult};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Native directory picker. Returns absolute filesystem path or null if cancelled.
#[tauri::command]
pub fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    // Prefer into_path over Display so Url variants become real FS paths; simplify UNC/`\\?\`.
    let path = folder
        .simplified()
        .into_path()
        .map_err(|e| format!("folder path: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Native file picker for tag assets. `kind`: "image" | "sound" | "any" (default any).
#[tauri::command]
pub fn pick_file(app: AppHandle, kind: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    match kind
        .as_deref()
        .unwrap_or("any")
        .to_ascii_lowercase()
        .as_str()
    {
        "image" => {
            dialog = dialog.add_filter(
                "Images",
                &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff"],
            );
        }
        "sound" | "audio" => {
            dialog = dialog.add_filter(
                "Audio",
                &["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "webm"],
            );
        }
        _ => {}
    }
    let Some(file) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = file
        .simplified()
        .into_path()
        .map_err(|e| format!("file path: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
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

/// Root info by filesystem path (for Scan vs Re-scan label in select modal).
#[tauri::command]
pub fn get_root_by_path(
    state: State<'_, DbState>,
    path: String,
) -> Result<Option<RootInfo>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    root_info_by_path(&conn, &path)
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
/// Optional `parent_dir` limits sequential navigation to one folder.
#[tauri::command]
pub fn get_neighbor(
    state: State<'_, DbState>,
    id: i64,
    direction: String,
    parent_dir: Option<String>,
) -> Result<Option<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_neighbor(&conn, id, &direction, parent_dir.as_deref())
}

/// Random non-missing item in root; optional parent_dir for current-dir random.
/// `exclude_id` avoids immediate repeat when another item exists.
#[tauri::command]
pub fn get_random(
    state: State<'_, DbState>,
    root_id: i64,
    parent_dir: Option<String>,
    exclude_id: Option<i64>,
) -> Result<Option<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_random(&conn, root_id, parent_dir.as_deref(), exclude_id)
}

/// Distinct parent directories (absolute) under root with non-missing media.
#[tauri::command]
pub fn list_parent_dirs(
    state: State<'_, DbState>,
    root_id: i64,
) -> Result<Vec<String>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_list_parent_dirs(&conn, root_id)
}

/// Media items in one parent directory (no tags; for file picker lists).
#[tauri::command]
pub fn list_media_in_dir(
    state: State<'_, DbState>,
    root_id: i64,
    parent_dir: String,
) -> Result<Vec<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_list_media_in_dir(&conn, root_id, &parent_dir)
}

/// First non-missing item in a parent directory (alpha by filename).
#[tauri::command]
pub fn get_first_media_in_dir(
    state: State<'_, DbState>,
    root_id: i64,
    parent_dir: String,
) -> Result<Option<MediaItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_first_in_dir(&conn, root_id, &parent_dir)
}

// --- Tags -------------------------------------------------------------------

#[tauri::command]
pub fn list_tags(state: State<'_, DbState>) -> Result<Vec<Tag>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_list_tags(&conn)
}

#[tauri::command]
pub fn create_tag(state: State<'_, DbState>, name: String) -> Result<Tag, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_create_tag(&conn, &name)
}

#[tauri::command]
pub fn delete_tag(state: State<'_, DbState>, tag_id: i64) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_delete_tag(&conn, tag_id)
}

#[tauri::command]
pub fn add_media_tag(
    state: State<'_, DbState>,
    media_item_id: i64,
    tag_id: i64,
) -> Result<Tag, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_add_media_tag(&conn, media_item_id, tag_id)
}

#[tauri::command]
pub fn remove_media_tag(
    state: State<'_, DbState>,
    media_item_id: i64,
    tag_id: i64,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_remove_media_tag(&conn, media_item_id, tag_id)
}

#[tauri::command]
pub fn add_tag_asset(
    state: State<'_, DbState>,
    tag_id: i64,
    asset_type: String,
    path: String,
) -> Result<TagAsset, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_add_tag_asset(&conn, tag_id, &asset_type, &path)
}

#[tauri::command]
pub fn remove_tag_asset(state: State<'_, DbState>, asset_id: i64) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;
    db_remove_tag_asset(&conn, asset_id)
}
