//! Recursive folder scan / re-scan into SQLite media_item rows.

use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// Result summary returned to the frontend after a scan.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root_id: i64,
    pub root_path: String,
    pub scanned: u64,
    pub upserted: u64,
    pub missing_marked: u64,
}

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff",
];
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mkv", "mov", "avi", "wmv", "m4v", "ogv"];

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

/// Size + mtime from a single metadata() call.
fn file_stats(path: &Path) -> (Option<i64>, Option<i64>) {
    match path.metadata() {
        Ok(m) => {
            let size = Some(m.len() as i64);
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            (size, mtime)
        }
        Err(_) => (None, None),
    }
}

/// Stable path string for DB storage / seen-set membership.
/// Absolute → canonicalize when possible → strip `\\?\` (dunce) → Windows drive letter uppercased.
pub fn normalize_path_str(path: &Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };

    let resolved = abs.canonicalize().unwrap_or(abs);
    let simplified = dunce::simplified(&resolved);
    let mut s = simplified.to_string_lossy().into_owned();

    // Windows: stable drive-letter case so UNIQUE + seen-set stay consistent.
    #[cfg(windows)]
    {
        if s.len() >= 2 {
            let bytes = s.as_bytes();
            if bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
                // SAFETY: we only touch the first ASCII letter.
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

/// Normalize root folder path for storage.
pub fn normalize_root(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    let s = normalize_path_str(&p);
    Ok(PathBuf::from(s))
}

/// Upsert root_dir, record usage, walk filesystem, upsert media, soft-flag missing.
///
/// Entire scan (root metadata + media + missing flags + active_root_id) runs in one
/// transaction. Walk I/O errors abort before soft-missing so incomplete walks never
/// false-flag existing files.
pub fn scan_root(conn: &Connection, root_path: &str) -> Result<ScanResult, String> {
    let root = normalize_root(root_path)?;
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let root_str = normalize_path_str(&root);

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

    // 4. Walk + upsert
    let mut seen: HashSet<String> = HashSet::new();
    let mut scanned: u64 = 0;
    let mut upserted: u64 = 0;
    let mut walk_errors: Vec<String> = Vec::new();

    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                walk_errors.push(err.to_string());
                continue;
            }
        };

        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        scanned += 1;

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let media_type = match classify_ext(&ext) {
            Some(t) => t,
            None => continue,
        };

        // Same normalizer as root / DB so seen-set and UNIQUE path match across scans.
        let abs = normalize_path_str(path);
        let filename = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        let parent_dir = path
            .parent()
            .map(normalize_path_str)
            .unwrap_or_else(|| root_str.clone());
        let rel_path = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| filename.clone());
        let (size, mtime) = file_stats(path);

        seen.insert(abs.clone());

        tx.execute(
            "INSERT INTO media_item (
                root_dir_id, path, filename, parent_dir, rel_path,
                media_type, ext, size_bytes, mtime_ms, is_missing,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)
             ON CONFLICT(path) DO UPDATE SET
                root_dir_id = excluded.root_dir_id,
                filename = excluded.filename,
                parent_dir = excluded.parent_dir,
                rel_path = excluded.rel_path,
                media_type = excluded.media_type,
                ext = excluded.ext,
                size_bytes = excluded.size_bytes,
                mtime_ms = excluded.mtime_ms,
                is_missing = 0,
                updated_at = excluded.updated_at",
            params![
                root_id,
                abs,
                filename,
                parent_dir,
                rel_path,
                media_type,
                ext,
                size,
                mtime,
                ts
            ],
        )
        .map_err(|e| format!("upsert media_item: {e}"))?;
        upserted += 1;
    }

    // Fail closed: incomplete walk must not soft-flag unseen paths as missing.
    if !walk_errors.is_empty() {
        let first = &walk_errors[0];
        return Err(format!(
            "scan incomplete ({} walk error(s)); soft-missing skipped. First error: {first}",
            walk_errors.len()
        ));
    }

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
            // Non-existent path still becomes absolute-ish string with upper drive if present.
            let p = PathBuf::from(r"c:\Some\Path");
            let s = normalize_path_str(&p);
            assert!(
                s.starts_with(r"C:\") || s.starts_with("C:/"),
                "expected upper drive letter, got {s}"
            );
        }
    }
}
