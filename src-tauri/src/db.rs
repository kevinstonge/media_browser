//! SQLite open + v1 schema migration runner + media/root query helpers.
//! DB path: library.db alongside the executable (portable; same folder as the .exe).

use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// Shared SQLite connection (single-threaded access via mutex).
pub struct DbState(pub Mutex<Connection>);

/// Full v1 schema from PLAN.md §5.1 (applied inside a transaction when needed).
const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS root_dir (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_scanned  TEXT
);

CREATE TABLE IF NOT EXISTS root_usage (
  id            INTEGER PRIMARY KEY,
  root_dir_id   INTEGER NOT NULL REFERENCES root_dir(id) ON DELETE CASCADE,
  used_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_root_usage_used_at ON root_usage(used_at DESC);

CREATE TABLE IF NOT EXISTS media_item (
  id            INTEGER PRIMARY KEY,
  root_dir_id   INTEGER NOT NULL REFERENCES root_dir(id) ON DELETE CASCADE,
  path          TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  parent_dir    TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  media_type    TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'unknown')),
  ext           TEXT NOT NULL,
  size_bytes    INTEGER,
  mtime_ms      INTEGER,
  is_missing    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_root ON media_item(root_dir_id);
CREATE INDEX IF NOT EXISTS idx_media_parent ON media_item(root_dir_id, parent_dir);
CREATE INDEX IF NOT EXISTS idx_media_filename ON media_item(root_dir_id, filename COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_media_rel_path ON media_item(root_dir_id, rel_path COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS tag (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tag (
  media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  tag_id        INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (media_item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_media_tag_tag ON media_tag(tag_id);

CREATE TABLE IF NOT EXISTS tag_asset (
  id            INTEGER PRIMARY KEY,
  tag_id        INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  asset_type    TEXT NOT NULL CHECK (asset_type IN ('image', 'sound')),
  path          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tag_id, asset_type, path)
);
CREATE INDEX IF NOT EXISTS idx_tag_asset_tag ON tag_asset(tag_id, asset_type, sort_order);

CREATE TABLE IF NOT EXISTS setting (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  applied_at    TEXT NOT NULL
);
"#;

// --- DTOs -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagAsset {
    pub id: i64,
    pub tag_id: i64,
    pub asset_type: String,
    pub path: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub assets: Vec<TagAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: i64,
    pub root_dir_id: i64,
    pub path: String,
    pub filename: String,
    pub parent_dir: String,
    pub rel_path: String,
    pub media_type: String,
    pub ext: String,
    pub size_bytes: Option<i64>,
    pub mtime_ms: Option<i64>,
    pub is_missing: bool,
    /// Tags attached to this item (with assets). Empty for lightweight queries that skip load.
    #[serde(default)]
    pub tags: Vec<Tag>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub id: i64,
    pub path: String,
    pub last_scanned: Option<String>,
    pub item_count: i64,
    /// True when Scan label should show; false → Re-scan.
    pub needs_scan: bool,
}

fn map_media_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaItem> {
    let is_missing_i: i64 = row.get(10)?;
    Ok(MediaItem {
        id: row.get(0)?,
        root_dir_id: row.get(1)?,
        path: row.get(2)?,
        filename: row.get(3)?,
        parent_dir: row.get(4)?,
        rel_path: row.get(5)?,
        media_type: row.get(6)?,
        ext: row.get(7)?,
        size_bytes: row.get(8)?,
        mtime_ms: row.get(9)?,
        is_missing: is_missing_i != 0,
        tags: Vec::new(),
    })
}

const MEDIA_SELECT: &str = "SELECT id, root_dir_id, path, filename, parent_dir, rel_path,
        media_type, ext, size_bytes, mtime_ms, is_missing
     FROM media_item";

// --- Open / migrate ---------------------------------------------------------

/// `library.db` next to the running executable (portable install layout).
fn exe_dir_db_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("resolve current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| format!("current_exe has no parent directory: {}", exe.display()))?
        .to_path_buf();
    Ok(dir.join("library.db"))
}

fn is_migration_applied(conn: &Connection, version: i64) -> SqlResult<bool> {
    let has_table: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |row| row.get(0),
    )?;
    if has_table == 0 {
        return Ok(false);
    }
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        [version],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn run_migrations(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    if is_migration_applied(conn, 1)? {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(MIGRATION_V1)?;
    tx.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))",
        [],
    )?;
    tx.commit()?;

    Ok(())
}

/// Open library.db next to the executable and apply schema migrations.
pub fn open_and_migrate(_app: &AppHandle) -> Result<Connection, String> {
    let path = exe_dir_db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("open sqlite {}: {e}", path.display()))?;
    run_migrations(&conn).map_err(|e| format!("migrate: {e}"))?;
    Ok(conn)
}

