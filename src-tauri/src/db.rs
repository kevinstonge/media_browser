//! SQLite open + v1 schema migration runner + media/root query helpers.
//! DB path: app data dir / library.db (e.g. %APPDATA%/com.mediabrowser.app/library.db
//! or identifier-based path via Tauri path API).

use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

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
    })
}

const MEDIA_SELECT: &str = "SELECT id, root_dir_id, path, filename, parent_dir, rel_path,
        media_type, ext, size_bytes, mtime_ms, is_missing
     FROM media_item";

// --- Open / migrate ---------------------------------------------------------

fn app_data_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app_data_dir: {e}"))?;
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

/// Open library.db under the app data directory and apply schema migrations.
pub fn open_and_migrate(app: &AppHandle) -> Result<Connection, String> {
    let path = app_data_db_path(app)?;
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

// --- Media queries ----------------------------------------------------------

pub fn get_media(conn: &Connection, id: i64) -> Result<Option<MediaItem>, String> {
    conn.query_row(
        &format!("{MEDIA_SELECT} WHERE id = ?1"),
        params![id],
        map_media_row,
    )
    .optional()
    .map_err(|e| format!("get_media: {e}"))
}

pub fn get_first_media(conn: &Connection, root_id: i64) -> Result<Option<MediaItem>, String> {
    conn.query_row(
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
    .map_err(|e| format!("get_first_media: {e}"))
}

/// Alpha neighbor by rel_path COLLATE NOCASE. direction: "next" | "prev". Wraps.
pub fn get_neighbor(
    conn: &Connection,
    id: i64,
    direction: &str,
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

    let dir = direction.to_ascii_lowercase();
    let neighbor = match dir.as_str() {
        "next" | "forward" | "right" => {
            let next = conn
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
                .map_err(|e| format!("neighbor next: {e}"))?;
            match next {
                Some(m) => Some(m),
                None => get_first_media(conn, root_id)?, // wrap
            }
        }
        "prev" | "previous" | "back" | "left" => {
            let prev = conn
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
                .map_err(|e| format!("neighbor prev: {e}"))?;
            match prev {
                Some(m) => Some(m),
                None => {
                    // wrap to last
                    conn.query_row(
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
                    .map_err(|e| format!("neighbor last: {e}"))?
                }
            }
        }
        other => return Err(format!("unknown direction: {other}")),
    };

    Ok(neighbor)
}

/// Uniform random among non-missing items in root; optional parent_dir filter.
pub fn get_random(
    conn: &Connection,
    root_id: i64,
    parent_dir: Option<&str>,
) -> Result<Option<MediaItem>, String> {
    match parent_dir {
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
            .map_err(|e| format!("get_random dir: {e}")),
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
            .map_err(|e| format!("get_random: {e}")),
    }
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
        assert!(get_neighbor(&conn, 999, "next").unwrap().is_none());
        assert!(get_first_media(&conn, root).unwrap().is_none());
    }

    #[test]
    fn neighbor_single_item_wraps_to_self() {
        let conn = mem_db();
        let root = seed_root(&conn, r"C:\one");
        let id = seed_media(&conn, root, r"C:\one\a.jpg", "a.jpg", r"C:\one");
        let next = get_neighbor(&conn, id, "next").unwrap().expect("next");
        let prev = get_neighbor(&conn, id, "prev").unwrap().expect("prev");
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

        assert_eq!(get_neighbor(&conn, a, "next").unwrap().unwrap().id, b);
        assert_eq!(get_neighbor(&conn, b, "next").unwrap().unwrap().id, c);
        assert_eq!(get_neighbor(&conn, c, "next").unwrap().unwrap().id, a); // wrap

        assert_eq!(get_neighbor(&conn, a, "prev").unwrap().unwrap().id, c); // wrap
        assert_eq!(get_neighbor(&conn, b, "prev").unwrap().unwrap().id, a);
        assert_eq!(get_neighbor(&conn, c, "prev").unwrap().unwrap().id, b);
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
            let item = get_random(&conn, root, Some(r"C:\lib\y"))
                .unwrap()
                .expect("random y");
            assert_eq!(item.id, y);
            assert_eq!(item.parent_dir, r"C:\lib\y");
        }

        // Empty dir filter → None
        assert!(get_random(&conn, root, Some(r"C:\lib\z")).unwrap().is_none());
    }
}

