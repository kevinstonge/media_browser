/**
 * Per-item tags panel (bottom-left, hover-reveal), top-left badges,
 * and sequential tag-sound queue (no overlap; video audio continues).
 */

import {
  addMediaTag,
  createTag,
  getMedia,
  listTags,
  mediaUrl,
  removeMediaTag,
  type MediaItem,
  type Tag,
  type TagAsset,
} from "../api";
import { state } from "../state";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let listEl: HTMLElement | null = null;
let selectEl: HTMLSelectElement | null = null;
let addBtn: HTMLButtonElement | null = null;
let createInput: HTMLInputElement | null = null;
let createBtn: HTMLButtonElement | null = null;
let badgesEl: HTMLElement | null = null;
let chromeEl: HTMLElement | null = null;

/** Tags currently shown for the active media item (panel list). */
let itemTags: Tag[] = [];
/** Full vocabulary for add dropdown. */
let allTags: Tag[] = [];

/** Bumped when media changes so in-flight sound queues abort. */
let soundGeneration = 0;
let activeAudio: HTMLAudioElement | null = null;

/** Optional listener when global tag vocabulary changes (settings refresh). */
let vocabularyListener: (() => void) | null = null;

export function setTagVocabularyListener(fn: (() => void) | null): void {
  vocabularyListener = fn;
}

function notifyVocabularyChanged(): void {
  try {
    vocabularyListener?.();
  } catch (err) {
    console.warn("tag vocabulary listener failed", err);
  }
}

export function mountTags(root: HTMLElement, statusFn?: StatusFn): void {
  if (statusFn) setStatus = statusFn;

  // Top-left badge strip (always visible when present; not hover chrome)
  badgesEl = document.createElement("div");
  badgesEl.className = "tag-badges nav-exclude";
  badgesEl.setAttribute("aria-label", "Tag badges");
  badgesEl.hidden = true;
  root.appendChild(badgesEl);

  // Bottom-left hover-reveal tags panel
  chromeEl = document.createElement("div");
  chromeEl.className = "tags-chrome nav-exclude";
  chromeEl.innerHTML = `
    <div class="tags-panel" role="region" aria-label="Tags">
      <div class="tags-panel-title">Tags</div>
      <ul class="tags-list" id="tags-list"></ul>
      <div class="tags-add-row">
        <select class="tags-select" id="tags-select" aria-label="Add tag" disabled>
          <option value="">Add tag…</option>
        </select>
        <button type="button" class="tags-btn" id="tags-add" disabled>Add</button>
      </div>
      <div class="tags-create-row">
        <input
          type="text"
          class="tags-input"
          id="tags-create-input"
          placeholder="New tag name"
          maxlength="64"
          aria-label="Create new tag"
        />
        <button type="button" class="tags-btn" id="tags-create">Create</button>
      </div>
    </div>
  `;
  root.appendChild(chromeEl);

  listEl = chromeEl.querySelector("#tags-list");
  selectEl = chromeEl.querySelector("#tags-select");
  addBtn = chromeEl.querySelector("#tags-add");
  createInput = chromeEl.querySelector("#tags-create-input");
  createBtn = chromeEl.querySelector("#tags-create");

  addBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void onAddSelected();
  });

  selectEl?.addEventListener("change", () => {
    if (addBtn) addBtn.disabled = !selectEl?.value || state.currentMediaId == null;
  });

  createBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void onCreateAndAdd();
  });

  createInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void onCreateAndAdd();
    }
  });

  // Block click-nav when interacting with panel
  chromeEl.addEventListener("click", (e) => e.stopPropagation());
  chromeEl.addEventListener("contextmenu", (e) => e.stopPropagation());

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
  renderAddDropdown();
}

/**
 * Called whenever the displayed media changes (or clears).
 * Stops sound queue, clears badges, loads item tags.
 */
export function onMediaDisplayed(item: MediaItem | null): void {
  stopTagSounds();
  clearBadges();

  if (!item || item.isMissing) {
    itemTags = [];
    renderTagList();
    renderAddDropdown();
    return;
  }

  // Prefer tags from get_media payload; fall back to empty.
  itemTags = item.tags ? [...item.tags] : [];
  renderTagList();
  renderAddDropdown();
  showBadgesAndPlaySounds(itemTags);
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
    const done = () => {
      if (activeAudio === audio) activeAudio = null;
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      resolve();
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    void audio.play().catch(() => done());
  });
}