/// Health check: confirms DB is open and v1 tables exist.
#[tauri::command]
pub fn db_health(state: State<'_, DbState>) -> Result<String, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("db lock poisoned: {e}"))?;

    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .map_err(|e| format!("sqlite_version: {e}"))?;

    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
             AND name IN ('root_dir','root_usage','media_item','tag','media_tag','tag_asset','setting')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("table check: {e}"))?;

    if tables < 7 {
        return Err(format!("expected 7 schema tables, found {tables}"));
    }

    let migration: i64 = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE version = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("migration check: {e}"))?;

    Ok(format!("sqlite {version}; schema v{migration}; tables ok"))
}

// --- Settings ---------------------------------------------------------------

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM setting WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("get_setting: {e}"))
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("set_setting: {e}"))?;
    Ok(())
}

// --- Root helpers -----------------------------------------------------------

pub fn root_info(conn: &Connection, root_id: i64) -> Result<Option<RootInfo>, String> {
    let row = conn
        .query_row(
            "SELECT id, path, last_scanned FROM root_dir WHERE id = ?1",
            params![root_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("root_info: {e}"))?;

    let Some((id, path, last_scanned)) = row else {
        return Ok(None);
    };

    let item_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM media_item WHERE root_dir_id = ?1 AND is_missing = 0",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| format!("item_count: {e}"))?;

    let needs_scan = last_scanned.is_none() || item_count == 0;

    Ok(Some(RootInfo {
        id,
        path,
        last_scanned,
        item_count,
        needs_scan,
    }))
}

pub fn get_last_root(conn: &Connection) -> Result<Option<RootInfo>, String> {
    // Prefer active_root_id setting; fall back to most recent root_usage.
    if let Some(raw) = get_setting(conn, "active_root_id")? {
        if let Ok(id) = serde_json::from_str::<i64>(&raw) {
            if let Some(info) = root_info(conn, id)? {
                return Ok(Some(info));
            }
        } else if raw == "null" {
            // explicit null
        }
    }

    let last_id: Option<i64> = conn
        .query_row(
            "SELECT root_dir_id FROM root_usage ORDER BY used_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("last root_usage: {e}"))?;

    match last_id {
        Some(id) => root_info(conn, id),
        None => Ok(None),
    }
}

// --- Tags -------------------------------------------------------------------

fn load_assets_for_tag(conn: &Connection, tag_id: i64) -> Result<Vec<TagAsset>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, tag_id, asset_type, path, sort_order
             FROM tag_asset
             WHERE tag_id = ?1
             ORDER BY sort_order ASC, id ASC",
        )
        .map_err(|e| format!("prepare tag_asset: {e}"))?;
    let rows = stmt
        .query_map(params![tag_id], |r| {
            Ok(TagAsset {
                id: r.get(0)?,
                tag_id: r.get(1)?,
                asset_type: r.get(2)?,
                path: r.get(3)?,
                sort_order: r.get(4)?,
            })
        })
        .map_err(|e| format!("query tag_asset: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("tag_asset row: {e}"))?);
    }
    Ok(out)
}

fn map_tag_row(conn: &Connection, id: i64, name: String, created_at: String) -> Result<Tag, String> {
    let assets = load_assets_for_tag(conn, id)?;
    Ok(Tag {
        id,
        name,
        created_at,
        assets,
    })
}

/// All tags in vocabulary, each with assets ordered by sort_order.
pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM tag ORDER BY name COLLATE NOCASE ASC")
        .map_err(|e| format!("prepare list_tags: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query list_tags: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, created_at) = row.map_err(|e| format!("list_tags row: {e}"))?;
        out.push(map_tag_row(conn, id, name, created_at)?);
    }
    Ok(out)
}

/// Tags attached to a media item (with assets).
pub fn tags_for_media(conn: &Connection, media_item_id: i64) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.created_at
             FROM tag t
             INNER JOIN media_tag mt ON mt.tag_id = t.id
             WHERE mt.media_item_id = ?1
             ORDER BY t.name COLLATE NOCASE ASC",
        )
        .map_err(|e| format!("prepare tags_for_media: {e}"))?;
    let rows = stmt
        .query_map(params![media_item_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query tags_for_media: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, created_at) = row.map_err(|e| format!("tags_for_media row: {e}"))?;
        out.push(map_tag_row(conn, id, name, created_at)?);
    }
    Ok(out)
}

