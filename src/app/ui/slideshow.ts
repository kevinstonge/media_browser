/**
 * Top-center toolbar: folder picker, file picker, prev/next, slideshow
 * controls, and global nav scope / order / duration selects.
 *
 * Scope (All / Current) and order (Sequential / Random) apply to every
 * navigation input and to the slideshow timer. Slideshow only schedules
 * automatic "next" ticks.
 *
 * Transport: always-visible play/pause + stop icon buttons (no status text).
 * Play/start: clear slideshow history; seed with current (or first); play; schedule timer.
 * Pause: cancel timer; keep history + cursor; stay in slideshow mode.
 * Resume (play while paused): restart timer from full duration.
 * Stop: cancel timer; erase slideshow history; exit slideshow mode (disabled when idle).
 *
 * Manual next/prev while active use slideshow history (via nav.ts)
 * and reset the duration clock through the nav step listener.
 */

import {
  getFirstMedia,
  getFirstMediaInDir,
  getMedia,
  listMediaInDir,
  listParentDirs,
  type MediaItem,
} from "../api";
import {
  displayMedia,
  goNext,
  goPrev,
  jumpToMedia,
  setMediaChromeListener,
  setNavSettingsListener,
  setNavStepListener,
  setNavMode,
  setSlideshowDurationSec,
  type StatusFn,
} from "../nav";
import {
  bumpNavSessionGeneration,
  canResetActiveHistory,
  clearSlideshowHistory,
  composeNavMode,
  navModeOrder,
  navModeScope,
  reconcileBrowseHistoryWithCurrent,
  resetActiveHistoryToCurrent,
  resetSlideshowHistory,
  SLIDESHOW_DURATION_OPTIONS,
  state,
  type NavMode,
  type NavOrder,
  type NavScope,
} from "../state";

let setStatus: StatusFn = () => {};
let timerId: number | null = null;
let playPauseBtn: HTMLButtonElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;
let resetHistoryBtn: HTMLButtonElement | null = null;
let folderBtn: HTMLButtonElement | null = null;
let folderMenu: HTMLElement | null = null;
let fileBtn: HTMLButtonElement | null = null;
let fileMenu: HTMLElement | null = null;
let fileLabel: HTMLElement | null = null;
let scopeSelect: HTMLSelectElement | null = null;
let orderSelect: HTMLSelectElement | null = null;
let durationSelect: HTMLSelectElement | null = null;
let chromeEl: HTMLElement | null = null;

/** Cached list for open dropdowns (avoid re-fetch on every render of labels). */
let cachedDirs: string[] = [];
let cachedFiles: MediaItem[] = [];
let lastListedParentDir: string | null = null;

const DURATION_OPTIONS_HTML = SLIDESHOW_DURATION_OPTIONS.map(
  (s) => `<option value="${s}">${s}s</option>`,
).join("");

