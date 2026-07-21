/**
 * Per-item tag editor (toolbar button + checkbox dropdown),
 * top-left badges, and sequential tag-sound queue (no overlap; video audio continues).
 */

import {
  addMediaTag,
  getMedia,
  listTags,
  mediaUrl,
  removeMediaTag,
  type MediaItem,
  type Tag,
  type TagAsset,
} from "../api";
import { state } from "../state";
import { closeToolbarMenus } from "./slideshow";
import { openTagManager } from "./tagManager";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let tagBtn: HTMLButtonElement | null = null;
let tagMenu: HTMLElement | null = null;
let badgesEl: HTMLElement | null = null;

/** Tags currently associated with the active media item. */
let itemTags: Tag[] = [];
/** Full vocabulary for the checkbox list. */
let allTags: Tag[] = [];

/** Bumped when media changes so in-flight sound queues abort. */
let soundGeneration = 0;
let activeAudio: HTMLAudioElement | null = null;
/** Completes the in-flight playOneSound Promise (explicit cancel). */
let soundDone: (() => void) | null = null;

/** Tag ids with an in-flight add/remove (avoid double-toggles). */
const pendingTagIds = new Set<number>();

/** Optional listener when global tag vocabulary changes (tag manager refresh). */
let vocabularyListener: (() => void) | null = null;

export function setTagVocabularyListener(fn: (() => void) | null): void {
  vocabularyListener = fn;
}

/** Notify tag manager (or other UI) that the global tag vocabulary changed. */
export function notifyVocabularyChanged(): void {
  try {
    vocabularyListener?.();
  } catch (err) {
    console.warn("tag vocabulary listener failed", err);
  }
}

/**
 * Mount badge strip on root and tag control into the top toolbar
 * (immediately after the file-selection dropdown).
 * Requires slideshow toolbar to be mounted first.
 */
export function mountTags(root: HTMLElement, statusFn?: StatusFn): void {
  if (statusFn) setStatus = statusFn;

  // Top-left badge strip (always visible when present; not hover chrome)
  badgesEl = document.createElement("div");
  badgesEl.className = "tag-badges nav-exclude";
  badgesEl.setAttribute("aria-label", "Tag badges");
  badgesEl.hidden = true;
  root.appendChild(badgesEl);

  const fileWrap = root.querySelector("#toolbar-file-wrap");
  const toolbarBar = root.querySelector(".slideshow-bar");
  if (!fileWrap || !toolbarBar) {
    console.warn("mountTags: toolbar not found; tag button skipped");
    void refreshVocabulary();
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "toolbar-menu-wrap";
  wrap.id = "toolbar-tag-wrap";
  wrap.innerHTML = `
    <button
      type="button"
      class="toolbar-icon-btn"
      id="toolbar-tag-btn"
      title="Tags"
      aria-label="Tags"
      aria-haspopup="true"
      aria-expanded="false"
    >
      <span class="toolbar-tag-icon" aria-hidden="true">🏷</span>
    </button>
    <div
      class="toolbar-dropdown toolbar-dropdown-tags"
      id="toolbar-tag-menu"
      role="group"
      aria-label="Tags for current file"
      hidden
    ></div>
  `;
  // Insert immediately after the file-selection dropdown.
  fileWrap.insertAdjacentElement("afterend", wrap);

  tagBtn = wrap.querySelector("#toolbar-tag-btn");
  tagMenu = wrap.querySelector("#toolbar-tag-menu");

  tagBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTagMenu();
  });

  // Keep menu open while interacting with checkboxes; block stage nav.
  tagMenu?.addEventListener("click", (e) => e.stopPropagation());
  tagMenu?.addEventListener("mousedown", (e) => e.stopPropagation());

  updateTagButton();
  void refreshVocabulary();
}

/** Reload global tag list (dropdown + after settings changes). */
export async function refreshVocabulary(): Promise<void> {
  try {
    allTags = await listTags();
  } catch (err) {
    console.warn("list_tags failed", err);
    allTags = [];
  }
  if (tagMenu && !tagMenu.hidden) {
    renderTagMenu();
  }
  updateTagButton();
}

/**
 * Stop tag-sound queue and clear badge strip only.
 * Leaves the tag editor control intact (load errors, soft-missing).
 */
export function clearTagPresentation(): void {
  stopTagSounds();
  clearBadges();
}

