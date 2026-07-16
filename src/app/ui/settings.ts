/**
 * Settings overlay: folder path, Scan / Re-scan, browse + slideshow nav modes,
 * duration, and global tag manager (create/delete + badge/sound assets).
 */

import {
  addTagAsset,
  createTag,
  deleteTag,
  getFirstMedia,
  getLastRoot,
  getMedia,
  getRootInfo,
  listTags,
  pickFile,
  pickFolder,
  removeTagAsset,
  scanRoot,
  settingsGet,
  type MediaItem,
  type RootInfo,
  type Tag,
} from "../api";
import {
  jumpToMedia,
  parseNavMode,
  setNavMode,
  setSlideshowDurationSec,
  setSlideshowNavMode,
} from "../nav";
import {
  clampSlideshowDurationSec,
  clearHistory,
  DEFAULT_SLIDESHOW_DURATION_SEC,
  setCurrentMedia,
  state,
  type NavMode,
} from "../state";
import { showEmpty } from "./stage";
import { onSlideshowSettingsChanged, stopSlideshow } from "./slideshow";
import {
  refreshVocabulary,
  reloadCurrentItemTags,
  setTagVocabularyListener,
} from "./tags";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let panel: HTMLElement | null = null;
let pathEl: HTMLElement | null = null;
let scanBtn: HTMLButtonElement | null = null;
let gearBtn: HTMLButtonElement | null = null;
let navModeSelect: HTMLSelectElement | null = null;
let slideshowNavModeSelect: HTMLSelectElement | null = null;
let slideshowDurationInput: HTMLInputElement | null = null;
let tagManagerList: HTMLElement | null = null;
let tagCreateInput: HTMLInputElement | null = null;
let settingsTags: Tag[] = [];