export function mountSlideshow(root: HTMLElement, statusFn: StatusFn): void {
  setStatus = statusFn;

  const chrome = document.createElement("div");
  chrome.className = "slideshow-chrome nav-exclude";
  chrome.innerHTML = `
    <div class="slideshow-bar" role="toolbar" aria-label="Library and navigation">
      <div class="toolbar-menu-wrap" id="toolbar-folder-wrap">
        <button
          type="button"
          class="toolbar-icon-btn"
          id="toolbar-folder-btn"
          title="Select folder"
          aria-label="Select folder"
          aria-haspopup="listbox"
          aria-expanded="false"
        >
          <span class="toolbar-folder-icon" aria-hidden="true">📁</span>
        </button>
        <div class="toolbar-dropdown" id="toolbar-folder-menu" role="listbox" aria-label="Folders" hidden></div>
      </div>
      <div class="toolbar-menu-wrap" id="toolbar-file-wrap">
        <button
          type="button"
          class="toolbar-file-btn"
          id="toolbar-file-btn"
          title="Select file"
          aria-label="Select file"
          aria-haspopup="listbox"
          aria-expanded="false"
        >
          <span class="toolbar-file-label" id="toolbar-file-label">No file</span>
          <span class="toolbar-caret" aria-hidden="true">▾</span>
        </button>
        <div class="toolbar-dropdown toolbar-dropdown-files" id="toolbar-file-menu" role="listbox" aria-label="Files" hidden></div>
      </div>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <button type="button" class="slideshow-btn" id="nav-prev" title="Previous" aria-label="Previous">◀</button>
      <button type="button" class="slideshow-btn" id="nav-next" title="Next" aria-label="Next">▶</button>
      <button
        type="button"
        class="slideshow-btn slideshow-icon-btn"
        id="nav-reset-history"
        title="Reset view history"
        aria-label="Reset view history"
      >↻</button>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <button type="button" class="slideshow-btn slideshow-icon-btn" id="slideshow-play-pause" title="Start slideshow" aria-label="Start slideshow">▶</button>
      <button type="button" class="slideshow-btn slideshow-icon-btn" id="slideshow-stop" title="Stop slideshow" aria-label="Stop slideshow" disabled>■</button>
      <label class="slideshow-scope" title="Navigate within current folder only, or all folders">
        <select
          id="nav-scope-select"
          class="slideshow-scope-select"
          aria-label="Folder scope"
        >
          <option value="all">All</option>
          <option value="current">Current</option>
        </select>
      </label>
      <label class="slideshow-scope" title="Sequential (alphabetical) or random order">
        <select
          id="nav-order-select"
          class="slideshow-scope-select"
          aria-label="Navigation order"
        >
          <option value="sequential">Sequential</option>
          <option value="random">Random</option>
        </select>
      </label>
      <label class="slideshow-scope" title="Seconds between automatic next while slideshow plays">
        <select
          id="nav-duration-select"
          class="slideshow-scope-select slideshow-duration-select"
          aria-label="Slideshow interval"
        >
          ${DURATION_OPTIONS_HTML}
        </select>
      </label>
    </div>
  `;
  root.appendChild(chrome);
  chromeEl = chrome;

  playPauseBtn = chrome.querySelector("#slideshow-play-pause");
  stopBtn = chrome.querySelector("#slideshow-stop");
  prevBtn = chrome.querySelector("#nav-prev");
  nextBtn = chrome.querySelector("#nav-next");
  resetHistoryBtn = chrome.querySelector("#nav-reset-history");
  folderBtn = chrome.querySelector("#toolbar-folder-btn");
  folderMenu = chrome.querySelector("#toolbar-folder-menu");
  fileBtn = chrome.querySelector("#toolbar-file-btn");
  fileMenu = chrome.querySelector("#toolbar-file-menu");
  fileLabel = chrome.querySelector("#toolbar-file-label");
  scopeSelect = chrome.querySelector("#nav-scope-select");
  orderSelect = chrome.querySelector("#nav-order-select");
  durationSelect = chrome.querySelector("#nav-duration-select");

  playPauseBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSlideshowPlayback();
  });
  stopBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    stopSlideshow();
  });

  prevBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void goPrev();
  });
  nextBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void goNext();
  });
  resetHistoryBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    onResetViewHistory();
  });

  folderBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleFolderMenu();
  });
  fileBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleFileMenu();
  });

  scopeSelect?.addEventListener("change", () => {
    void onScopeOrOrderChange();
  });
  orderSelect?.addEventListener("change", () => {
    void onScopeOrOrderChange();
  });
  durationSelect?.addEventListener("change", () => {
    void onDurationSelectChange();
  });

  // Prevent stage nav when opening native select menus
  for (const sel of [scopeSelect, orderSelect, durationSelect]) {
    sel?.addEventListener("click", (e) => e.stopPropagation());
    sel?.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  // Prevent stage nav when interacting with toolbar / menus
  chrome.addEventListener("click", (e) => e.stopPropagation());
  chrome.addEventListener("contextmenu", (e) => e.stopPropagation());
  chrome.addEventListener(
    "wheel",
    (e) => {
      e.stopPropagation();
    },
    { passive: true },
  );

  // Close dropdowns on outside click
  document.addEventListener("click", (e) => {
    if (!chromeEl) return;
    const t = e.target as Node;
    if (chromeEl.contains(t)) return;
    closeMenus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
  });

  // Any successful next/prev (manual or timer-driven) resets the clock while playing.
  setNavStepListener(() => {
    if (state.slideshowStatus === "playing") {
      scheduleTimer();
    }
  });

  setMediaChromeListener(() => {
    refreshToolbarChrome();
  });

  setNavSettingsListener(() => {
    updateNavSelects();
    updateControls();
  });

  updateControls();
  updateFileLabel();
  updateNavSelects();
}

