# Media Browser — Implementation Plan (Tauri + TypeScript + SQLite)

**Status:** Plan only — no implementation yet  
**Platform:** Windows 11 (local only)  
**Stack:** Tauri 2 · TypeScript · SQLite · HTML/CSS UI  
**Source of truth for navigation:** SQLite only (never re-scan the filesystem during browse/slideshow)

---

## 1. Product summary

A lightweight, local-only fullscreen media viewer that:

- Points at a root folder, **scans once** (or on demand re-scan) into SQLite
- Browses **images and videos** by loading full paths from the DB on demand
- Supports next/previous, random modes, and slideshow
- Attaches **tags** to items; tags may have **badge images** and **sound files** that surface when an item is shown
- Keeps chrome minimal: hover-reveal toolbars (~10px padded hit regions)
- Offers **Open with…** (and VLC-friendly open) when in-app playback is insufficient
- Never modifies or deletes media files — read-only access only

**Non-goals (v1):**
- Network/sync/multi-user
- Editing, renaming, or deleting media
- Full IrfanView / VLC format parity inside the app
- Cloud storage, plugins marketplace, or remote libraries
- Watching filesystem for live changes (explicit re-scan only)

---

## 2. Goals & constraints (from sketch + clarifications)

| Constraint | Implication |
|------------|-------------|
| Small, light, instant launch | Tauri 2 + system WebView2; no Electron; no bundled VLC; minimal deps |
| Navigation only via SQLite | Scan writes rows; UI queries DB for prev/next/random/slideshow; load file by stored absolute path |
| VLC already installed | Use for “Open with VLC” / fallback; do not ship libVLC |
| Format breadth “good enough” | Rely on WebView2/HTML5 + WIC-ish image support; edge cases → Open with… |
| Local only, no security model | Simple file reads; custom protocol for media serving is fine |
| Hover UI | CSS hit regions + opacity; no permanent chrome clutter |

---

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (WebView2)                                        │
│  TypeScript + HTML/CSS                                      │
│  - Fullscreen stage (img / video / error state)             │
│  - Hover overlays: settings, tags, slideshow                │
│  - Keyboard / mouse navigation                              │
│  - Tag badge strip + sequential tag audio                   │
└───────────────────────────┬─────────────────────────────────┘
                            │ Tauri IPC (invoke / events)
┌───────────────────────────▼─────────────────────────────────┐
│  Rust backend (Tauri commands)                              │
│  - SQLite (rusqlite / sqlx)                                 │
│  - Folder pick dialog                                       │
│  - Recursive scan → DB upsert                               │
│  - Query helpers: next/prev/random, tags, settings          │
│  - Resolve media path → asset protocol / file URL           │
│  - Shell: open path with default app / VLC                  │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  App data                                                   │
│  - SQLite DB (library.db next to the executable)            │
│  - Optional: last window state only if needed               │
│  - Media files remain in user-chosen folders (never copied) │
└─────────────────────────────────────────────────────────────┘
```

### Why this split

- **Rust + SQLite:** Fast scan, reliable queries, tiny runtime cost, no Node process.
- **TS UI:** Overlays, slideshow timer, layered audio — natural in the browser engine you already pay for via WebView2.
- **No media index in memory as source of truth:** Optional caches OK for UX, but **all navigation decisions re-read DB** (or use a session list derived from a DB query at slideshow start / mode change).

---

## 4. Media loading model (critical)

1. User scans folder → DB stores absolute `path` per media item (and metadata).
2. Navigation (next/prev/random/slideshow) **only** selects a `media_item.id` / path via SQL (or from a session playlist built from SQL).
3. Frontend asks backend for the selected item’s path (or a media URL).
4. App loads that single file into `<img>` or `<video>` (or shows error + Open with…).
5. Folder is **not** walked again until the user hits Scan / Re-scan.

**Missing files:** If path no longer exists, show a clear “file missing” state, keep DB row (so re-scan or manual cleanup can reconcile later). Optionally mark `missing = 1` on failed open. Do not delete rows automatically in v1.

---

## 5. Data model (normalized SQLite)

### 5.1 Tables

```sql
-- Root libraries the user has scanned
CREATE TABLE root_dir (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,  -- absolute, normalized
  created_at    TEXT NOT NULL,         -- ISO-8601
  last_scanned  TEXT
);

