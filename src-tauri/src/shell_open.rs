//! Open media with the system default app or VLC (Windows-first).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// CREATE_NO_WINDOW — hide console flashes for helper processes on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// True if the path exists on disk (file or directory).
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    let p = path.trim();
    !p.is_empty() && Path::new(p).exists()
}

/// Open a file (or folder) with the OS default association.
#[tauri::command]
pub fn open_with_default(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("empty path".into());
    }
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    open_path_default(p)
}

/// Open the parent directory of a media path (e.g. when the file is missing).
#[tauri::command]
pub fn open_parent_folder(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("empty path".into());
    }
    let p = Path::new(path);
    let parent = p
        .parent()
        .filter(|par| !par.as_os_str().is_empty())
        .ok_or_else(|| format!("no parent folder for: {path}"))?;
    if !parent.exists() {
        return Err(format!("parent folder does not exist: {}", parent.display()));
    }
    open_path_default(parent)
}

/// Launch VLC with the given media path. Tries PATH, then common install dirs, then registry.
#[tauri::command]
pub fn open_with_vlc(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("empty path".into());
    }
    // VLC can open paths that no longer exist in rare cases; still require a non-empty path.
    let vlc = find_vlc().ok_or_else(|| {
        "VLC not found — install VLC or use Open with default.".to_string()
    })?;

    let mut cmd = Command::new(&vlc);
    cmd.arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_no_window(&mut cmd);

    let status = cmd
        .spawn()
        .map_err(|e| format!("failed to launch VLC ({}): {e}", vlc.display()))?;

    // Detach: we only care that spawn succeeded.
    drop(status);
    Ok(())
}

fn open_path_default(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // `cmd /C start "" <path>` — empty title arg is required so paths with
        // spaces / leading quotes are not mis-parsed as the window title.
        // CREATE_NO_WINDOW avoids a brief console flash from cmd.exe.
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg("start")
            .arg("")
            .arg(path.as_os_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        apply_no_window(&mut cmd);
        let status = cmd
            .spawn()
            .map_err(|e| format!("open with default failed: {e}"))?;
        drop(status);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        // Best-effort cross-platform fallback for dev machines.
        #[cfg(target_os = "macos")]
        let mut cmd = Command::new("open");
        #[cfg(not(target_os = "macos"))]
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path)
            .spawn()
            .map_err(|e| format!("open with default failed: {e}"))?;
        Ok(())
    }
}

/// Hide console windows for helper / detached GUI launches on Windows.
#[cfg(windows)]
fn apply_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window(_cmd: &mut Command) {}

fn find_vlc() -> Option<PathBuf> {
    // 1. `vlc` on PATH
    if let Some(p) = find_vlc_on_path() {
        return Some(p);
    }

    // 2–3. Standard install locations
    #[cfg(windows)]
    {
        if let Some(p) = program_files_vlc() {
            return Some(p);
        }
        // 4. Uninstall / install registry InstallDir
        if let Some(p) = vlc_from_registry() {
            return Some(p);
        }
    }

    None
}

fn find_vlc_on_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("where");
        cmd.arg("vlc")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        apply_no_window(&mut cmd);
        let output = cmd.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first = stdout.lines().next()?.trim();
        if first.is_empty() {
            return None;
        }
        let p = PathBuf::from(first);
        if p.is_file() {
            return Some(p);
        }
        None
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("which").arg("vlc").output().ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first = stdout.lines().next()?.trim();
        if first.is_empty() {
            return None;
        }
        let p = PathBuf::from(first);
        if p.is_file() || p.exists() {
            return Some(p);
        }
        None
    }
}

#[cfg(windows)]
fn program_files_vlc() -> Option<PathBuf> {
    let candidates = [
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
        // Fallbacks if env vars are missing
        Some(PathBuf::from(r"C:\Program Files")),
        Some(PathBuf::from(r"C:\Program Files (x86)")),
    ];
    for base in candidates.into_iter().flatten() {
        let exe = base.join("VideoLAN").join("VLC").join("vlc.exe");
        if exe.is_file() {
            return Some(exe);
        }
    }
    None
}

/// Read InstallDir from VideoLAN uninstall / app keys.
#[cfg(windows)]
fn vlc_from_registry() -> Option<PathBuf> {
    const KEYS: &[&str] = &[
        r"HKLM\SOFTWARE\VideoLAN\VLC",
        r"HKLM\SOFTWARE\WOW6432Node\VideoLAN\VLC",
        r"HKCU\SOFTWARE\VideoLAN\VLC",
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VLC media player",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\VLC media player",
    ];

    for key in KEYS {
        if let Some(dir) = reg_query_value(key, "InstallDir") {
            let exe = PathBuf::from(&dir).join("vlc.exe");
            if exe.is_file() {
                return Some(exe);
            }
            // Some keys store the full path already
            let as_file = PathBuf::from(&dir);
            if as_file.is_file() {
                return Some(as_file);
            }
        }
        // Uninstall entries often use DisplayIcon or InstallLocation
        if let Some(loc) = reg_query_value(key, "InstallLocation") {
            let exe = PathBuf::from(loc.trim_end_matches(['\\', '/'])).join("vlc.exe");
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

/// Minimal `reg query` helper — avoids a winreg dependency for one read.
#[cfg(windows)]
fn reg_query_value(key: &str, value_name: &str) -> Option<String> {
    let mut cmd = Command::new("reg");
    cmd.args(["query", key, "/v", value_name])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_no_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Lines look like: `    InstallDir    REG_SZ    C:\Program Files\VideoLAN\VLC`
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("HKEY_") {
            continue;
        }
        // Split on whitespace runs; value name, type, then rest is data.
        let mut parts = line.split_whitespace();
        let name = parts.next()?;
        if !name.eq_ignore_ascii_case(value_name) {
            continue;
        }
        let _reg_type = parts.next()?;
        let data: Vec<&str> = parts.collect();
        if data.is_empty() {
            return None;
        }
        return Some(data.join(" "));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_exists_empty_is_false() {
        assert!(!path_exists(String::new()));
        assert!(!path_exists("   ".into()));
    }

    #[test]
    fn path_exists_known_temp_or_cwd() {
        let cwd = std::env::current_dir().expect("cwd");
        assert!(path_exists(cwd.to_string_lossy().into_owned()));
    }
}
