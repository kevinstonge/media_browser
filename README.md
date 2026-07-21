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

SQLite library database (portable — same folder as the executable):

```
<folder-containing-the-exe>\library.db
```

In dev this is typically next to the debug binary under `src-tauri/target/debug/`. Copy or back up `library.db` alongside the `.exe` for portable use.

Schema (v1): `root_dir`, `root_usage`, `media_item`, `tag`, `media_tag`, `tag_asset`, `setting` — see `PLAN.md` §5.1.

## Project layout

```
media_browser/
  index.html          # Vite entry (must live at repo root)
  src-tauri/          # Rust backend (Tauri + SQLite)
    src/
      main.rs
      lib.rs
      db.rs           # open DB + migrations + media queries
      scan.rs         # recursive walk + upsert
      commands.rs     # Tauri IPC
    Cargo.toml
    tauri.conf.json
  src/                # Frontend (Vite + vanilla TS)
    main.ts
    styles.css
    app/
      api.ts
      state.ts
      ui/             # stage, settings (partial); later: tags/slideshow
  package.json
  vite.config.ts
  tsconfig.json
  README.md
  PLAN.md
```

## Status

**PR 1 — Scaffold:** black shell, fullscreen/quit keys, SQLite open + schema migrations.

**PR 2 — Scan + DB browse skeleton:** folder picker, recursive scan/re-scan, first media on stage (asset protocol), settings path + Scan/Re-scan label, neighbor/random backend commands.

Later phases: navigation UX, slideshow, tags, Open with… / VLC. See `PLAN.md`.

## License

Private / local use unless otherwise noted.