-- Recent / last used roots (settings: restore last folder)
CREATE TABLE root_usage (
  id            INTEGER PRIMARY KEY,
  root_dir_id   INTEGER NOT NULL REFERENCES root_dir(id) ON DELETE CASCADE,
  used_at       TEXT NOT NULL
);
CREATE INDEX idx_root_usage_used_at ON root_usage(used_at DESC);

-- One row per media file under a root
CREATE TABLE media_item (
  id            INTEGER PRIMARY KEY,
  root_dir_id   INTEGER NOT NULL REFERENCES root_dir(id) ON DELETE CASCADE,
  path          TEXT NOT NULL UNIQUE,  -- absolute full path
  filename      TEXT NOT NULL,
  parent_dir    TEXT NOT NULL,         -- absolute parent directory (for "random in current dir")
  rel_path      TEXT NOT NULL,         -- path relative to root (display / sort helpers)
  media_type    TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'unknown')),
  ext           TEXT NOT NULL,         -- lowercase extension without dot
  size_bytes    INTEGER,
  mtime_ms      INTEGER,               -- for re-scan change detection
  is_missing    INTEGER NOT NULL DEFAULT 0,  -- 0/1
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_media_root ON media_item(root_dir_id);
CREATE INDEX idx_media_parent ON media_item(root_dir_id, parent_dir);
CREATE INDEX idx_media_filename ON media_item(root_dir_id, filename COLLATE NOCASE);
CREATE INDEX idx_media_rel_path ON media_item(root_dir_id, rel_path COLLATE NOCASE);

-- Global tag vocabulary
CREATE TABLE tag (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at    TEXT NOT NULL
);

-- Many-to-many: item ↔ tags
CREATE TABLE media_tag (
  media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  tag_id        INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (media_item_id, tag_id)
);
CREATE INDEX idx_media_tag_tag ON media_tag(tag_id);

-- Optional badge image / sound assets bound to a tag (global, not per-item)
CREATE TABLE tag_asset (
  id            INTEGER PRIMARY KEY,
  tag_id        INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  asset_type    TEXT NOT NULL CHECK (asset_type IN ('image', 'sound')),
  path          TEXT NOT NULL,         -- absolute path to asset file
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tag_id, asset_type, path)
);
CREATE INDEX idx_tag_asset_tag ON tag_asset(tag_id, asset_type, sort_order);

-- App settings (key/value JSON or typed columns; KV is simpler for v1)
CREATE TABLE setting (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL        -- JSON-encoded
);
```

### 5.2 Settings keys (initial)

| Key | Value shape | Default |
|-----|-------------|---------|
| `nav_mode` | `"alpha" \| "random_root" \| "random_current_dir"` | `"alpha"` |
| `slideshow_nav_mode` | same as above | `"alpha"` |
| `slideshow_duration_sec` | integer ≥ 1 | `5` |
| `active_root_id` | number \| null | null |
| `last_media_id` | number \| null | null (optional resume) |

`last_used` root: derive from `root_usage` ordered by `used_at DESC LIMIT 1` (as in the sketch). Also set `active_root_id` on successful folder select/scan.

### 5.3 Scan semantics

**Scan / Re-scan** (only place that walks the filesystem for the library):

1. Resolve root absolute path; upsert `root_dir`.
2. Insert `root_usage` row with now.
3. Walk recursively; for each file with a known media extension, upsert `media_item`.
4. Re-scan policy (recommended v1):
   - **Upsert** by absolute `path`
   - Update `mtime_ms` / `size_bytes` / `media_type` when changed
   - Paths under root no longer found → set `is_missing = 1` (do not hard-delete, so tags survive if file returns or user fixes path later)
   - Optionally later: “Purge missing” in settings
5. Tag associations never wiped by scan.

**Supported extensions (v1 allowlist)** — expandable without schema change:

- **Images:** `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `svg`, `avif`, `ico`, `tif`, `tiff`  
  (HEIC optional if WebView can display; otherwise still index + Open with…)
- **Videos:** `mp4`, `webm`, `mkv`, `mov`, `avi`, `wmv`, `m4v`, `ogv`  
  (Playback success is best-effort; Open with VLC always available)

Classification: extension → `image` | `video` | skip non-media.

---

## 6. Navigation (DB-only)

All modes operate on **rows for the active `root_dir_id`**, typically `WHERE is_missing = 0` (toggle later if useful).

### 6.1 Modes

| Mode | Behavior |
|------|----------|
| **Next alphabetical** | Order by `rel_path COLLATE NOCASE` (or `filename`); next after current; wrap to first |
| **Random in root** | Uniform random among all items in root (optional: avoid immediate repeat of current id) |
| **Random in current dir** | Random among items with same `parent_dir` as current |

