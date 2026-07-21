//! Shallow folder scan / re-scan into SQLite media_item rows.
//!
//! Layout assumed: `root / <subdir> / <files>` only.
//! - Files directly under the root are ignored.
//! - Nested folders inside a first-level subdir are not entered.
//! - Parallel listing of first-level subdirs; single prepared-statement DB write.

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Result summary returned to the frontend after a scan.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root_id: i64,
    pub root_path: String,
    pub scanned: u64,
    pub upserted: u64,
    pub missing_marked: u64,
}

/// Low-overhead progress payload (throttled emits, not per-file).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub files: u64,
}

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff",
];
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mkv", "mov", "avi", "wmv", "m4v", "ogv"];

/// Throttle progress events so the UI can update a few times per second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// One media file discovered under a first-level subdir.
struct ListedFile {
    path: String,
    filename: String,
    parent_dir: String,
    rel_path: String,
    media_type: &'static str,
    ext: String,
}

/// Classify a lowercase extension (no dot) as image | video, or None if non-media.
pub fn classify_ext(ext: &str) -> Option<&'static str> {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    if IMAGE_EXTS.iter().any(|x| *x == e) {
        Some("image")
    } else if VIDEO_EXTS.iter().any(|x| *x == e) {
        Some("video")
    } else {
        None
    }
}

/// Stable path string for DB storage / seen-set membership.
/// Absolute when possible; strip `\\?\` (dunce); Windows drive letter uppercased.
/// Does **not** call `canonicalize` (hot-path / bulk scan friendly).
pub fn normalize_path_str(path: &Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };

    let simplified = dunce::simplified(&abs);
    let mut s = simplified.to_string_lossy().into_owned();

    // Windows: stable drive-letter case so UNIQUE + seen-set stay consistent.
    #[cfg(windows)]
    {
        if s.len() >= 2 {
            let bytes = s.as_bytes();
            if bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
                let mut chars: Vec<char> = s.chars().collect();
                if let Some(c0) = chars.get_mut(0) {
                    *c0 = c0.to_ascii_uppercase();
                }
                s = chars.into_iter().collect();
            }
        }
    }

    s
}

/// Normalize root folder path for storage. Canonicalize once so the stored root is stable.
pub fn normalize_root(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    let abs = if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&p))
            .map_err(|e| format!("current_dir: {e}"))?
    };
    // One-time resolve for the library root only (not per media file).
    let resolved = abs.canonicalize().unwrap_or(abs);
    let s = normalize_path_str(&resolved);
    Ok(PathBuf::from(s))
}

fn emit_progress(app: &AppHandle, files: u64) {
    let _ = app.emit("scan-progress", ScanProgress { files });
}

/// List first-level subdirectories of `root` (names only; no nested walk).
fn list_first_level_subdirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut dirs = Vec::new();
    let rd = fs::read_dir(root).map_err(|e| format!("read_dir root: {e}"))?;
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => return Err(format!("read_dir root entry: {err}")),
        };
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(err) => return Err(format!("file_type {}: {err}", entry.path().display())),
        };
        if ft.is_dir() {
            dirs.push(entry.path());
        }
        // Files (and anything else) directly under root are intentionally ignored.
    }
    Ok(dirs)
}

/// List media files **directly** inside one first-level subdir (no recursion).
fn list_media_in_subdir(root_str: &str, subdir: &Path) -> Result<Vec<ListedFile>, String> {
    let subdir_name = subdir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if subdir_name.is_empty() {
        return Ok(Vec::new());
    }

    // Build stable parent path from already-normalized root + name (no canonicalize).
    let parent_dir = normalize_path_str(&Path::new(root_str).join(&subdir_name));

    let mut out = Vec::new();
    let rd = fs::read_dir(subdir).map_err(|e| format!("read_dir {}: {e}", subdir.display()))?;
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                return Err(format!("read_dir entry in {}: {err}", subdir.display()));
            }
        };
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // Skip nested directories (and non-files). No deeper walk.
        if !ft.is_file() {
            continue;
        }

        let path = entry.path();
        let filename = entry.file_name().to_string_lossy().into_owned();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let media_type = match classify_ext(&ext) {
            Some(t) => t,
            None => continue,
        };

        let abs = normalize_path_str(&Path::new(&parent_dir).join(&filename));
        // rel_path uses the same separator style as the platform path display.
        let rel_path = {
            let joined = Path::new(&subdir_name).join(&filename);
            joined.to_string_lossy().into_owned()
        };

        out.push(ListedFile {
            path: abs,
            filename,
            parent_dir: parent_dir.clone(),
            rel_path,
            media_type,
            ext,
        });
    }
    Ok(out)
}

/// Parallel shallow listing of all first-level subdirs.
fn collect_media_files(root: &Path, root_str: &str) -> Result<Vec<ListedFile>, String> {
    let subdirs = list_first_level_subdirs(root)?;

    let results: Vec<Result<Vec<ListedFile>, String>> = subdirs
        .par_iter()
        .map(|subdir| list_media_in_subdir(root_str, subdir))
        .collect();

    let mut files = Vec::new();
    for r in results {
        files.extend(r?);
    }
    Ok(files)
}