/// Create a tag by name (case-insensitive unique). Returns existing if name collides.
pub fn create_tag(conn: &Connection, name: &str) -> Result<Tag, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("tag name must not be empty".into());
    }

    // Reuse existing (NOCASE unique).
    if let Some(existing) = conn
        .query_row(
            "SELECT id, name, created_at FROM tag WHERE name = ?1 COLLATE NOCASE",
            params![trimmed],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("create_tag lookup: {e}"))?
    {
        let (id, name, created_at) = existing;
        return map_tag_row(conn, id, name, created_at);
    }

    conn.execute(
        "INSERT INTO tag (name, created_at) VALUES (?1, datetime('now'))",
        params![trimmed],
    )
    .map_err(|e| format!("create_tag insert: {e}"))?;
    let id = conn.last_insert_rowid();
    let created_at: String = conn
        .query_row(
            "SELECT created_at FROM tag WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| format!("create_tag created_at: {e}"))?;
    map_tag_row(conn, id, trimmed.to_string(), created_at)
}

/// Delete tag; media_tag + tag_asset cascade via FK.
pub fn delete_tag(conn: &Connection, tag_id: i64) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM tag WHERE id = ?1", params![tag_id])
        .map_err(|e| format!("delete_tag: {e}"))?;
    if n == 0 {
        return Err(format!("tag {tag_id} not found"));
    }
    Ok(())
}

pub fn add_media_tag(conn: &Connection, media_item_id: i64, tag_id: i64) -> Result<Tag, String> {
    // Ensure both exist.
    let tag_row = conn
        .query_row(
            "SELECT id, name, created_at FROM tag WHERE id = ?1",
            params![tag_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("add_media_tag tag: {e}"))?
        .ok_or_else(|| format!("tag {tag_id} not found"))?;

    let media_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM media_item WHERE id = ?1",
            params![media_item_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("add_media_tag media: {e}"))?;
    if media_exists == 0 {
        return Err(format!("media item {media_item_id} not found"));
    }

    conn.execute(
        "INSERT OR IGNORE INTO media_tag (media_item_id, tag_id) VALUES (?1, ?2)",
        params![media_item_id, tag_id],
    )
    .map_err(|e| format!("add_media_tag: {e}"))?;

    map_tag_row(conn, tag_row.0, tag_row.1, tag_row.2)
}

pub fn remove_media_tag(conn: &Connection, media_item_id: i64, tag_id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM media_tag WHERE media_item_id = ?1 AND tag_id = ?2",
        params![media_item_id, tag_id],
    )
    .map_err(|e| format!("remove_media_tag: {e}"))?;
    Ok(())
}