**Previous:**

- **Alpha:** previous in sort order (wrap).
- **Random modes:** previous means **session history**, not reverse random. Maintain an in-memory stack/list of visited `media_item.id` for the current “browse session.”

### 6.2 Session history

```
history: number[]   // media_item ids, in visit order
cursor: number      // index into history
```

- **Next (random):** if cursor not at end, move forward in history; else pick new id from DB, append, advance cursor.
- **Next (alpha):** resolve neighbor via SQL (wraps at end→first within all/current scope); push onto history.
- **Previous:** cursor--; load `history[cursor]`. If cursor at 0: alpha SQL-prevs (wraps first→last) and unshifts; random picks a new id from DB, unshifts to the front, and shows it — history grows infinitely in both directions.
- **Direct jump** (e.g. after scan to first item): reset history to `[id]`, cursor `0`.

Slideshow uses the **same history mechanism** with its own list (or shared list — **recommend separate `slideshowHistory`** so stopping slideshow does not trash manual browse history). Sketch: stop erases slideshow index list; pause retains.

### 6.3 Inputs

| Action | Input |
|--------|--------|
| Next | Right arrow, right-click |
| Previous | Left arrow, left-click |
| (Reserved) | Avoid stealing clicks on overlay hit regions |

**Click targets:** When pointer is over a visible control or its padded hit region, navigation clicks do not fire. When chrome is hidden, full-stage left/right click navigates.

---

## 7. Slideshow

- **Toolbar** bottom-right, hidden until hover (padded ~10px).
- Controls: **Start / Pause / Resume / Stop**
  - **Start:** clear slideshow history; set playing; schedule timer; load first/next per `slideshow_nav_mode`
  - **Pause:** cancel timer; keep history + current index
  - **Resume:** restart timer from full duration (or remaining — full duration is simpler v1)
  - **Stop:** cancel timer; erase slideshow history; exit slideshow mode (manual browse continues on current item)
- **Duration:** integer seconds from settings; **any next/prev during slideshow resets the duration clock**
- Next/prev during slideshow use **slideshow** nav mode + slideshow history (not necessarily the global browse nav mode — settings expose both defaults per sketch)

---

## 8. Tags & tag assets

### 8.1 Per-item tag UI (bottom-left, hover-reveal)

- Vertical list of tags on current item
- Hover tag → show **×** to remove (`DELETE FROM media_tag`)
- Dropdown of all tags not already on item + **Add**
- Adding a brand-new tag name: create `tag` row then associate (either free-text + add, or manage only in settings — **v1:** dropdown of existing tags + “create tag” in settings; optional inline create if cheap)

### 8.2 Tag badges & sounds (on item display)

When current media item loads:

1. Query all tags for item + their `tag_asset` rows ordered by `sort_order`.
2. **Images:** show in top-left, left-to-right (small fixed height, e.g. 48–64px).
3. **Sounds:** play **sequentially** (queue); do not overlap each other. Video’s own audio continues (layered with tag sounds as sketch describes). Provide mute toggle later if needed; v1 can leave both audible.
4. Changing item: stop tag-sound queue; clear badges; load new set.

### 8.3 Global tag manager (settings)

- List all tags (rename optional v1.1; delete tag with cascade off media_tag + assets)
- Per tag: add/remove **image** and **sound** asset paths (file pickers)
- Asset files are referenced by absolute path (not copied into app data) — same philosophy as media library

---

## 9. Settings panel (top-right gear)

Hover-reveal gear (~10px padding). Panel contents:

1. **Folder path** text + button → native directory picker → set active root (prompt scan if new / empty)
2. **Scan / Re-scan** button label:
   - `Scan` if this root has never been scanned (`last_scanned` null or no items)
   - `Re-scan` if already present in DB
3. **Default mode — next item shows:** alpha | random root | random current dir
4. **Slideshow defaults:** same next-item modes + duration (seconds, integer)
5. **Tag manager** section (global tags + badge/sound assets)
6. **Open with…** convenience:
   - Open current file with **system default**
   - Open current file with **VLC** (common install paths / `vlc` on PATH; see §11)

Persist settings in SQLite `setting` table immediately on change.

---

## 10. Frontend UI structure