/**
 * Refresh folder/file chrome after media display, scan, or root change.
 * Safe to call often; only re-fetches lists when a menu is open.
 */
export function refreshToolbarChrome(): void {
  updateFileLabel();
  updateNavSelects();
  updateResetHistoryButton();
  if (folderMenu && !folderMenu.hidden) {
    void populateFolderMenu();
  }
  if (fileMenu && !fileMenu.hidden) {
    void populateFileMenu(true);
  }
}

/** Collapse active browse/slideshow history to the current item only. */
function onResetViewHistory(): void {
  if (state.navigating || state.scanning) return;
  if (!canResetActiveHistory()) return;
  if (!resetActiveHistoryToCurrent()) return;
  updateResetHistoryButton();
  setStatus("View history reset", true);
  window.setTimeout(() => setStatus("", false), 2000);
}

function updateResetHistoryButton(): void {
  if (!resetHistoryBtn) return;
  // Enabled when active bag has a multi-step path. (navigating is click-gated only —
  // chrome often refreshes mid-nav while navigating is still true.)
  resetHistoryBtn.disabled = state.scanning || !canResetActiveHistory();
}

function closeMenus(): void {
  if (folderMenu) folderMenu.hidden = true;
  if (fileMenu) fileMenu.hidden = true;
  folderBtn?.setAttribute("aria-expanded", "false");
  fileBtn?.setAttribute("aria-expanded", "false");
}

async function toggleFolderMenu(): Promise<void> {
  if (!folderMenu || !folderBtn) return;
  const opening = folderMenu.hidden;
  closeMenus();
  if (!opening) return;
  await populateFolderMenu();
  folderMenu.hidden = false;
  folderBtn.setAttribute("aria-expanded", "true");
}

async function toggleFileMenu(): Promise<void> {
  if (!fileMenu || !fileBtn) return;
  const opening = fileMenu.hidden;
  closeMenus();
  if (!opening) return;
  await populateFileMenu(true);
  fileMenu.hidden = false;
  fileBtn.setAttribute("aria-expanded", "true");
  // Scroll current file into view
  const active = fileMenu.querySelector<HTMLElement>(".toolbar-option-active");
  active?.scrollIntoView({ block: "nearest" });
}

function folderDisplayLabel(parentDir: string, rootPath: string | null): string {
  if (!rootPath) return parentDir;
  const normRoot = rootPath.replace(/[/\\]+$/, "");
  const normDir = parentDir.replace(/[/\\]+$/, "");
  // Case-insensitive prefix strip for Windows paths
  const rootLower = normRoot.toLowerCase();
  const dirLower = normDir.toLowerCase();
  if (dirLower === rootLower) return ".";
  if (dirLower.startsWith(rootLower + "\\") || dirLower.startsWith(rootLower + "/")) {
    const rel = normDir.slice(normRoot.length).replace(/^[/\\]+/, "");
    return rel || ".";
  }
  return parentDir;
}

async function populateFolderMenu(): Promise<void> {
  if (!folderMenu) return;
  folderMenu.innerHTML = "";

  const root = state.root;
  if (!root || root.id <= 0) {
    folderMenu.innerHTML = `<div class="toolbar-option toolbar-option-empty">No library</div>`;
    return;
  }

  try {
    cachedDirs = await listParentDirs(root.id);
  } catch (err) {
    console.warn("list_parent_dirs failed", err);
    folderMenu.innerHTML = `<div class="toolbar-option toolbar-option-empty">Failed to load folders</div>`;
    return;
  }

  if (cachedDirs.length === 0) {
    folderMenu.innerHTML = `<div class="toolbar-option toolbar-option-empty">No folders</div>`;
    return;
  }

  const currentParent = state.currentMedia?.parentDir ?? null;

  for (const dir of cachedDirs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toolbar-option";
    btn.setAttribute("role", "option");
    btn.title = dir;
    btn.textContent = folderDisplayLabel(dir, root.path);
    if (currentParent != null && pathsEqual(currentParent, dir)) {
      btn.classList.add("toolbar-option-active");
      btn.setAttribute("aria-selected", "true");
    } else {
      btn.setAttribute("aria-selected", "false");
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void onPickFolder(dir);
    });
    folderMenu.appendChild(btn);
  }
}

