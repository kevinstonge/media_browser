/**
 * Root library folder: select + scan / re-scan modals and cold-start restore.
 * Opened from the toolbar (folder+gear control left of the in-library folder picker).
 *
 * Scan is a single backend invoke. Progress is a throttled file count event
 * (~4/s) so the UI can update without per-file IPC overhead.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getFirstMedia,
  getLastRoot,
  getMedia,
  getRootByPath,
  getRootInfo,
  pickFolder,
  scanRoot,
  settingsGet,
  type MediaItem,
  type RootInfo,
  type ScanProgress,
  type ScanResult,
} from "../api";
import { jumpToMedia } from "../nav";
import {
  clearHistory,
  setCurrentMedia,
  state,
} from "../state";
import {
  refreshToolbarChrome,
  stopSlideshow,
} from "./slideshow";
import { showEmpty } from "./stage";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let overlay: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let footerEl: HTMLElement | null = null;

/** Modal mode: select UI vs rescan confirm UI. */
type ModalMode = "select" | "rescan" | null;
let mode: ModalMode = null;

/** Path chosen in the select modal (may not be scanned yet). */
let pendingPath: string | null = null;

/**
 * Known library info for the pending path (from DB lookup or current root).
 * Used for Scan vs Re-scan button label.
 */
let pendingRootInfo: RootInfo | null = null;

/** Generation token so stale async lookups don't rewrite a newer modal UI. */
let selectUiGen = 0;

export function mountRootFolder(root: HTMLElement, statusFn: StatusFn): void {
  setStatus = statusFn;

  overlay = document.createElement("div");
  overlay.id = "root-folder-modal";
  overlay.className = "root-folder-overlay nav-exclude";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Root folder");
  overlay.innerHTML = `
    <div class="root-folder-card">
      <div class="root-folder-header">
        <div class="root-folder-title" id="root-folder-title">Root folder</div>
        <button
          type="button"
          class="settings-btn settings-btn-tiny root-folder-close"
          id="root-folder-close"
          title="Close"
          aria-label="Close"
        >×</button>
      </div>
      <div class="root-folder-body" id="root-folder-body"></div>
      <div class="root-folder-footer" id="root-folder-footer"></div>
    </div>
  `;
  root.appendChild(overlay);

  titleEl = overlay.querySelector("#root-folder-title");
  bodyEl = overlay.querySelector("#root-folder-body");
  footerEl = overlay.querySelector("#root-folder-footer");
  const closeBtn = overlay.querySelector<HTMLButtonElement>("#root-folder-close");
  const card = overlay.querySelector<HTMLElement>(".root-folder-card");

  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    tryClose();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) tryClose();
  });
  card?.addEventListener("click", (e) => e.stopPropagation());
  card?.addEventListener("mousedown", (e) => e.stopPropagation());
}

export function isRootFolderModalOpen(): boolean {
  return Boolean(overlay && !overlay.hidden);
}

/** Cold start: restore last root from DB (no automatic re-scan). */
export async function restoreLastRoot(): Promise<void> {
  try {
    const root = await getLastRoot();
    state.root = root;
    if (!root) {
      stopSlideshow();
      clearHistory();
      setCurrentMedia(null);
      refreshToolbarChrome();
      showEmpty("no_root");
      return;
    }
    if (root.itemCount === 0) {
      stopSlideshow();
      clearHistory();
      setCurrentMedia(null);
      refreshToolbarChrome();
      showEmpty("no_media");
      setStatus(
        root.needsScan
          ? "Folder ready — select root folder to Scan"
          : "No media in library — try Re-scan root folder",
        true,
      );
      return;
    }
    showEmpty("loading");

    const item = await resolveStartupMedia(root);
    if (!item) {
      stopSlideshow();
      clearHistory();
      setCurrentMedia(null);
      refreshToolbarChrome();
      showEmpty("no_media");
      return;
    }
    await jumpToMedia(item);
  } catch (err) {
    console.error(err);
    stopSlideshow();
    clearHistory();
    setCurrentMedia(null);
    refreshToolbarChrome();
    showEmpty("no_root");
    setStatus(`Failed to restore root: ${formatErr(err)}`, true);
  }
}