pub fn add_tag_asset(
    conn: &Connection,
    tag_id: i64,
    asset_type: &str,
    path: &str,
) -> Result<TagAsset, String> {
    let at = asset_type.to_ascii_lowercase();
    if at != "image" && at != "sound" {
        return Err(format!("invalid asset_type: {asset_type} (expected image|sound)"));
    }
    let path = path.trim();
    if path.is_empty() {
        return Err("asset path must not be empty".into());
    }

    let tag_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tag WHERE id = ?1",
            params![tag_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("add_tag_asset tag: {e}"))?;
    if tag_exists == 0 {
        return Err(format!("tag {tag_id} not found"));
    }

    // Next sort_order within this tag + type.
    let next_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag_asset
             WHERE tag_id = ?1 AND asset_type = ?2",
            params![tag_id, at],
            |r| r.get(0),
        )
        .map_err(|e| format!("add_tag_asset sort: {e}"))?;

    conn.execute(
        "INSERT INTO tag_asset (tag_id, asset_type, path, sort_order)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(tag_id, asset_type, path) DO UPDATE SET sort_order = excluded.sort_order",
        params![tag_id, at, path, next_order],
    )
    .map_err(|e| format!("add_tag_asset insert: {e}"))?;

    // Resolve id (insert or existing).
    let asset = conn
        .query_row(
            "SELECT id, tag_id, asset_type, path, sort_order FROM tag_asset
             WHERE tag_id = ?1 AND asset_type = ?2 AND path = ?3",
            params![tag_id, at, path],
            |r| {
                Ok(TagAsset {
                    id: r.get(0)?,
                    tag_id: r.get(1)?,
                    asset_type: r.get(2)?,
                    path: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            },
        )
        .map_err(|e| format!("add_tag_asset fetch: {e}"))?;
    Ok(asset)
}

pub fn remove_tag_asset(conn: &Connection, asset_id: i64) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM tag_asset WHERE id = ?1", params![asset_id])
        .map_err(|e| format!("remove_tag_asset: {e}"))?;
    if n == 0 {
        return Err(format!("tag_asset {asset_id} not found"));
    }
    Ok(())
}

// --- Media queries ----------------------------------------------------------

pub fn get_media(conn: &Connection, id: i64) -> Result<Option<MediaItem>, String> {
    let mut item = conn
        .query_row(
            &format!("{MEDIA_SELECT} WHERE id = ?1"),
            params![id],
            map_media_row,
        )
        .optional()
        .map_err(|e| format!("get_media: {e}"))?;
    if let Some(ref mut m) = item {
        m.tags = tags_for_media(conn, m.id)?;
    }
    Ok(item)
}

fn attach_tags(conn: &Connection, mut item: MediaItem) -> Result<MediaItem, String> {
    item.tags = tags_for_media(conn, item.id)?;
    Ok(item)
}

fn attach_tags_opt(
    conn: &Connection,
    item: Option<MediaItem>,
) -> Result<Option<MediaItem>, String> {
    match item {
        Some(m) => Ok(Some(attach_tags(conn, m)?)),
        None => Ok(None),
    }
}

pub fn get_first_media(conn: &Connection, root_id: i64) -> Result<Option<MediaItem>, String> {
    let item = conn
        .query_row(
            &format!(
                "{MEDIA_SELECT}
                 WHERE root_dir_id = ?1 AND is_missing = 0
                 ORDER BY rel_path COLLATE NOCASE ASC
                 LIMIT 1"
            ),
            params![root_id],
            map_media_row,
        )
        .optional()
        .map_err(|e| format!("get_first_media: {e}"))?;
    attach_tags_opt(conn, item)
}