### 10.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│ [tag badges …………]                         [⚙ settings]  │
│                                                          │
│                                                          │
│                    MEDIA STAGE                           │
│              (img | video | empty | error)               │
│                                                          │
│                                                          │
│ [tags panel]                          [slideshow bar]    │
└──────────────────────────────────────────────────────────┘
```

- App launches **fullscreen** (or maximized + frameless — prefer true fullscreen with Esc to leave or toggle; document choice in impl: **F11 / Esc toggle**, start maximized fullscreen for “viewer” feel).
- Media: `object-fit: contain`; letterbox background `#000`.
- Video: autoplay when selected; loop optional (default **no loop** for slideshow handoff — when video ends in slideshow, advance; when not slideshow, stop on last frame or pause).
- **Slideshow + video:** prefer advancing when `duration_sec` elapses **or** video ends, whichever policy we lock — **recommended:** timer always wins for consistency; user can raise duration for long videos. (Document in UI help later.)

### 10.2 Empty / error states

| State | UI |
|-------|-----|
| No root selected | CTA: choose folder |
| Root empty after scan | “No media found” |
| File missing | Message + path + Open with… disabled or still offer parent folder |
| Decode/play error | Message + **Open with default** + **Open with VLC** |

### 10.3 Performance UX

- Preload only current item (instant launch priority). Optional: prefetch next image path only (v1.1).
- Avoid loading entire library into JS arrays; use SQL for neighbors. For alpha next/prev, backend command `get_neighbor(id, direction)` is enough. For random, `get_random(root_id, parent_dir?)`.

---

## 11. Backend command surface (Tauri)

Illustrative IPC API (names flexible):

| Command | Purpose |
|---------|---------|
| `settings_get` / `settings_set` | Read/write settings |
| `pick_folder` | Native directory dialog |
| `get_last_root` | From `root_usage` |
| `scan_root(path)` | Recursive scan / re-scan |
| `get_media(id)` | Row + tags + tag assets |
| `get_neighbor(...)` | Alpha prev/next |
| `get_random(...)` | Random root or current dir |
| `list_tags` / `create_tag` / `delete_tag` | Tag vocabulary |
| `add_media_tag` / `remove_media_tag` | Associations |
| `add_tag_asset` / `remove_tag_asset` / `pick_file` | Tag badges/sounds |
| `media_url(path or id)` | Convert to custom protocol URL for WebView |
| `open_with_default(path)` | Shell execute default association |
| `open_with_vlc(path)` | Launch VLC with file argument |
| `path_exists(path)` | For missing detection |

### 11.1 Serving local media to WebView

Use a **Tauri asset / custom protocol** (e.g. `media://localhost/<percent-encoded-path>` or convert-file-src patterns supported by Tauri 2) so `<img>` / `<video>` / `<audio>` can load arbitrary absolute paths outside the app bundle. Do **not** copy files into `appData`.

### 11.2 VLC launch (Windows)

Try in order:

1. `vlc` on PATH  
2. `%PROGRAMFILES%\VideoLAN\VLC\vlc.exe`  
3. `%PROGRAMFILES(X86)%\VideoLAN\VLC\vlc.exe`  
4. Uninstall registry key `InstallDir` if needed  

Pass the media path as an argument; if not found, show toast: “VLC not found — install VLC or use Open with default.”

---

## 12. Project layout (proposed)

```
media_browser/
  project sketch.md
  PLAN.md
  src-tauri/                 # Rust
    src/
      main.rs
      db.rs                  # schema, migrations, queries
      scan.rs                # recursive walk + upsert
      commands.rs            # Tauri commands
      shell_open.rs          # default + VLC
    Cargo.toml
    tauri.conf.json
  src/                       # Frontend
    index.html
    main.ts
    styles.css
    app/
      state.ts               # current item, histories, slideshow timer
      api.ts                 # invoke wrappers
      ui/
        stage.ts
        settings.ts
        tags.ts
        slideshow.ts
        chrome.ts            # hover hit regions
  package.json
  tsconfig.json
  README.md
```

Use **Vite + vanilla TS** (or lightweight solid/react only if needed). Prefer **vanilla TS** for smallest surface and instant feel — no React required for this UI.

---

## 13. Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Shell | **Tauri 2** | Tiny vs Electron; WebView2 on Win11; instant launch |
| UI language | **TypeScript (vanilla + Vite)** | Fast overlays; low overhead; you won’t maintain it manually |
| DB | **SQLite via Rust** | Navigation source of truth; durable tags; single file |
| Navigation I/O | **SQL only** after scan | Matches product rule; deterministic; fast |
| Playback | **HTML5 img/video/audio** | Zero bundled codecs; light |
| Fallback | **Open with default + Open with VLC** | Power without bundling VLC |
| Scan missing files | Soft-flag `is_missing` | Preserve tags |
| Tag assets | Absolute paths, not copied | Light disk; user keeps control |
| Random prev | Session history stack | Random has no natural reverse |
| Slideshow history | Separate list; stop clears | Per sketch |
| No live FS watch | Explicit re-scan | Simpler, predictable, light |