export function openSelectRootFolderModal(): void {
  if (!overlay || !titleEl || !bodyEl || !footerEl) return;
  if (state.scanning) {
    setStatus("Scan already in progress", true);
    window.setTimeout(() => setStatus("", false), 2000);
    return;
  }
  mode = "select";
  pendingPath = state.root?.path ?? null;
  pendingRootInfo = state.root && state.root.id > 0 ? state.root : null;
  titleEl.textContent = "Select root folder";
  overlay.hidden = false;
  void renderSelectUi();
}

export function openRescanRootFolderModal(): void {
  if (!overlay || !titleEl || !bodyEl || !footerEl) return;
  if (state.scanning) {
    setStatus("Scan already in progress", true);
    window.setTimeout(() => setStatus("", false), 2000);
    return;
  }
  const path = state.root?.path;
  if (!path) {
    // No root yet — guide user to select instead.
    openSelectRootFolderModal();
    setStatus("No root folder yet — choose one first", true);
    window.setTimeout(() => setStatus("", false), 2500);
    return;
  }
  mode = "rescan";
  pendingPath = path;
  pendingRootInfo = state.root;
  titleEl.textContent = "Re-scan root folder";
  overlay.hidden = false;
  renderRescanReady();
}

export function handleRootFolderKey(e: KeyboardEvent): boolean {
  if (!isRootFolderModalOpen()) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    tryClose();
    return true;
  }
  return false;
}

function tryClose(): void {
  if (state.scanning) {
    // Don't abandon an in-flight scan UI; scan still finishes in the background.
    setStatus("Wait for scan to finish…", true);
    window.setTimeout(() => setStatus("", false), 2000);
    return;
  }
  hideModal();
}

function hideModal(): void {
  if (!overlay) return;
  overlay.hidden = true;
  mode = null;
  pendingPath = null;
  pendingRootInfo = null;
  selectUiGen += 1;
  if (bodyEl) bodyEl.innerHTML = "";
  if (footerEl) footerEl.innerHTML = "";
}

/** True when this path was scanned before → primary button should say Re-scan. */
function pathWasPreviouslyScanned(info: RootInfo | null): boolean {
  if (!info) return false;
  // lastScanned set means a prior successful scan completed for this root.
  if (info.lastScanned) return true;
  // Fallback: needsScan false is the app's established Re-scan label signal.
  return !info.needsScan;
}

function scanButtonLabel(info: RootInfo | null): string {
  return pathWasPreviouslyScanned(info) ? "Re-scan" : "Scan";
}

async function resolvePendingRootInfo(path: string | null): Promise<RootInfo | null> {
  if (!path) return null;
  // Fast path: current in-memory root matches.
  if (state.root?.path && pathsEqual(state.root.path, path) && state.root.id > 0) {
    return state.root;
  }
  if (pendingRootInfo?.path && pathsEqual(pendingRootInfo.path, path) && pendingRootInfo.id > 0) {
    return pendingRootInfo;
  }
  try {
    return await getRootByPath(path);
  } catch (err) {
    console.warn("get_root_by_path failed", err);
    return null;
  }
}