function renderTagList(): void {
  if (!listEl) return;
  listEl.innerHTML = "";

  if (state.currentMediaId == null) {
    const li = document.createElement("li");
    li.className = "tags-empty";
    li.textContent = "No media";
    listEl.appendChild(li);
    return;
  }

  if (itemTags.length === 0) {
    const li = document.createElement("li");
    li.className = "tags-empty";
    li.textContent = "No tags";
    listEl.appendChild(li);
    return;
  }

  for (const tag of itemTags) {
    const li = document.createElement("li");
    li.className = "tags-item";
    li.dataset.tagId = String(tag.id);

    const name = document.createElement("span");
    name.className = "tags-item-name";
    name.textContent = tag.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tags-item-remove";
    remove.title = `Remove “${tag.name}”`;
    remove.setAttribute("aria-label", `Remove tag ${tag.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      void onRemoveTag(tag.id);
    });

    li.appendChild(name);
    li.appendChild(remove);
    listEl.appendChild(li);
  }
}

function renderAddDropdown(): void {
  if (!selectEl || !addBtn) return;
  const onItem = new Set(itemTags.map((t) => t.id));
  const available = allTags.filter((t) => !onItem.has(t.id));

  selectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = available.length ? "Add tag…" : "No more tags";
  selectEl.appendChild(placeholder);

  for (const tag of available) {
    const opt = document.createElement("option");
    opt.value = String(tag.id);
    opt.textContent = tag.name;
    selectEl.appendChild(opt);
  }

  const canAdd = state.currentMediaId != null && available.length > 0;
  selectEl.disabled = !canAdd;
  addBtn.disabled = true;
}

async function onAddSelected(): Promise<void> {
  const mediaId = state.currentMediaId;
  const tagId = Number(selectEl?.value);
  if (mediaId == null || !Number.isFinite(tagId) || tagId <= 0) return;

  try {
    const tag = await addMediaTag(mediaId, tagId);
    if (!itemTags.some((t) => t.id === tag.id)) {
      itemTags.push(tag);
      itemTags.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    }
    if (state.currentMedia) state.currentMedia.tags = [...itemTags];
    renderTagList();
    renderAddDropdown();
    // Refresh badges/sounds for updated set
    stopTagSounds();
    clearBadges();
    showBadgesAndPlaySounds(itemTags);
  } catch (err) {
    setStatus(`Add tag failed: ${formatErr(err)}`, true);
  }
}

async function onRemoveTag(tagId: number): Promise<void> {
  const mediaId = state.currentMediaId;
  if (mediaId == null) return;

  try {
    await removeMediaTag(mediaId, tagId);
    itemTags = itemTags.filter((t) => t.id !== tagId);
    if (state.currentMedia) state.currentMedia.tags = [...itemTags];
    renderTagList();
    renderAddDropdown();
    stopTagSounds();
    clearBadges();
    showBadgesAndPlaySounds(itemTags);
  } catch (err) {
    setStatus(`Remove tag failed: ${formatErr(err)}`, true);
  }
}

async function onCreateAndAdd(): Promise<void> {
  const name = createInput?.value.trim() ?? "";
  if (!name) return;

  try {
    const tag = await createTag(name);
    // Refresh vocabulary (settings list too)
    if (!allTags.some((t) => t.id === tag.id)) {
      allTags.push(tag);
      allTags.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    } else {
      // Merge name if re-fetched case differs
      allTags = allTags.map((t) => (t.id === tag.id ? tag : t));
    }
    notifyVocabularyChanged();

    if (createInput) createInput.value = "";

    const mediaId = state.currentMediaId;
    if (mediaId != null) {
      if (!itemTags.some((t) => t.id === tag.id)) {
        const attached = await addMediaTag(mediaId, tag.id);
        itemTags.push(attached);
        itemTags.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
        if (state.currentMedia) state.currentMedia.tags = [...itemTags];
        stopTagSounds();
        clearBadges();
        showBadgesAndPlaySounds(itemTags);
      }
    }

    renderTagList();
    renderAddDropdown();
    setStatus(`Tag “${tag.name}” ready`, true);
    window.setTimeout(() => setStatus("", false), 2000);
  } catch (err) {
    setStatus(`Create tag failed: ${formatErr(err)}`, true);
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