---

## 14. Implementation phases (PR-style increments)

Each phase should leave the app runnable.

### PR 1 — Scaffold
- Tauri 2 + Vite + TS project
- Black fullscreen shell, quit/fullscreen toggles
- SQLite open in app data + schema migration runner
- README: dev (`npm run tauri dev`) and build notes

### PR 2 — Scan + DB browse skeleton
- Folder picker, `root_dir` / `root_usage` / `media_item`
- Scan / Re-scan with extension allowlist
- Settings: path display, scan button label logic
- Backend: get first item, get_neighbor (alpha), get_random
- Stage: show image or video from custom protocol; empty states

### PR 3 — Navigation UX
- Left/right keys and clicks
- Nav mode setting (alpha / random root / random current dir)
- Session history for previous under random modes
- Persist nav mode + last root; restore last root on launch (no auto full re-scan)

### PR 4 — Slideshow
- Duration setting, start/pause/stop UI (hover bottom-right)
- Slideshow-specific nav mode + history
- Timer reset on manual next/prev
- Stop clears slideshow history

### PR 5 — Tags
- Tag tables + per-item bottom-left UI
- Add/remove tags; list tags in settings
- Tag badges top-left; sequential tag sounds via `<audio>` queue
- Tag asset file pickers in settings

### PR 6 — Fallbacks & polish
- Open with default / Open with VLC
- Missing file + decode error states
- Soft-missing on re-scan
- Hover hit-region polish, focus outlines optional, basic keyboard help (optional `?`)
- App icon, window title “Media Browser”

### PR 7 — Hardening (optional before “done”)
- Large library perf check (10k+ files scan + neighbor queries indexed)
- Disable navigation while scan runs; progress text (% or count)
- Unit tests for SQL neighbor/random edge cases (empty, single item, wrap)
- Smoke test script / manual test checklist in README

---

## 15. Testing plan (lightweight)

**Manual checklist:**
- [ ] First launch → pick folder → Scan → image displays
- [ ] Re-scan label appears; re-scan updates new files
- [ ] Alpha next/prev wraps; order stable
- [ ] Random root / random current dir; previous walks history
- [ ] Slideshow start/pause/resume/stop; stop clears list
- [ ] Timer resets on next/prev during slideshow
- [ ] Tags add/remove; badges and sequential sounds
- [ ] Missing file after rename outside app
- [ ] Open with VLC opens current path
- [ ] Cold start feels instant with existing DB (no scan)

**Automated (minimal):**
- Rust tests: sort-neighbor wrap, random constrained to parent_dir, scan classification of extensions
- Optional frontend: pure functions for history cursor

---

## 16. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| WebView won’t play some codecs | Open with VLC; keep allowlist honest in README |
| Custom protocol path encoding bugs | Centralize path↔URL helpers; test spaces, unicode, `#` |
| Huge libraries slow scan | Batch inserts in transaction; progress events |
| Click-through vs navigation | Explicit hit-region exclusion zones |
| Tag sounds vs video volume | Sequential tag queue only; document behavior; mute later if needed |
| VLC path variance | Multi-path lookup + clear error |

---

## 17. Out of scope for v1 (parked)

- Filtering browse by tag
- Multi-root simultaneous library merge
- Thumbnails / contact sheet
- Editing tag names / drag-reorder badges
- Auto-rescan / file watcher
- Bundled libVLC or mpv embed
- Non-Windows platforms (design doesn’t block later ports)

---

## 18. Success criteria

The project matches the sketch when:

1. User selects a folder, scans once, and browses entirely via DB-backed next/prev/random.
2. Fullscreen viewer shows images/videos with hover-reveal settings, tags, and slideshow controls.
3. Tags support multi-assign, badges, and sequential sounds.
4. App stays light (Tauri + WebView2, no Electron/VLC bundle) and launches quickly with an existing DB.
5. Stubborn files remain enjoyable via **Open with… / Open with VLC**.

---

## 19. Next step after plan approval

On your go-ahead: implement **PR 1 (scaffold)** then proceed phase-by-phase through PR 6, keeping commits small and the app runnable after each phase.

No code will be written until you approve this plan (or request changes).