async function renderSelectUi(): Promise<void> {
  if (!bodyEl || !footerEl || mode !== "select") return;
  const gen = ++selectUiGen;

  const path = pendingPath;
  const pathDisplay = path ?? "No folder selected";
  const pathEmpty = !path;

  // Resolve known root for label (async); start with best-known info.
  let info = pendingRootInfo;
  if (path) {
    // Optimistic label from cached info while we await DB.
    if (!info || !pathsEqual(info.path, path)) {
      info =
        state.root?.path && pathsEqual(state.root.path, path) && state.root.id > 0
          ? state.root
          : null;
    }
  } else {
    info = null;
  }

  bodyEl.innerHTML = `
    <label class="settings-label" for="root-folder-path">Folder</label>
    <div class="settings-row root-folder-path-row">
      <div
        class="settings-path${pathEmpty ? " is-empty" : ""}"
        id="root-folder-path"
        title="${escapeAttr(path ?? "")}"
      >${escapeHtml(pathDisplay)}</div>
      <button type="button" class="settings-btn" id="root-folder-browse">Browse…</button>
    </div>
    <p class="settings-hint">Choose a library root, then Scan to index images and videos in each first-level subfolder.</p>
    <div class="root-folder-status" id="root-folder-status" hidden></div>
  `;

  footerEl.innerHTML = `
    <button
      type="button"
      class="settings-btn settings-btn-primary"
      id="root-folder-scan"
      ${!path || state.scanning ? "disabled" : ""}
    >${escapeHtml(scanButtonLabel(info))}</button>
  `;

  bodyEl.querySelector("#root-folder-browse")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void onBrowse();
  });
  footerEl.querySelector("#root-folder-scan")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pendingPath) return;
    void runScan(pendingPath, "select");
  });

  // Refine label from DB once lookup returns.
  if (path) {
    const lookedUp = await resolvePendingRootInfo(path);
    if (gen !== selectUiGen || mode !== "select") return;
    pendingRootInfo = lookedUp;
    const btn = footerEl.querySelector<HTMLButtonElement>("#root-folder-scan");
    if (btn) btn.textContent = scanButtonLabel(lookedUp);
  }
}

function renderSelectScanning(): void {
  if (!bodyEl || !footerEl) return;
  const path = pendingPath ?? "";
  const label = pathWasPreviouslyScanned(pendingRootInfo) ? "Re-scanning…" : "Scanning…";
  bodyEl.innerHTML = `
    <div class="root-folder-status-block" role="status" aria-live="polite">
      <div class="root-folder-spinner" aria-hidden="true"></div>
      <div class="root-folder-status-text">${escapeHtml(label)}</div>
      <div class="root-folder-status-progress" id="root-folder-scan-progress">Progress: 0 files</div>
      <div class="root-folder-status-path" title="${escapeAttr(path)}">${escapeHtml(path)}</div>
    </div>
  `;
  footerEl.innerHTML = `
    <button type="button" class="settings-btn settings-btn-primary" disabled>${escapeHtml(label)}</button>
  `;
}

/** Rescan modal: show path + confirm button; does not start until the user clicks. */
function renderRescanReady(): void {
  if (!bodyEl || !footerEl) return;
  const path = pendingPath ?? state.root?.path ?? "";
  const count = state.root?.itemCount;
  const last = state.root?.lastScanned;

  bodyEl.innerHTML = `
    <div class="root-folder-status-block" role="status">
      <div class="root-folder-status-text">Re-scan root folder</div>
      <div class="root-folder-status-detail">
        Index first-level subfolders again (files only; nested folders skipped).
        ${
          count != null
            ? `<br />Currently ${escapeHtml(String(count))} media in library.`
            : ""
        }
        ${
          last
            ? `<br />Last scanned: ${escapeHtml(last)}`
            : ""
        }
      </div>
      <div class="root-folder-status-path" title="${escapeAttr(path)}">${escapeHtml(path)}</div>
    </div>
  `;
  footerEl.innerHTML = `
    <button
      type="button"
      class="settings-btn settings-btn-primary"
      id="root-folder-rescan"
      ${!path || state.scanning ? "disabled" : ""}
    >Re-scan</button>
  `;
  footerEl.querySelector("#root-folder-rescan")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!path) return;
    void runScan(path, "rescan");
  });
}