/// Upsert root_dir, record usage, shallow-walk filesystem, upsert media, soft-flag missing.
///
/// Entire scan (root metadata + media + missing flags + active_root_id) runs in one
/// transaction after the parallel filesystem listing completes.
pub fn scan_root(app: &AppHandle, conn: &Connection, root_path: &str) -> Result<ScanResult, String> {
    let root = normalize_root(root_path)?;
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let root_str = normalize_path_str(&root);

    // --- Phase 1: parallel filesystem listing (no DB yet) ---
    // Progress stays at 0 during listing (usually fast); count rises only while indexing so
    // the UI number never jumps backwards.
    emit_progress(app, 0);
    let files = collect_media_files(&root, &root_str)?;
    let scanned = files.len() as u64;

    let ts: String = conn
        .query_row("SELECT datetime('now')", [], |r| r.get(0))
        .map_err(|e| format!("datetime: {e}"))?;

    // Single transaction for all side effects (root, usage, active, media, missing, last_scanned).
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin tx: {e}"))?;

    // 1. Upsert root_dir
    tx.execute(
        "INSERT INTO root_dir (path, created_at, last_scanned)
         VALUES (?1, ?2, NULL)
         ON CONFLICT(path) DO NOTHING",
        params![root_str, ts],
    )
    .map_err(|e| format!("upsert root_dir: {e}"))?;

    let root_id: i64 = tx
        .query_row(
            "SELECT id FROM root_dir WHERE path = ?1",
            params![root_str],
            |r| r.get(0),
        )
        .map_err(|e| format!("select root_id: {e}"))?;

    // 2. root_usage
    tx.execute(
        "INSERT INTO root_usage (root_dir_id, used_at) VALUES (?1, ?2)",
        params![root_id, ts],
    )
    .map_err(|e| format!("insert root_usage: {e}"))?;

    // 3. active_root_id (only committed with a successful full scan)
    let active_json = serde_json::to_string(&root_id).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO setting (key, value) VALUES ('active_root_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![active_json],
    )
    .map_err(|e| format!("set active_root_id: {e}"))?;

    // 4. Upsert media (prepared once; size/mtime left NULL — unused by features)
    let mut seen: HashSet<String> = HashSet::with_capacity(files.len());
    let mut upserted: u64 = 0;
    let mut last_emit = Instant::now();

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO media_item (
                    root_dir_id, path, filename, parent_dir, rel_path,
                    media_type, ext, size_bytes, mtime_ms, is_missing,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, 0, ?8, ?8)
                 ON CONFLICT(path) DO UPDATE SET
                    root_dir_id = excluded.root_dir_id,
                    filename = excluded.filename,
                    parent_dir = excluded.parent_dir,
                    rel_path = excluded.rel_path,
                    media_type = excluded.media_type,
                    ext = excluded.ext,
                    size_bytes = NULL,
                    mtime_ms = NULL,
                    is_missing = 0,
                    updated_at = excluded.updated_at",
            )
            .map_err(|e| format!("prepare upsert: {e}"))?;

        for f in &files {
            seen.insert(f.path.clone());
            stmt.execute(params![
                root_id,
                f.path,
                f.filename,
                f.parent_dir,
                f.rel_path,
                f.media_type,
                f.ext,
                ts,
            ])
            .map_err(|e| format!("upsert media_item: {e}"))?;
            upserted += 1;

            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                emit_progress(app, upserted);
                last_emit = Instant::now();
            }
        }
    }

    emit_progress(app, upserted);

    // Soft-missing: paths under this root not seen this scan (tags preserved).
    let mut missing_marked: u64 = 0;
    {
        let mut stmt = tx
            .prepare(
                "SELECT id, path FROM media_item WHERE root_dir_id = ?1 AND is_missing = 0",
            )
            .map_err(|e| format!("prepare missing: {e}"))?;
        let rows = stmt
            .query_map(params![root_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("query missing: {e}"))?;

        let mut to_mark: Vec<i64> = Vec::new();
        for row in rows {
            let (id, path) = row.map_err(|e| format!("row missing: {e}"))?;
            if !seen.contains(&path) {
                to_mark.push(id);
            }
        }
        drop(stmt);

        for id in to_mark {
            tx.execute(
                "UPDATE media_item SET is_missing = 1, updated_at = ?2 WHERE id = ?1",
                params![id, ts],
            )
            .map_err(|e| format!("mark missing: {e}"))?;
            missing_marked += 1;
        }
    }

    tx.execute(
        "UPDATE root_dir SET last_scanned = ?2 WHERE id = ?1",
        params![root_id, ts],
    )
    .map_err(|e| format!("update last_scanned: {e}"))?;

    tx.commit().map_err(|e| format!("commit: {e}"))?;

    Ok(ScanResult {
        root_id,
        root_path: root_str,
        scanned,
        upserted,
        missing_marked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_images_and_videos() {
        assert_eq!(classify_ext("jpg"), Some("image"));
        assert_eq!(classify_ext(".PNG"), Some("image"));
        assert_eq!(classify_ext("mp4"), Some("video"));
        assert_eq!(classify_ext("txt"), None);
        assert_eq!(classify_ext("exe"), None);
    }

    #[test]
    fn normalize_strips_empty_and_uppercases_drive_on_windows() {
        #[cfg(windows)]
        {
            let p = PathBuf::from(r"c:\Some\Path");
            let s = normalize_path_str(&p);
            assert!(
                s.starts_with(r"C:\") || s.starts_with("C:/"),
                "expected upper drive letter, got {s}"
            );
        }
    }

    #[test]
    fn normalize_does_not_require_path_to_exist() {
        let p = PathBuf::from(r"C:\this\path\should\not\need\to\exist\file.jpg");
        let s = normalize_path_str(&p);
        assert!(s.to_ascii_lowercase().contains("file.jpg"));
    }
}
