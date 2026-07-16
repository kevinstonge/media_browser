/**
 * Settings overlay: folder path, Scan / Re-scan, nav mode.
 */

import {
  getFirstMedia,
  getLastRoot,
  getMedia,
  getRootInfo,
  pickFolder,
  scanRoot,
  settingsGet,
  type MediaItem,
  type RootInfo,
} from "../api";
import { jumpToMedia, parseNavMode, setNavMode } from "../nav";
import { clearHistory, setCurrentMedia, state, type NavMode } from "../state";
import { showEmpty } from "./stage";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let panel: HTMLElement | null = null;
let pathEl: HTMLElement | null = null;
let scanBtn: HTMLButtonElement | null = null;
let gearBtn: HTMLButtonElement | null = null;
let navModeSelect: HTMLSelectElement | null = null;

export function mountSettings(root: HTMLElement, statusFn: StatusFn): void {
  setStatus = statusFn;

  // Gear hit region (top-right) — padded; navigation clicks excluded via .settings-chrome
  const chrome = document.createElement("div");
  chrome.className = "settings-chrome nav-exclude";
  chrome.innerHTML = `
    <button type="button" class="settings-gear" id="settings-gear" title="Settings" aria-label="Settings">⚙</button>
    <div class="settings-panel" id="settings-panel" hidden>
      <div class="settings-title">Settings</div>
      <label class="settings-label" for="settings-path">Folder</label>
      <div class="settings-row">
        <div class="settings-path" id="settings-path" title="">No folder selected</div>
        <button type="button" class="settings-btn" id="settings-browse">Browse…</button>
      </div>
      <div class="settings-row settings-row-actions">
        <button type="button" class="settings-btn settings-btn-primary" id="settings-scan" disabled>Scan</button>
      </div>
      <label class="settings-label" for="settings-nav-mode">Default mode — next item shows</label>
      <div class="settings-row">
        <select class="settings-select" id="settings-nav-mode" aria-label="Navigation mode">
          <option value="alpha">Alphabetical</option>
          <option value="random_root">Random (whole library)</option>
          <option value="random_current_dir">Random (current folder)</option>
        </select>
      </div>
      <p class="settings-hint" id="settings-hint">Left/Right arrows or click · Right-click = next</p>
    </div>
  `;
  root.appendChild(chrome);

  gearBtn = chrome.querySelector("#settings-gear");
  panel = chrome.querySelector("#settings-panel");
  pathEl = chrome.querySelector("#settings-path");
  scanBtn = chrome.querySelector("#settings-scan");
  navModeSelect = chrome.querySelector("#settings-nav-mode");
  const browseBtn = chrome.querySelector<HTMLButtonElement>("#settings-browse");

  gearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });

  browseBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void onBrowse();
  });

  scanBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void onScan();
  });

  navModeSelect?.addEventListener("change", () => {
    const value = navModeSelect?.value as NavMode;
    void setNavMode(value);
    setStatus(`Nav mode: ${labelForMode(value)}`, true);
    window.setTimeout(() => setStatus("", false), 2000);
  });

  // Keep panel open when interacting inside it
  panel?.addEventListener("click", (e) => e.stopPropagation());

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!panel || panel.hidden) return;
    const t = e.target as Node;
    if (chrome.contains(t)) return;
    panel.hidden = true;
  });

  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await loadNavMode();
  await restoreLastRoot();
}

async function loadNavMode(): Promise<void> {
  try {
    const raw = await settingsGet("nav_mode");
    const mode = parseNavMode(raw);
    state.navMode = mode;
    if (navModeSelect) navModeSelect.value = mode;
  } catch (err) {
    console.warn("load nav_mode failed", err);
    state.navMode = "alpha";
    if (navModeSelect) navModeSelect.value = "alpha";
  }
}

function togglePanel(): void {
  if (!panel) return;
  panel.hidden = !panel.hidden;
}

function updatePathDisplay(root: RootInfo | null): void {
  if (!pathEl || !scanBtn) return;
  if (!root) {
    pathEl.textContent = "No folder selected";
    pathEl.title = "";
    pathEl.classList.add("is-empty");
    scanBtn.disabled = true;
    scanBtn.textContent = "Scan";
    return;
  }
  pathEl.textContent = root.path;
  pathEl.title = root.path;
  pathEl.classList.remove("is-empty");
  scanBtn.disabled = state.scanning;
  // Scan if never scanned / no items; Re-scan if already present
  scanBtn.textContent = root.needsScan ? "Scan" : "Re-scan";
}