async function populateFileMenu(force = false): Promise<void> {
  if (!fileMenu) return;
  fileMenu.innerHTML = "";

  const root = state.root;
  const parentDir = state.currentMedia?.parentDir ?? null;
  if (!root || root.id <= 0 || !parentDir) {
    fileMenu.innerHTML = `<div class="toolbar-option toolbar-option-empty">No files</div>`;
    cachedFiles = [];
    lastListedParentDir = null;
    return;
  }

  if (force || lastListedParentDir !== parentDir || cachedFiles.length === 0) {
    try {
      cachedFiles = await listMediaInDir(root.id, parentDir);
      lastListedParentDir = parentDir;
    } catch (err) {
      console.warn("list_media_in_dir failed", err);
      fileMenu.innerHTML = `<div class="toolbar-option toolbar-option-empty">Failed to load files</div>`;
      return;
    }
  }

  if (cachedFiles.length === 0) {
    fileMenu.innerHTML = `<div class="toolbar-option toolbar-option-empty">No files</div>`;
    return;
  }

  const currentId = state.currentMediaId;

  for (const item of cachedFiles) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toolbar-option";
    btn.setAttribute("role", "option");
    btn.title = item.relPath || item.path;
    btn.textContent = item.filename;
    if (item.id === currentId) {
      btn.classList.add("toolbar-option-active");
      btn.setAttribute("aria-selected", "true");
    } else {
      btn.setAttribute("aria-selected", "false");
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void onPickFile(item.id);
    });
    fileMenu.appendChild(btn);
  }
}

async function onPickFolder(parentDir: string): Promise<void> {
  closeMenus();
  const root = state.root;
  if (!root) return;
  try {
    const first = await getFirstMediaInDir(root.id, parentDir);
    if (!first) {
      setStatus("No media in that folder", true);
      window.setTimeout(() => setStatus("", false), 2000);
      return;
    }
    // Folder jump is a browse jump (resets browse history tip).
    if (state.slideshowStatus !== "idle") {
      // Stay in slideshow session: show item without wiping slideshow history
      // by treating as display + push would be wrong — use jump for browse-like pick.
      // User intent: go to that folder's first file.
      stopSlideshow();
    }
    await jumpToMedia(first);
    refreshToolbarChrome();
  } catch (err) {
    setStatus(`Open folder failed: ${formatErr(err)}`, true);
  }
}

async function onPickFile(id: number): Promise<void> {
  closeMenus();
  if (state.currentMediaId === id) return;
  try {
    const item = await getMedia(id);
    if (!item) {
      setStatus("File not found", true);
      window.setTimeout(() => setStatus("", false), 2000);
      return;
    }
    if (state.slideshowStatus !== "idle") {
      stopSlideshow();
    }
    await jumpToMedia(item);
    refreshToolbarChrome();
  } catch (err) {
    setStatus(`Open file failed: ${formatErr(err)}`, true);
  }
}

function pathsEqual(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, "").toLowerCase() === b.replace(/[/\\]+$/, "").toLowerCase();
}

function updateFileLabel(): void {
  if (!fileLabel) return;
  const name = state.currentMedia?.filename;
  fileLabel.textContent = name && name.length > 0 ? name : "No file";
  fileLabel.title = state.currentMedia?.path ?? "";
  if (fileBtn) {
    fileBtn.disabled = state.root == null || state.currentMedia == null;
  }
  if (folderBtn) {
    folderBtn.disabled = state.root == null || state.root.id <= 0;
  }
  const canNav =
    state.root != null &&
    state.root.id > 0 &&
    state.currentMediaId != null &&
    !state.scanning;
  if (prevBtn) prevBtn.disabled = !canNav;
  if (nextBtn) nextBtn.disabled = !canNav;
}