/// Alpha neighbor by rel_path COLLATE NOCASE. direction: "next" | "prev". Wraps.
/// When `parent_dir` is set, only items in that folder participate (sequential current-folder).
pub fn get_neighbor(
    conn: &Connection,
    id: i64,
    direction: &str,
    parent_dir: Option<&str>,
) -> Result<Option<MediaItem>, String> {
    let current = match get_media(conn, id)? {
        Some(m) if !m.is_missing => m,
        Some(m) => {
            // Missing current: still navigate within its root
            m
        }
        None => return Ok(None),
    };
    let root_id = current.root_dir_id;
    let rel = &current.rel_path;

    // Scope to explicit parent_dir when provided; otherwise whole root.
    let scope = parent_dir;

    let dir = direction.to_ascii_lowercase();
    let neighbor = match dir.as_str() {
        "next" | "forward" | "right" => {
            let next = match scope {
                Some(pd) => conn
                    .query_row(
                        &format!(
                            "{MEDIA_SELECT}
                             WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
                               AND rel_path COLLATE NOCASE > ?3
                             ORDER BY rel_path COLLATE NOCASE ASC
                             LIMIT 1"
                        ),
                        params![root_id, pd, rel],
                        map_media_row,
                    )
                    .optional()
                    .map_err(|e| format!("neighbor next dir: {e}"))?,
                None => conn
                    .query_row(
                        &format!(
                            "{MEDIA_SELECT}
                             WHERE root_dir_id = ?1 AND is_missing = 0
                               AND rel_path COLLATE NOCASE > ?2
                             ORDER BY rel_path COLLATE NOCASE ASC
                             LIMIT 1"
                        ),
                        params![root_id, rel],
                        map_media_row,
                    )
                    .optional()
                    .map_err(|e| format!("neighbor next: {e}"))?,
            };
            match next {
                Some(m) => Some(m),
                // wrap — row only; tags attached below once
                None => match scope {
                    Some(pd) => conn
                        .query_row(
                            &format!(
                                "{MEDIA_SELECT}
                                 WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
                                 ORDER BY rel_path COLLATE NOCASE ASC
                                 LIMIT 1"
                            ),
                            params![root_id, pd],
                            map_media_row,
                        )
                        .optional()
                        .map_err(|e| format!("neighbor first wrap dir: {e}"))?,
                    None => conn
                        .query_row(
                            &format!(
                                "{MEDIA_SELECT}
                                 WHERE root_dir_id = ?1 AND is_missing = 0
                                 ORDER BY rel_path COLLATE NOCASE ASC
                                 LIMIT 1"
                            ),
                            params![root_id],
                            map_media_row,
                        )
                        .optional()
                        .map_err(|e| format!("neighbor first wrap: {e}"))?,
                },
            }
        }
        "prev" | "previous" | "back" | "left" => {
            let prev = match scope {
                Some(pd) => conn
                    .query_row(
                        &format!(
                            "{MEDIA_SELECT}
                             WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
                               AND rel_path COLLATE NOCASE < ?3
                             ORDER BY rel_path COLLATE NOCASE DESC
                             LIMIT 1"
                        ),
                        params![root_id, pd, rel],
                        map_media_row,
                    )
                    .optional()
                    .map_err(|e| format!("neighbor prev dir: {e}"))?,
                None => conn
                    .query_row(
                        &format!(
                            "{MEDIA_SELECT}
                             WHERE root_dir_id = ?1 AND is_missing = 0
                               AND rel_path COLLATE NOCASE < ?2
                             ORDER BY rel_path COLLATE NOCASE DESC
                             LIMIT 1"
                        ),
                        params![root_id, rel],
                        map_media_row,
                    )
                    .optional()
                    .map_err(|e| format!("neighbor prev: {e}"))?,
            };
            match prev {
                Some(m) => Some(m),
                None => match scope {
                    // wrap to last
                    Some(pd) => conn
                        .query_row(
                            &format!(
                                "{MEDIA_SELECT}
                                 WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
                                 ORDER BY rel_path COLLATE NOCASE DESC
                                 LIMIT 1"
                            ),
                            params![root_id, pd],
                            map_media_row,
                        )
                        .optional()
                        .map_err(|e| format!("neighbor last dir: {e}"))?,
                    None => conn
                        .query_row(
                            &format!(
                                "{MEDIA_SELECT}
                                 WHERE root_dir_id = ?1 AND is_missing = 0
                                 ORDER BY rel_path COLLATE NOCASE DESC
                                 LIMIT 1"
                            ),
                            params![root_id],
                            map_media_row,
                        )
                        .optional()
                        .map_err(|e| format!("neighbor last: {e}"))?,
                },
            }
        }
        other => return Err(format!("unknown direction: {other}")),
    };

    attach_tags_opt(conn, neighbor)
}

