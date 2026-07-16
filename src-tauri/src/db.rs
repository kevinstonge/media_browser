//! SQLite open + v1 schema migration runner.
//! DB path: app data dir / library.db (e.g. %APPDATA%/com.mediabrowser.app/library.db
//! or identifier-based path via Tauri path API).

use rusqlite::{Connection, Result as SqlResult};
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
    // Connection-level; not transactional.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // Skip DDL entirely once v1 has been recorded.
    if is_migration_applied(conn, 1)? {
        return Ok(());
    }

    // Atomic apply: all v1 objects + version stamp, or roll back on failure.
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