/**
 * Called whenever the displayed media changes (or fully clears).
 * Stops sound queue, clears badges, loads item tags into the editor.
 *
 * Soft-missing items still show/edit tags (associations live in DB).
 * Badge images + sounds only play when the file is not missing.
 */
export function onMediaDisplayed(item: MediaItem | null): void {
  stopTagSounds();
  clearBadges();
  pendingTagIds.clear();

  if (!item) {
    itemTags = [];
    updateTagButton();
    if (tagMenu && !tagMenu.hidden) renderTagMenu();
    return;
  }

  itemTags = item.tags ? [...item.tags] : [];
  updateTagButton();
  if (tagMenu && !tagMenu.hidden) renderTagMenu();
  if (!item.isMissing) {
    showBadgesAndPlaySounds(itemTags);
  }
}

/** Re-sync after settings mutates tag assets for tags on current item. */
export async function reloadCurrentItemTags(): Promise<void> {
  const id = state.currentMediaId;
  if (id == null) {
    onMediaDisplayed(null);
    return;
  }
  try {
    const item = await getMedia(id);
    if (item && state.currentMediaId === id) {
      // Keep stage media; only refresh tags / badges / sounds.
      if (state.currentMedia) {
        state.currentMedia.tags = item.tags;
      }
      onMediaDisplayed(item);
    }
  } catch (err) {
    console.warn("reloadCurrentItemTags failed", err);
  }
}

function stopTagSounds(): void {
  soundGeneration += 1;
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.removeAttribute("src");
      activeAudio.load();
    } catch {
      /* ignore */
    }
    activeAudio = null;
  }
  // Explicitly settle the in-flight playOneSound Promise (ISSUE-2).
  if (soundDone) {
    const finish = soundDone;
    soundDone = null;
    finish();
  }
}

function clearBadges(): void {
  if (!badgesEl) return;
  badgesEl.innerHTML = "";
  badgesEl.hidden = true;
}

function showBadgesAndPlaySounds(tags: Tag[]): void {
  const images: TagAsset[] = [];
  const sounds: TagAsset[] = [];

  // Preserve tag list order; within each tag, assets already sorted by sort_order.
  for (const tag of tags) {
    for (const asset of tag.assets ?? []) {
      if (asset.assetType === "image") images.push(asset);
      else if (asset.assetType === "sound") sounds.push(asset);
    }
  }

  if (badgesEl && images.length > 0) {
    badgesEl.hidden = false;
    for (const img of images) {
      const el = document.createElement("img");
      el.className = "tag-badge-img";
      el.src = mediaUrl(img.path);
      el.alt = "";
      el.draggable = false;
      el.title = img.path;
      el.addEventListener("error", () => {
        el.classList.add("tag-badge-missing");
      });
      badgesEl.appendChild(el);
    }
  }

  if (sounds.length > 0) {
    void playSoundsSequentially(sounds.map((s) => s.path));
  }
}

async function playSoundsSequentially(paths: string[]): Promise<void> {
  const gen = soundGeneration;
  for (const path of paths) {
    if (gen !== soundGeneration) return;
    await playOneSound(path, gen);
  }
}

function playOneSound(path: string, gen: number): Promise<void> {
  return new Promise((resolve) => {
    if (gen !== soundGeneration) {
      resolve();
      return;
    }
    const audio = new Audio(mediaUrl(path));
    activeAudio = audio;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (activeAudio === audio) activeAudio = null;
      if (soundDone === done) soundDone = null;
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      audio.removeEventListener("abort", done);
      audio.removeEventListener("emptied", done);
      resolve();
    };
    soundDone = done;
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    audio.addEventListener("abort", done);
    audio.addEventListener("emptied", done);
    void audio.play().catch(() => done());
  });
}

function updateTagButton(): void {
  if (!tagBtn) return;
  // Always enabled so Manage tags stays reachable without a selected file.
  const hasMedia = state.currentMediaId != null;
  const n = itemTags.length;
  const label = n > 0 ? `Tags (${n})` : "Tags";
  tagBtn.title = hasMedia ? label : "Tags (manage or select a file)";
  tagBtn.setAttribute("aria-label", label);
  tagBtn.classList.toggle("toolbar-tag-btn-active", n > 0);
}

function toggleTagMenu(): void {
  if (!tagMenu || !tagBtn) return;

  const opening = tagMenu.hidden;
  closeToolbarMenus();
  if (!opening) return;

  renderTagMenu();
  tagMenu.hidden = false;
  tagBtn.setAttribute("aria-expanded", "true");
}