function updateNavSelects(): void {
  const mode = state.navMode;
  if (scopeSelect) {
    scopeSelect.value = navModeScope(mode);
    scopeSelect.title =
      navModeScope(mode) === "current"
        ? "Current folder only"
        : "All folders";
  }
  if (orderSelect) {
    orderSelect.value = navModeOrder(mode);
    orderSelect.title =
      navModeOrder(mode) === "random"
        ? "Random order"
        : "Sequential (alphabetical) order";
  }
  if (durationSelect) {
    durationSelect.value = String(state.slideshowDurationSec);
  }
}

async function onScopeOrOrderChange(): Promise<void> {
  if (!scopeSelect || !orderSelect) return;
  const scope = (scopeSelect.value === "current" ? "current" : "all") as NavScope;
  const order = (
    orderSelect.value === "random" ? "random" : "sequential"
  ) as NavOrder;
  const mode = composeNavMode(order, scope);
  await setNavMode(mode);
  // Keep Settings panel select in sync when present.
  syncSettingsNavSelects(mode);
  updateNavSelects();
  setStatus(
    `Nav: ${labelMode(mode)}`,
    true,
  );
  window.setTimeout(() => setStatus("", false), 2000);
}

async function onDurationSelectChange(): Promise<void> {
  if (!durationSelect) return;
  const sec = Number(durationSelect.value);
  await setSlideshowDurationSec(sec);
  // Settings panel
  const settingsDuration = document.querySelector<HTMLSelectElement>(
    "#settings-slideshow-duration",
  );
  if (settingsDuration) settingsDuration.value = String(state.slideshowDurationSec);
  onSlideshowSettingsChanged();
  setStatus(`Slideshow interval: ${state.slideshowDurationSec}s`, true);
  window.setTimeout(() => setStatus("", false), 2000);
}

function syncSettingsNavSelects(mode: NavMode): void {
  const settingsNav = document.querySelector<HTMLSelectElement>(
    "#settings-nav-mode",
  );
  if (settingsNav) settingsNav.value = mode;
  // Legacy dual select if still present
  const settingsSlide = document.querySelector<HTMLSelectElement>(
    "#settings-slideshow-nav-mode",
  );
  if (settingsSlide) settingsSlide.value = mode;
}

function cancelTimer(): void {
  if (timerId != null) {
    window.clearTimeout(timerId);
    timerId = null;
  }
}

function scheduleTimer(): void {
  cancelTimer();
  if (state.slideshowStatus !== "playing") return;
  // Duration is clamped on set/load; still guard NaN/0 for safety.
  const sec = Math.max(1, state.slideshowDurationSec || 1);
  const ms = sec * 1000;
  timerId = window.setTimeout(() => {
    timerId = null;
    void onTimerTick();
  }, ms);
}

async function onTimerTick(): Promise<void> {
  if (state.slideshowStatus !== "playing") return;
  // goNext notifies the step listener, which reschedules when still playing.
  await goNext();
  // If goNext was a no-op (e.g. empty / blocked), ensure we keep ticking.
  if (state.slideshowStatus === "playing" && timerId == null) {
    scheduleTimer();
  }
}

/**
 * Enter slideshow: clear slideshow history, seed current (or first), play.
 * Browse history is left untouched. Mode is the global nav mode.
 */