const NAV_MODE_OPTIONS = `
  <option value="alpha">Alphabetical</option>
  <option value="random_root">Random (whole library)</option>
  <option value="random_current_dir">Random (current folder)</option>
`;

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
          ${NAV_MODE_OPTIONS}
        </select>
      </div>
      <label class="settings-label" for="settings-slideshow-nav-mode">Slideshow — next item shows</label>
      <div class="settings-row">
        <select class="settings-select" id="settings-slideshow-nav-mode" aria-label="Slideshow navigation mode">
          ${NAV_MODE_OPTIONS}
        </select>
      </div>
      <label class="settings-label" for="settings-slideshow-duration">Slideshow duration (seconds)</label>
      <div class="settings-row">
        <input
          type="number"
          class="settings-input"
          id="settings-slideshow-duration"
          min="1"
          max="3600"
          step="1"
          value="${DEFAULT_SLIDESHOW_DURATION_SEC}"
          aria-label="Slideshow duration in seconds"
        />
      </div>
      <div class="settings-section-title">Tags</div>
      <div class="settings-row">
        <input
          type="text"
          class="settings-input"
          id="settings-tag-create"
          placeholder="New tag name"
          maxlength="64"
          aria-label="Create tag"
        />
        <button type="button" class="settings-btn" id="settings-tag-create-btn">Create</button>
      </div>
      <div class="settings-tag-list" id="settings-tag-list" role="list"></div>
      <p class="settings-hint" id="settings-hint">Left/Right arrows or click · Right-click = next</p>
    </div>
  `;
  root.appendChild(chrome);

  gearBtn = chrome.querySelector("#settings-gear");
  panel = chrome.querySelector("#settings-panel");
  pathEl = chrome.querySelector("#settings-path");
  scanBtn = chrome.querySelector("#settings-scan");
  navModeSelect = chrome.querySelector("#settings-nav-mode");
  slideshowNavModeSelect = chrome.querySelector("#settings-slideshow-nav-mode");
  slideshowDurationInput = chrome.querySelector("#settings-slideshow-duration");
  tagManagerList = chrome.querySelector("#settings-tag-list");
  tagCreateInput = chrome.querySelector("#settings-tag-create");
  const tagCreateBtn = chrome.querySelector<HTMLButtonElement>("#settings-tag-create-btn");
  const browseBtn = chrome.querySelector<HTMLButtonElement>("#settings-browse");

  setTagVocabularyListener(() => {
    void refreshTagManager();
  });

  gearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
    if (panel && !panel.hidden) {
      void refreshTagManager();
    }
  });

  tagCreateBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void onCreateTagFromSettings();
  });
  tagCreateInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void onCreateTagFromSettings();
    }
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

  slideshowNavModeSelect?.addEventListener("change", () => {
    const value = slideshowNavModeSelect?.value as NavMode;
    void setSlideshowNavMode(value);
    onSlideshowSettingsChanged();
    setStatus(`Slideshow mode: ${labelForMode(value)}`, true);
    window.setTimeout(() => setStatus("", false), 2000);
  });

  slideshowDurationInput?.addEventListener("change", () => {
    void onDurationChange();
  });
  slideshowDurationInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void onDurationChange();
      (e.target as HTMLInputElement).blur();
    }
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

async function onDurationChange(): Promise<void> {
  if (!slideshowDurationInput) return;
  const clamped = clampSlideshowDurationSec(slideshowDurationInput.value);
  slideshowDurationInput.value = String(clamped);
  await setSlideshowDurationSec(clamped);
  onSlideshowSettingsChanged();
  setStatus(`Slideshow duration: ${clamped}s`, true);
  window.setTimeout(() => setStatus("", false), 2000);
}

async function bootstrap(): Promise<void> {
  await loadSettings();
  await restoreLastRoot();
}

async function loadSettings(): Promise<void> {
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

  try {
    const raw = await settingsGet("slideshow_nav_mode");
    const mode = parseNavMode(raw);
    state.slideshowNavMode = mode;
    if (slideshowNavModeSelect) slideshowNavModeSelect.value = mode;
  } catch (err) {
    console.warn("load slideshow_nav_mode failed", err);
    state.slideshowNavMode = "alpha";
    if (slideshowNavModeSelect) slideshowNavModeSelect.value = "alpha";
  }

  try {
    const raw = await settingsGet("slideshow_duration_sec");
    let value: unknown = raw;
    if (raw != null) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    const sec = clampSlideshowDurationSec(value ?? DEFAULT_SLIDESHOW_DURATION_SEC);
    state.slideshowDurationSec = sec;
    if (slideshowDurationInput) slideshowDurationInput.value = String(sec);
  } catch (err) {
    console.warn("load slideshow_duration_sec failed", err);
    state.slideshowDurationSec = DEFAULT_SLIDESHOW_DURATION_SEC;
    if (slideshowDurationInput) {
      slideshowDurationInput.value = String(DEFAULT_SLIDESHOW_DURATION_SEC);
    }
  }
}

function togglePanel(): void {
  if (!panel) return;
  panel.hidden = !panel.hidden;
}

async function refreshTagManager(): Promise<void> {
  try {
    settingsTags = await listTags();
  } catch (err) {
    console.warn("list_tags (settings) failed", err);
    settingsTags = [];
  }
  renderTagManager();
}

function renderTagManager(): void {
  if (!tagManagerList) return;
  tagManagerList.innerHTML = "";

  if (settingsTags.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-tag-empty";
    empty.textContent = "No tags yet — create one above.";
    tagManagerList.appendChild(empty);
    return;
  }

  for (const tag of settingsTags) {
    tagManagerList.appendChild(buildTagCard(tag));
  }
}

function buildTagCard(tag: Tag): HTMLElement {
  const card = document.createElement("div");
  card.className = "settings-tag-card";
  card.setAttribute("role", "listitem");
  card.dataset.tagId = String(tag.id);

  const header = document.createElement("div");
  header.className = "settings-tag-card-header";

  const name = document.createElement("span");
  name.className = "settings-tag-name";
  name.textContent = tag.name;

  const del = document.createElement("button");
  del.type = "button";
  del.className = "settings-btn settings-btn-danger";
  del.textContent = "Delete";
  del.title = `Delete tag “${tag.name}”`;
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    void onDeleteTag(tag);
  });

  header.appendChild(name);
  header.appendChild(del);
  card.appendChild(header);

  card.appendChild(
    buildAssetSection(tag, "image", "Badge images", "Add image…"),
  );
  card.appendChild(
    buildAssetSection(tag, "sound", "Sounds", "Add sound…"),
  );

  return card;
}

function buildAssetSection(
  tag: Tag,
  assetType: "image" | "sound",
  label: string,
  addLabel: string,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "settings-tag-assets";

  const lab = document.createElement("div");
  lab.className = "settings-tag-assets-label";
  lab.textContent = label;
  section.appendChild(lab);

  const assets = (tag.assets ?? []).filter((a) => a.assetType === assetType);
  if (assets.length === 0) {
    const none = document.createElement("div");
    none.className = "settings-tag-asset-empty";
    none.textContent = "None";
    section.appendChild(none);
  } else {
    for (const asset of assets) {
      const row = document.createElement("div");
      row.className = "settings-tag-asset-row";

      const path = document.createElement("span");
      path.className = "settings-tag-asset-path";
      path.title = asset.path;
      path.textContent = asset.path;

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "settings-btn settings-btn-tiny";
      rm.textContent = "×";
      rm.title = "Remove asset";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        void onRemoveAsset(asset.id);
      });

      row.appendChild(path);
      row.appendChild(rm);
      section.appendChild(row);
    }
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-btn settings-btn-tiny settings-tag-add-asset";
  add.textContent = addLabel;
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    void onAddAsset(tag.id, assetType);
  });
  section.appendChild(add);

  return section;
}

async function onCreateTagFromSettings(): Promise<void> {
  const name = tagCreateInput?.value.trim() ?? "";
  if (!name) return;
  try {
    await createTag(name);
    if (tagCreateInput) tagCreateInput.value = "";
    await refreshTagManager();
    await refreshVocabulary();
    setStatus(`Created tag “${name}”`, true);
    window.setTimeout(() => setStatus("", false), 2000);
  } catch (err) {
    setStatus(`Create tag failed: ${formatErr(err)}`, true);
  }
}

async function onDeleteTag(tag: Tag): Promise<void> {
  const ok = window.confirm(
    `Delete tag “${tag.name}”? This removes it from all media and deletes its assets.`,
  );
  if (!ok) return;
  try {
    await deleteTag(tag.id);
    await refreshTagManager();
    await refreshVocabulary();
    await reloadCurrentItemTags();
    setStatus(`Deleted tag “${tag.name}”`, true);
    window.setTimeout(() => setStatus("", false), 2000);
  } catch (err) {
    setStatus(`Delete tag failed: ${formatErr(err)}`, true);
  }
}

async function onAddAsset(
  tagId: number,
  assetType: "image" | "sound",
): Promise<void> {
  try {
    const path = await pickFile(assetType);
    if (!path) return;
    await addTagAsset(tagId, assetType, path);
    await refreshTagManager();
    await refreshVocabulary();
    await reloadCurrentItemTags();
    setStatus(`Added ${assetType} asset`, true);
    window.setTimeout(() => setStatus("", false), 2000);
  } catch (err) {
    setStatus(`Add asset failed: ${formatErr(err)}`, true);
  }
}

async function onRemoveAsset(assetId: number): Promise<void> {
  try {
    await removeTagAsset(assetId);
    await refreshTagManager();
    await refreshVocabulary();
    await reloadCurrentItemTags();
  } catch (err) {
    setStatus(`Remove asset failed: ${formatErr(err)}`, true);
  }
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
      stopSlideshow();
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_root");
      return;
    }
    if (root.itemCount === 0) {
      stopSlideshow();
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
      stopSlideshow();
      clearHistory();
      setCurrentMedia(null);
      showEmpty("no_media");
      return;
    }
    await jumpToMedia(item);
  } catch (err) {
    console.error(err);
    stopSlideshow();
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
      stopSlideshow();
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

  stopSlideshow();
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