/// Uniform random among non-missing items in root; optional parent_dir filter.
/// When `exclude_id` is set, prefer a different item (falls back to the only item if pool size is 1).
pub fn get_random(
    conn: &Connection,
    root_id: i64,
    parent_dir: Option<&str>,
    exclude_id: Option<i64>,
) -> Result<Option<MediaItem>, String> {
    // Try excluding current first when possible.
    if let Some(ex) = exclude_id {
        let excluded = match parent_dir {
            Some(pd) => conn
                .query_row(
                    &format!(
                        "{MEDIA_SELECT}
                         WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
                           AND id != ?3
                         ORDER BY RANDOM()
                         LIMIT 1"
                    ),
                    params![root_id, pd, ex],
                    map_media_row,
                )
                .optional()
                .map_err(|e| format!("get_random dir exclude: {e}"))?,
            None => conn
                .query_row(
                    &format!(
                        "{MEDIA_SELECT}
                         WHERE root_dir_id = ?1 AND is_missing = 0 AND id != ?2
                         ORDER BY RANDOM()
                         LIMIT 1"
                    ),
                    params![root_id, ex],
                    map_media_row,
                )
                .optional()
                .map_err(|e| format!("get_random exclude: {e}"))?,
        };
        if excluded.is_some() {
            return attach_tags_opt(conn, excluded);
        }
        // Only one item (or empty) — fall through without exclude.
    }

    let item = match parent_dir {
        Some(pd) => conn
            .query_row(
                &format!(
                    "{MEDIA_SELECT}
                     WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
                     ORDER BY RANDOM()
                     LIMIT 1"
                ),
                params![root_id, pd],
                map_media_row,
            )
            .optional()
            .map_err(|e| format!("get_random dir: {e}"))?,
        None => conn
            .query_row(
                &format!(
                    "{MEDIA_SELECT}
                     WHERE root_dir_id = ?1 AND is_missing = 0
                     ORDER BY RANDOM()
                     LIMIT 1"
                ),
                params![root_id],
                map_media_row,
            )
            .optional()
            .map_err(|e| format!("get_random: {e}"))?,
    };
    attach_tags_opt(conn, item)
}

/// Distinct parent directories under a root that contain at least one non-missing media item.
/// Sorted case-insensitively by absolute parent_dir path.
pub fn list_parent_dirs(conn: &Connection, root_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT parent_dir FROM media_item
             WHERE root_dir_id = ?1 AND is_missing = 0
             ORDER BY parent_dir COLLATE NOCASE ASC",
        )
        .map_err(|e| format!("prepare list_parent_dirs: {e}"))?;
    let rows = stmt
        .query_map(params![root_id], |r| r.get::<_, String>(0))
        .map_err(|e| format!("query list_parent_dirs: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("list_parent_dirs row: {e}"))?);
    }
    Ok(out)
}

/// Non-missing media items in a single parent directory, alpha by filename (then rel_path).
/// Tags are not loaded (list UI only).
pub fn list_media_in_dir(
    conn: &Connection,
    root_id: i64,
    parent_dir: &str,
) -> Result<Vec<MediaItem>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{MEDIA_SELECT}
             WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
             ORDER BY filename COLLATE NOCASE ASC, rel_path COLLATE NOCASE ASC"
        ))
        .map_err(|e| format!("prepare list_media_in_dir: {e}"))?;
    let rows = stmt
        .query_map(params![root_id, parent_dir], map_media_row)
        .map_err(|e| format!("query list_media_in_dir: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("list_media_in_dir row: {e}"))?);
    }
    Ok(out)
}

