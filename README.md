# Media Browser

Local-only Windows media viewer. Points at a folder, scans into SQLite once, then browses images and videos with tags, slideshow, and minimal fullscreen chrome.

**Stack:** Tauri 2 · TypeScript (vanilla + Vite) · SQLite (rusqlite)

## Prerequisites (Windows 11)

| Tool | Notes |
|------|--------|
| **Node.js** | 18+ recommended (npm included) |
| **Rust** | Stable toolchain via [rustup](https://rustup.rs/) |
| **WebView2** | Preinstalled on Windows 11; [Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) on older Windows |
| **MSVC build tools** | Visual Studio Build Tools with “Desktop development with C++” (required by Rust on Windows) |

Ensure Rust is on your PATH (`%USERPROFILE%\.cargo\bin`).

## Install

```bash
npm install
```

First `npm run tauri dev` / `cargo build` will compile Rust dependencies (including bundled SQLite); this can take a few minutes.

## Development

```bash
npm run tauri dev
```

This starts the Vite dev server and the Tauri shell. Hot-reload applies to the frontend; Rust changes recompile the backend.

### Useful keys (scaffold)

| Key | Action |
|-----|--------|
| **F11** | Toggle fullscreen |
| **Esc** | Exit fullscreen |
| **Ctrl+Q** | Quit |

The window opens maximized on a black letterbox stage. On launch, SQLite opens under the app data directory and runs schema migrations.

## Build

```bash
npm run tauri build
```

Artifacts are written under `src-tauri/target/release/` (and installers under `src-tauri/target/release/bundle/` when bundling is enabled).

Frontend-only typecheck / build:

```bash
npx tsc --noEmit
npm run build
```

Rust-only check (faster than a full bundle):

```bash
cd src-tauri
cargo check
```

## Data location

SQLite library database:

```
%APPDATA%\com.mediabrowser.app\library.db
```

(Exact folder name follows Tauri’s `app_data_dir` for identifier `com.mediabrowser.app`.)

Schema (v1): `root_dir`, `root_usage`, `media_item`, `tag`, `media_tag`, `tag_asset`, `setting` — see `PLAN.md` §5.1.

## Project layout

```
media_browser/
  src-tauri/          # Rust backend (Tauri + SQLite)
    src/
      main.rs
      lib.rs
      db.rs           # open DB + migrations
    Cargo.toml
    tauri.conf.json
  src/                # Frontend (Vite + vanilla TS)
    main.ts
    styles.css
    app/
      api.ts
      state.ts
      ui/             # stubs for later PRs
  package.json
  vite.config.ts
  tsconfig.json
  README.md
  PLAN.md
```

## Status

**PR 1 — Scaffold:** black shell, fullscreen/quit keys, SQLite open + schema migrations.

Later phases: scan, navigation, slideshow, tags, Open with… / VLC. See `PLAN.md`.

## License

Private / local use unless otherwise noted.