function renderRescanScanning(): void {
  if (!bodyEl || !footerEl) return;
  const path = pendingPath ?? state.root?.path ?? "";
  bodyEl.innerHTML = `
    <div class="root-folder-status-block" role="status" aria-live="polite">
      <div class="root-folder-spinner" aria-hidden="true"></div>
      <div class="root-folder-status-text">Re-scanning root folder…</div>
      <div class="root-folder-status-progress" id="root-folder-scan-progress">Progress: 0 files</div>
      <div class="root-folder-status-path" title="${escapeAttr(path)}">${escapeHtml(path)}</div>
    </div>
  `;
  footerEl.innerHTML = `
    <button type="button" class="settings-btn settings-btn-primary" disabled>Re-scanning…</button>
  `;
}

function formatFileCount(n: number): string {
  return n.toLocaleString();
}

/** Update modal + status bar from a throttled backend progress event. */
function applyScanProgress(files: number): void {
  const label = `Progress: ${formatFileCount(files)} files`;
  const el = bodyEl?.querySelector<HTMLElement>("#root-folder-scan-progress");
  if (el) el.textContent = label;
  setStatus(label, true);
}

function renderSuccess(result: ScanResult, info: RootInfo | null): void {
  if (!bodyEl || !footerEl) return;
  const count = info?.itemCount ?? result.upserted;
  bodyEl.innerHTML = `
    <div class="root-folder-status-block root-folder-status-ok" role="status" aria-live="polite">
      <div class="root-folder-status-icon" aria-hidden="true">✓</div>
      <div class="root-folder-status-text">Scan complete</div>
      <div class="root-folder-status-detail">
        ${escapeHtml(String(result.upserted))} media indexed
        · ${escapeHtml(String(result.missingMarked))} missing flagged
        · ${escapeHtml(String(count))} in library
      </div>
      <div class="root-folder-status-path" title="${escapeAttr(result.rootPath)}">${escapeHtml(result.rootPath)}</div>
    </div>
  `;
  footerEl.innerHTML = `
    <button type="button" class="settings-btn settings-btn-primary" id="root-folder-ok">OK</button>
  `;
  footerEl.querySelector("#root-folder-ok")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hideModal();
  });
}

function renderError(message: string): void {
  if (!bodyEl || !footerEl) return;
  bodyEl.innerHTML = `
    <div class="root-folder-status-block root-folder-status-err" role="alert" aria-live="assertive">
      <div class="root-folder-status-icon" aria-hidden="true">!</div>
      <div class="root-folder-status-text">Scan failed</div>
      <div class="root-folder-status-detail">${escapeHtml(message)}</div>
    </div>
  `;
  const retryPath = pendingPath;
  const retryLabel = mode === "rescan" || pathWasPreviouslyScanned(pendingRootInfo)
    ? "Retry re-scan"
    : "Retry";
  footerEl.innerHTML = `
    ${
      retryPath
        ? `<button type="button" class="settings-btn" id="root-folder-retry">${escapeHtml(retryLabel)}</button>`
        : ""
    }
    <button type="button" class="settings-btn settings-btn-primary" id="root-folder-ok">OK</button>
  `;
  footerEl.querySelector("#root-folder-ok")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hideModal();
  });
  footerEl.querySelector("#root-folder-retry")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!retryPath) return;
    void runScan(retryPath, mode === "rescan" ? "rescan" : "select");
  });
}