function appendManageTagsHeader(menu: HTMLElement): void {
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "toolbar-tag-manage";
  manage.setAttribute("aria-label", "Manage tags");
  manage.innerHTML = `
    <span class="toolbar-tag-manage-icon" aria-hidden="true">⚙</span>
    <span class="toolbar-tag-manage-label">Manage tags</span>
  `;
  manage.addEventListener("click", (e) => {
    e.stopPropagation();
    closeToolbarMenus();
    openTagManager();
  });
  menu.appendChild(manage);

  const divider = document.createElement("div");
  divider.className = "toolbar-tag-menu-divider";
  divider.setAttribute("role", "separator");
  menu.appendChild(divider);
}

function renderTagMenu(): void {
  if (!tagMenu) return;
  tagMenu.innerHTML = "";

  appendManageTagsHeader(tagMenu);

  if (state.currentMediaId == null) {
    const empty = document.createElement("div");
    empty.className = "toolbar-option toolbar-option-empty";
    empty.textContent = "Select a file to assign tags";
    tagMenu.appendChild(empty);
    return;
  }

  if (allTags.length === 0) {
    const empty = document.createElement("div");
    empty.className = "toolbar-option toolbar-option-empty";
    empty.textContent = "No tags yet";
    tagMenu.appendChild(empty);
    const hint = document.createElement("div");
    hint.className = "toolbar-tag-hint";
    hint.textContent = "Use Manage tags to create some";
    tagMenu.appendChild(hint);
    return;
  }

  const onItem = new Set(itemTags.map((t) => t.id));

  for (const tag of allTags) {
    const row = document.createElement("label");
    row.className = "toolbar-tag-option";
    row.title = tag.name;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "toolbar-tag-checkbox";
    cb.checked = onItem.has(tag.id);
    cb.disabled = pendingTagIds.has(tag.id);
    cb.setAttribute("aria-label", tag.name);
    cb.addEventListener("change", () => {
      void onToggleTag(tag.id, cb.checked, cb);
    });

    const name = document.createElement("span");
    name.className = "toolbar-tag-option-name";
    name.textContent = tag.name;

    row.appendChild(cb);
    row.appendChild(name);
    tagMenu.appendChild(row);
  }
}

/** True when UI mutations still target the media we started the mutation for. */
function stillOnMedia(mediaId: number): boolean {
  return state.currentMediaId === mediaId;
}

function applyItemTagsLocally(tags: Tag[]): void {
  itemTags = tags;
  if (state.currentMedia) state.currentMedia.tags = [...itemTags];
  updateTagButton();
  if (tagMenu && !tagMenu.hidden) renderTagMenu();
  stopTagSounds();
  clearBadges();
  if (!state.currentMedia?.isMissing) {
    showBadgesAndPlaySounds(itemTags);
  }
}

async function onToggleTag(
  tagId: number,
  wantOn: boolean,
  checkbox: HTMLInputElement,
): Promise<void> {
  const mediaId = state.currentMediaId;
  if (mediaId == null) {
    checkbox.checked = false;
    return;
  }
  if (pendingTagIds.has(tagId)) {
    checkbox.checked = !wantOn;
    return;
  }

  const currentlyOn = itemTags.some((t) => t.id === tagId);
  if (wantOn === currentlyOn) return;

  pendingTagIds.add(tagId);
  checkbox.disabled = true;

  try {
    if (wantOn) {
      const tag = await addMediaTag(mediaId, tagId);
      if (!stillOnMedia(mediaId)) return;

      const next = itemTags.some((t) => t.id === tag.id)
        ? itemTags
        : [...itemTags, tag].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
          );
      applyItemTagsLocally(next);
    } else {
      await removeMediaTag(mediaId, tagId);
      if (!stillOnMedia(mediaId)) return;
      applyItemTagsLocally(itemTags.filter((t) => t.id !== tagId));
    }
  } catch (err) {
    // Revert checkbox if we are still on the same item.
    if (stillOnMedia(mediaId)) {
      checkbox.checked = currentlyOn;
      setStatus(
        `${wantOn ? "Add" : "Remove"} tag failed: ${formatErr(err)}`,
        true,
      );
    }
  } finally {
    pendingTagIds.delete(tagId);
    if (stillOnMedia(mediaId) && tagMenu && !tagMenu.hidden) {
      // Re-render so disabled state and checks stay in sync.
      renderTagMenu();
    }
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