/**
 * Restore last root from DB (active_root_id / root_usage).
 * Loads existing library only — no automatic re-scan.
 */
async function restoreLastRoot(): Promise<void> {
  try {
    const root = await getLastRoot();
    state.root = root;
    updatePathDisplay(root);
    if (!root) {
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_root");
      return;
    }
    if (root.itemCount === 0) {
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_media");
      setStatus(
        root.needsScan
          ? "Folder ready — press Scan"
          : "No media in library — try Re-scan",
        true,
      );
      return;
    }
    showEmpty("loading");

    // Prefer last_media_id when still in this root; else first alpha item.
    const item = await resolveStartupMedia(root);
    if (!item) {
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_media");
      return;
    }
    await jumpToMedia(item);
  } catch (err) {
    console.error(err);
    clearHistory();
    setCurrentMedia(null);
    showEmpty("no_root");
    setStatus(`Failed to restore root: ${formatErr(err)}`, true);
  }
}

async function resolveStartupMedia(root: RootInfo): Promise<MediaItem | null> {
  try {
    const raw = await settingsGet("last_media_id");
    if (raw) {
      let id: number | null = null;
      try {
        id = JSON.parse(raw) as number | null;
      } catch {
        const n = Number(raw);
        id = Number.isFinite(n) ? n : null;
      }
      if (id != null) {
        const item = await getMedia(id);
        if (item && item.rootDirId === root.id && !item.isMissing) {
          return item;
        }
      }
    }
  } catch (err) {
    console.warn("last_media_id restore failed", err);
  }
  return getFirstMedia(root.id);
}

async function onBrowse(): Promise<void> {
  try {
    const path = await pickFolder();
    if (!path) return;

    // Only keep prior root id when the path is unchanged; never pair a new path with an old id.
    const samePath = state.root?.path === path;
    state.root = {
      id: samePath && state.root ? state.root.id : -1,
      path,
      lastScanned: samePath ? (state.root?.lastScanned ?? null) : null,
      itemCount: samePath ? (state.root?.itemCount ?? 0) : 0,
      needsScan: samePath ? (state.root?.needsScan ?? true) : true,
    };
    updatePathDisplay(state.root);
    if (!samePath) {
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_media");
      setStatus("Folder selected — press Scan", true);
    }
  } catch (err) {
    setStatus(`Folder pick failed: ${formatErr(err)}`, true);
  }
}

async function onScan(): Promise<void> {
  const path = state.root?.path;
  if (!path || state.scanning) return;

  // Remember media before clearing stage so a failed re-scan can restore it.
  const previousMedia: MediaItem | null = state.currentMedia
    ? { ...state.currentMedia }
    : null;

  state.scanning = true;
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning…";
  }
  showEmpty("loading");
  setStatus("Scanning…", true);

  try {
    const result = await scanRoot(path);
    const info = await getRootInfo(result.rootId);
    state.root = info;
    updatePathDisplay(info);

    setStatus(
      `Scan done · ${result.upserted} media (${result.missingMarked} missing flagged)`,
      true,
    );

    if (!info || info.itemCount === 0) {
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_media");
      return;
    }

    const first = await getFirstMedia(info.id);
    if (!first) {
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_media");
      return;
    }
    // Direct jump after scan: reset history to [id]
    await jumpToMedia(first);
    window.setTimeout(() => setStatus(first.filename, true), 50);
    window.setTimeout(() => setStatus("", false), 4000);
  } catch (err) {
    console.error(err);
    setStatus(`Scan failed: ${formatErr(err)}`, true);
    if (previousMedia) {
      await jumpToMedia(previousMedia);
    } else if (state.root && state.root.itemCount > 0 && state.root.id > 0) {
      showEmpty("error");
    } else {
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_media");
    }
  } finally {
    state.scanning = false;
    updatePathDisplay(state.root);
  }
}

function labelForMode(mode: NavMode): string {
  switch (mode) {
    case "alpha":
      return "Alphabetical";
    case "random_root":
      return "Random (library)";
    case "random_current_dir":
      return "Random (folder)";
  }
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

/** Open settings panel (e.g. from empty-state CTA later). */
export function openSettingsPanel(): void {
  if (panel) panel.hidden = false;
}