async function onBrowse(): Promise<void> {
  try {
    const path = await pickFolder();
    if (!path) return;

    const samePath = state.root?.path != null && pathsEqual(state.root.path, path);
    pendingPath = path;

    // Look up prior scan state for this path (Scan vs Re-scan label).
    let lookedUp: RootInfo | null = null;
    try {
      lookedUp = await getRootByPath(path);
    } catch (err) {
      console.warn("get_root_by_path after browse failed", err);
    }
    pendingRootInfo = lookedUp;

    // Stash selected path in state so Scan can run; only keep prior id when path unchanged
    // or when DB already has this root.
    if (lookedUp) {
      state.root = lookedUp;
    } else {
      state.root = {
        id: samePath && state.root ? state.root.id : -1,
        path,
        lastScanned: samePath ? (state.root?.lastScanned ?? null) : null,
        itemCount: samePath ? (state.root?.itemCount ?? 0) : 0,
        needsScan: samePath ? (state.root?.needsScan ?? true) : true,
      };
    }

    if (!samePath) {
      stopSlideshow();
      clearHistory();
      setCurrentMedia(null);
      refreshToolbarChrome();
      showEmpty(lookedUp && lookedUp.itemCount > 0 ? "loading" : "no_media");
      // If this root already has a library, jump to first item without re-scanning.
      if (lookedUp && lookedUp.itemCount > 0) {
        try {
          const first = await getFirstMedia(lookedUp.id);
          if (first) await jumpToMedia(first);
          else showEmpty("no_media");
        } catch {
          showEmpty("no_media");
        }
      } else {
        setStatus(
          pathWasPreviouslyScanned(lookedUp)
            ? "Folder selected — press Re-scan to refresh"
            : "Folder selected — press Scan",
          true,
        );
      }
    }

    if (mode === "select") {
      await renderSelectUi();
    }
  } catch (err) {
    setStatus(`Folder pick failed: ${formatErr(err)}`, true);
    if (mode === "select" && bodyEl) {
      const status = bodyEl.querySelector<HTMLElement>("#root-folder-status");
      if (status) {
        status.hidden = false;
        status.className = "root-folder-status root-folder-status-err";
        status.textContent = formatErr(err);
      }
    }
  }
}

async function runScan(path: string, scanMode: "select" | "rescan"): Promise<void> {
  if (!path || state.scanning) return;

  const previousMedia: MediaItem | null = state.currentMedia
    ? { ...state.currentMedia }
    : null;

  stopSlideshow();
  state.scanning = true;
  refreshToolbarChrome();

  if (scanMode === "select") {
    renderSelectScanning();
  } else {
    renderRescanScanning();
  }
  // Stage shows loading while library is being rebuilt.
  showEmpty("loading");
  setStatus("Progress: 0 files", true);

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<ScanProgress>("scan-progress", (event) => {
      applyScanProgress(event.payload.files);
    });

    const result = await scanRoot(path);
    const info = await getRootInfo(result.rootId);
    state.root = info;
    pendingPath = info?.path ?? result.rootPath;
    pendingRootInfo = info;

    setStatus(
      `Scan done · ${result.upserted} media (${result.missingMarked} missing flagged)`,
      true,
    );

    renderSuccess(result, info);

    if (!info || info.itemCount === 0) {
      clearHistory();
      setCurrentMedia(null);
      refreshToolbarChrome();
      showEmpty("no_media");
      return;
    }

    const first = await getFirstMedia(info.id);
    if (!first) {
      clearHistory();
      setCurrentMedia(null);
      refreshToolbarChrome();
      showEmpty("no_media");
      return;
    }
    await jumpToMedia(first);
    window.setTimeout(() => setStatus("", false), 4000);
  } catch (err) {
    console.error(err);
    const msg = formatErr(err);
    setStatus(`Scan failed: ${msg}`, true);
    renderError(msg);
    if (previousMedia) {
      await jumpToMedia(previousMedia);
    } else if (state.root && state.root.itemCount > 0 && state.root.id > 0) {
      showEmpty("error");
    } else {
      clearHistory();
      setCurrentMedia(null);
      refreshToolbarChrome();
      showEmpty("no_media");
    }
  } finally {
    if (unlisten) {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
    }
    state.scanning = false;
    refreshToolbarChrome();
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

function pathsEqual(a: string, b: string): boolean {
  return (
    a.replace(/[/\\]+$/, "").toLowerCase() === b.replace(/[/\\]+$/, "").toLowerCase()
  );
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