/// First non-missing item in a parent directory (alpha by filename).
pub fn get_first_media_in_dir(
    conn: &Connection,
    root_id: i64,
    parent_dir: &str,
) -> Result<Option<MediaItem>, String> {
    let item = conn
        .query_row(
            &format!(
                "{MEDIA_SELECT}
                 WHERE root_dir_id = ?1 AND is_missing = 0 AND parent_dir = ?2
                 ORDER BY filename COLLATE NOCASE ASC, rel_path COLLATE NOCASE ASC
                 LIMIT 1"
            ),
            params![root_id, parent_dir],
            map_media_row,
        )
        .optional()
        .map_err(|e| format!("get_first_media_in_dir: {e}"))?;
    attach_tags_opt(conn, item)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().expect("mem db");
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))",
            [],
        )
        .unwrap();
        conn
    }

    fn seed_root(conn: &Connection, path: &str) -> i64 {
        conn.execute(
            "INSERT INTO root_dir (path, created_at, last_scanned) VALUES (?1, datetime('now'), datetime('now'))",
            params![path],
        )
        .unwrap();
        conn.query_row("SELECT id FROM root_dir WHERE path = ?1", params![path], |r| r.get(0))
            .unwrap()
    }

    fn seed_media(
        conn: &Connection,
        root_id: i64,
        path: &str,
        rel_path: &str,
        parent_dir: &str,
    ) -> i64 {
        let filename = rel_path.rsplit(['/', '\\']).next().unwrap_or(rel_path);
        conn.execute(
            "INSERT INTO media_item (
                root_dir_id, path, filename, parent_dir, rel_path,
                media_type, ext, size_bytes, mtime_ms, is_missing,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'image', 'jpg', 1, 0, 0, datetime('now'), datetime('now'))",
            params![root_id, path, filename, parent_dir, rel_path],
        )
        .unwrap();
        conn.query_row(
            "SELECT id FROM media_item WHERE path = ?1",
            params![path],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn neighbor_empty_root_returns_none() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\empty");
        // No media; invent an id that does not exist
        assert!(get_neighbor(&conn, 999, "next", None).unwrap().is_none());
        assert!(get_first_media(&conn, root).unwrap().is_none());
    }

    #[test]
    fn neighbor_single_item_wraps_to_self() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\one");
        let id = seed_media(&conn, root, r"C:\one\a.jpg", "a.jpg", r"C:\one");
        let next = get_neighbor(&conn, id, "next", None)
            .unwrap()
            .expect("next");
        let prev = get_neighbor(&conn, id, "prev", None)
            .unwrap()
            .expect("prev");
        assert_eq!(next.id, id);
        assert_eq!(prev.id, id);
    }

    #[test]
    fn neighbor_three_items_wrap_ends() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\three");
        let a = seed_media(&conn, root, r"C:\three\a.jpg", "a.jpg", r"C:\three");
        let b = seed_media(&conn, root, r"C:\three\b.jpg", "b.jpg", r"C:\three");
        let c = seed_media(&conn, root, r"C:\three\c.jpg", "c.jpg", r"C:\three");

        assert_eq!(
            get_neighbor(&conn, a, "next", None).unwrap().unwrap().id,
            b
        );
        assert_eq!(
            get_neighbor(&conn, b, "next", None).unwrap().unwrap().id,
            c
        );
        assert_eq!(
            get_neighbor(&conn, c, "next", None).unwrap().unwrap().id,
            a
        ); // wrap

        assert_eq!(
            get_neighbor(&conn, a, "prev", None).unwrap().unwrap().id,
            c
        ); // wrap
        assert_eq!(
            get_neighbor(&conn, b, "prev", None).unwrap().unwrap().id,
            a
        );
        assert_eq!(
            get_neighbor(&conn, c, "prev", None).unwrap().unwrap().id,
            b
        );
    }

    #[test]
    fn neighbor_parent_dir_constrained() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\lib");
        let a1 = seed_media(
            &conn,
            root,
            r"C:\lib\a\1.jpg",
            r"a\1.jpg",
            r"C:\lib\a",
        );
        let a2 = seed_media(
            &conn,
            root,
            r"C:\lib\a\2.jpg",
            r"a\2.jpg",
            r"C:\lib\a",
        );
        let _b = seed_media(
            &conn,
            root,
            r"C:\lib\b\3.jpg",
            r"b\3.jpg",
            r"C:\lib\b",
        );

        // Scoped next/prev stays in folder a (wraps within a).
        assert_eq!(
            get_neighbor(&conn, a1, "next", Some(r"C:\lib\a"))
                .unwrap()
                .unwrap()
                .id,
            a2
        );
        assert_eq!(
            get_neighbor(&conn, a2, "next", Some(r"C:\lib\a"))
                .unwrap()
                .unwrap()
                .id,
            a1
        );
        assert_eq!(
            get_neighbor(&conn, a1, "prev", Some(r"C:\lib\a"))
                .unwrap()
                .unwrap()
                .id,
            a2
        );
    }

    #[test]
    fn list_parent_dirs_and_media_in_dir() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\lib");
        let _ = seed_media(&conn, root, r"C:\lib\a\one.jpg", r"a\one.jpg", r"C:\lib\a");
        let _ = seed_media(&conn, root, r"C:\lib\b\two.jpg", r"b\two.jpg", r"C:\lib\b");
        let _ = seed_media(&conn, root, r"C:\lib\a\three.jpg", r"a\three.jpg", r"C:\lib\a");

        let dirs = list_parent_dirs(&conn, root).unwrap();
        assert_eq!(dirs, vec![r"C:\lib\a".to_string(), r"C:\lib\b".to_string()]);

        let in_a = list_media_in_dir(&conn, root, r"C:\lib\a").unwrap();
        assert_eq!(in_a.len(), 2);
        assert_eq!(in_a[0].filename, "one.jpg");
        assert_eq!(in_a[1].filename, "three.jpg");

        let first = get_first_media_in_dir(&conn, root, r"C:\lib\b")
            .unwrap()
            .expect("first in b");
        assert_eq!(first.filename, "two.jpg");
    }

    #[test]
    fn get_random_parent_dir_constrained() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\lib");
        let _ = seed_media(&conn, root, r"C:\lib\x\1.jpg", r"x\1.jpg", r"C:\lib\x");
        let _ = seed_media(&conn, root, r"C:\lib\x\2.jpg", r"x\2.jpg", r"C:\lib\x");
        let y = seed_media(&conn, root, r"C:\lib\y\3.jpg", r"y\3.jpg", r"C:\lib\y");

        // Only one item in y — random must return it.
        for _ in 0..8 {
            let item = get_random(&conn, root, Some(r"C:\lib\y"), None)
                .unwrap()
                .expect("random y");
            assert_eq!(item.id, y);
            assert_eq!(item.parent_dir, r"C:\lib\y");
        }

        // Empty dir filter → None
        assert!(get_random(&conn, root, Some(r"C:\lib\z"), None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn get_random_avoids_immediate_repeat_when_possible() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\rnd");
        let a = seed_media(&conn, root, r"C:\rnd\a.jpg", "a.jpg", r"C:\rnd");
        let b = seed_media(&conn, root, r"C:\rnd\b.jpg", "b.jpg", r"C:\rnd");

        for _ in 0..12 {
            let item = get_random(&conn, root, None, Some(a))
                .unwrap()
                .expect("random");
            assert_eq!(item.id, b, "should exclude a when another exists");
        }

        // Single item: exclude falls back to that item
        let root2 = seed_root(&conn, r"C:\onlyroot");
        let only = seed_media(&conn, root2, r"C:\onlyroot\o.jpg", "o.jpg", r"C:\onlyroot");
        let item = get_random(&conn, root2, None, Some(only))
            .unwrap()
            .expect("single");
        assert_eq!(item.id, only);
    }

    #[test]
    fn tags_create_attach_assets_and_cascade_delete() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\tags");
        let media_id = seed_media(&conn, root, r"C:\tags\a.jpg", "a.jpg", r"C:\tags");

        let tag = create_tag(&conn, "  Favorite  ").unwrap();
        assert_eq!(tag.name, "Favorite");
        // Case-insensitive reuse
        let again = create_tag(&conn, "favorite").unwrap();
        assert_eq!(again.id, tag.id);

        add_media_tag(&conn, media_id, tag.id).unwrap();
        let asset = add_tag_asset(&conn, tag.id, "image", r"C:\badges\f.png").unwrap();
        assert_eq!(asset.asset_type, "image");
        let _sound = add_tag_asset(&conn, tag.id, "sound", r"C:\sfx\ding.mp3").unwrap();

        let item = get_media(&conn, media_id).unwrap().expect("media");
        assert_eq!(item.tags.len(), 1);
        assert_eq!(item.tags[0].assets.len(), 2);

        delete_tag(&conn, tag.id).unwrap();
        let item2 = get_media(&conn, media_id).unwrap().expect("media");
        assert!(item2.tags.is_empty());
        let tags = list_tags(&conn).unwrap();
        assert!(tags.is_empty());
    }
}

