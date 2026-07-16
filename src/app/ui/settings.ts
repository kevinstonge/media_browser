/**
 * Settings overlay (partial): folder path, Scan / Re-scan.
 */

import {
  getFirstMedia,
  getLastRoot,
  getRootInfo,
  pickFolder,
  scanRoot,
  type MediaItem,
  type RootInfo,
} from "../api";
import { setCurrentMedia, state } from "../state";
import { showEmpty, showMedia } from "./stage";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let panel: HTMLElement | null = null;
let pathEl: HTMLElement | null = null;
let scanBtn: HTMLButtonElement | null = null;
let gearBtn: HTMLButtonElement | null = null;

export function mountSettings(root: HTMLElement, statusFn: StatusFn): void {
  setStatus = statusFn;

  // Gear hit region (top-right)
  const chrome = document.createElement("div");
  chrome.className = "settings-chrome";
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
      <p class="settings-hint" id="settings-hint"></p>
    </div>
  `;
  root.appendChild(chrome);

  gearBtn = chrome.querySelector("#settings-gear");
  panel = chrome.querySelector("#settings-panel");
  pathEl = chrome.querySelector("#settings-path");
  scanBtn = chrome.querySelector("#settings-scan");
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

  // Keep panel open when interacting inside it
  panel?.addEventListener("click", (e) => e.stopPropagation());

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!panel || panel.hidden) return;
    const t = e.target as Node;
    if (chrome.contains(t)) return;
    panel.hidden = true;
  });

  void restoreLastRoot();
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

async function restoreLastRoot(): Promise<void> {
  try {
    const root = await getLastRoot();
    state.root = root;
    updatePathDisplay(root);
    if (!root) {
      showEmpty("no_root");
      return;
    }
    if (root.itemCount === 0) {
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
    const first = await getFirstMedia(root.id);
    if (!first) {
      showEmpty("no_media");
      return;
    }
    setCurrentMedia(first);
    showMedia(first);
    setStatus(`${first.filename}`, true);
    window.setTimeout(() => setStatus("", false), 3000);
  } catch (err) {
    console.error(err);
    showEmpty("no_root");
    setStatus(`Failed to restore root: ${formatErr(err)}`, true);
  }
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
      setCurrentMedia(null);
      showEmpty("no_media");
      return;
    }

    const first = await getFirstMedia(info.id);
    if (!first) {
      setCurrentMedia(null);
      showEmpty("no_media");
      return;
    }
    setCurrentMedia(first);
    showMedia(first);
    window.setTimeout(() => setStatus(first.filename, true), 50);
    window.setTimeout(() => setStatus("", false), 4000);
  } catch (err) {
    console.error(err);
    setStatus(`Scan failed: ${formatErr(err)}`, true);
    if (previousMedia) {
      setCurrentMedia(previousMedia);
      showMedia(previousMedia);
    } else if (state.root && state.root.itemCount > 0 && state.root.id > 0) {
      // Had items but no in-memory media object — leave error empty state.
      showEmpty("error");
    } else {
      showEmpty("no_media");
    }
  } finally {
    state.scanning = false;
    updatePathDisplay(state.root);
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