export async function startSlideshow(): Promise<void> {
  if (state.scanning || !state.root || state.root.id <= 0) {
    setStatus("Select and scan a folder first", true);
    window.setTimeout(() => setStatus("", false), 2500);
    return;
  }
  if (state.root.itemCount === 0) {
    setStatus("No media for slideshow", true);
    window.setTimeout(() => setStatus("", false), 2500);
    return;
  }

  // Invalidate any in-flight browse nav so it cannot write slideshow bag mid-start.
  bumpNavSessionGeneration();
  clearSlideshowHistory();

  try {
    if (state.currentMediaId != null && state.currentMedia) {
      resetSlideshowHistory(state.currentMediaId);
    } else {
      // Prefer first in current folder when scoped; otherwise first in library.
      let first: MediaItem | null = null;
      if (
        navModeScope(state.navMode) === "current" &&
        state.currentMedia?.parentDir
      ) {
        first = await getFirstMediaInDir(
          state.root.id,
          state.currentMedia.parentDir,
        );
      }
      if (!first) {
        first = await getFirstMedia(state.root.id);
      }
      if (!first) {
        setStatus("No media for slideshow", true);
        window.setTimeout(() => setStatus("", false), 2500);
        return;
      }
      resetSlideshowHistory(first.id);
      await displayMedia(first);
    }
  } catch (err) {
    console.error("startSlideshow failed", err);
    setStatus(`Slideshow failed: ${formatErr(err)}`, true);
    clearSlideshowHistory();
    state.slideshowStatus = "idle";
    bumpNavSessionGeneration();
    updateControls();
    return;
  }

  state.slideshowStatus = "playing";
  // Fresh generation for the playing session (invalidates any race from seed await).
  bumpNavSessionGeneration();
  scheduleTimer();
  updateControls();
  setStatus(
    `Slideshow · ${state.slideshowDurationSec}s · ${labelMode(state.navMode)}`,
    true,
  );
  window.setTimeout(() => setStatus("", false), 2500);
  refreshToolbarChrome();
}

/** Cancel timer; keep slideshow history + current item; stay in mode. */
export function pauseSlideshow(): void {
  if (state.slideshowStatus !== "playing") return;
  cancelTimer();
  state.slideshowStatus = "paused";
  updateControls();
  setStatus("Slideshow paused", true);
  window.setTimeout(() => setStatus("", false), 2000);
}

/** Restart timer from full duration. */
export function resumeSlideshow(): void {
  if (state.slideshowStatus !== "paused") return;
  state.slideshowStatus = "playing";
  scheduleTimer();
  updateControls();
  setStatus("Slideshow resumed", true);
  window.setTimeout(() => setStatus("", false), 2000);
}

/**
 * Exit slideshow: cancel timer, erase slideshow history.
 * Current media remains; browse history is reconciled so Prev continues
 * from the displayed item (stack preserved via push, not reset).
 *
 * Bumps nav session generation first so any in-flight goNext/goPrev that
 * captured the slideshow bag abandons further commits/displays.
 */
export function stopSlideshow(): void {
  if (state.slideshowStatus === "idle") return;
  cancelTimer();
  // Invalidate in-flight nav before flipping status → idle (avoids browse writes).
  bumpNavSessionGeneration();
  clearSlideshowHistory();
  state.slideshowStatus = "idle";
  // Manual browse continues on current item: tip browse history at current.
  reconcileBrowseHistoryWithCurrent();
  updateControls();
  setStatus("Slideshow stopped", true);
  window.setTimeout(() => setStatus("", false), 2000);
}

/** Reschedule if playing after settings duration change (also via nav listener). */
export function onSlideshowSettingsChanged(): void {
  if (state.slideshowStatus === "playing") {
    scheduleTimer();
  }
  updateControls();
  updateNavSelects();
}

/** Space bar: start if idle, pause if playing, resume if paused. */
export function toggleSlideshowPlayback(): void {
  if (state.slideshowStatus === "idle") {
    void startSlideshow();
  } else if (state.slideshowStatus === "playing") {
    pauseSlideshow();
  } else if (state.slideshowStatus === "paused") {
    resumeSlideshow();
  }
}

function updateControls(): void {
  const status = state.slideshowStatus;
  const playing = status === "playing";
  const idle = status === "idle";

  if (playPauseBtn) {
    // Idle or paused → play; playing → pause. Icon only (no label text).
    playPauseBtn.textContent = playing ? "❚❚" : "▶";
    const label = playing
      ? "Pause slideshow"
      : idle
        ? "Start slideshow"
        : "Resume slideshow";
    playPauseBtn.title = label;
    playPauseBtn.setAttribute("aria-label", label);
  }
  if (stopBtn) {
    // Always visible; inert while already stopped.
    stopBtn.disabled = idle;
  }

  updateResetHistoryButton();
  updateFileLabel();
}

function labelMode(mode: NavMode): string {
  const order = navModeOrder(mode) === "random" ? "random" : "sequential";
  const scope = navModeScope(mode) === "current" ? "current folder" : "all folders";
  return `${order} · ${scope}`;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
