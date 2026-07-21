/**
 * Global tag manager modal: create/delete tags and manage badge/sound assets.
 * Opened from the toolbar tag dropdown ("Manage tags").
 * Per-tag asset sections are collapsed by default; click the tag name to expand.
 */

import {
  addTagAsset,
  createTag,
  deleteTag,
  listTags,
  pickFile,
  removeTagAsset,
  type Tag,
} from "../api";
import {
  refreshVocabulary,
  reloadCurrentItemTags,
  setTagVocabularyListener,
} from "./tags";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let overlay: HTMLElement | null = null;
let tagListEl: HTMLElement | null = null;
let createInput: HTMLInputElement | null = null;
let managerTags: Tag[] = [];

/** Tag ids whose asset sections are currently expanded. */
const expandedTagIds = new Set<number>();

export function mountTagManager(root: HTMLElement, statusFn?: StatusFn): void {
  if (statusFn) setStatus = statusFn;

  overlay = document.createElement("div");
  overlay.id = "tag-manager";
  overlay.className = "tag-manager-overlay nav-exclude";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Manage tags");
  overlay.innerHTML = `
    <div class="tag-manager-card">
      <div class="tag-manager-header">
        <div class="tag-manager-title">Manage tags</div>
        <button
          type="button"
          class="settings-btn settings-btn-tiny tag-manager-close"
          id="tag-manager-close"
          title="Close"
          aria-label="Close tag manager"
        >×</button>
      </div>
      <div class="settings-row tag-manager-create-row">
        <input
          type="text"
          class="settings-input"
          id="tag-manager-create"
          placeholder="New tag name"
          maxlength="64"
          aria-label="Create tag"
        />
        <button type="button" class="settings-btn" id="tag-manager-create-btn">Create</button>
      </div>
      <div class="tag-manager-list" id="tag-manager-list" role="list"></div>
      <p class="settings-hint tag-manager-hint">Click a tag name to edit badge images and sounds.</p>
    </div>
  `;
  root.appendChild(overlay);

  tagListEl = overlay.querySelector("#tag-manager-list");
  createInput = overlay.querySelector("#tag-manager-create");
  const createBtn = overlay.querySelector<HTMLButtonElement>("#tag-manager-create-btn");
  const closeBtn = overlay.querySelector<HTMLButtonElement>("#tag-manager-close");
  const card = overlay.querySelector<HTMLElement>(".tag-manager-card");

  setTagVocabularyListener(() => {
    if (overlay && !overlay.hidden) {
      void refreshTagManager();
    }
  });

  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    hideTagManager();
  });

  createBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void onCreateTag();
  });

  createInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void onCreateTag();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideTagManager();
    }
  });

  // Backdrop click closes; clicks on the card do not.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideTagManager();
  });
  card?.addEventListener("click", (e) => e.stopPropagation());
  card?.addEventListener("mousedown", (e) => e.stopPropagation());
}

export function isTagManagerOpen(): boolean {
  return Boolean(overlay && !overlay.hidden);
}

export function showTagManager(): void {
  if (!overlay) return;
  overlay.hidden = false;
  void refreshTagManager().then(() => {
    createInput?.focus();
  });
}

export function hideTagManager(): void {
  if (!overlay) return;
  overlay.hidden = true;
}

export function openTagManager(): void {
  showTagManager();
}

/** Esc closes the modal when open. Returns true if the event was consumed. */
export function handleTagManagerKey(e: KeyboardEvent): boolean {
  if (e.key === "Escape" && isTagManagerOpen()) {
    e.preventDefault();
    hideTagManager();
    return true;
  }
  return false;
}

async function refreshTagManager(): Promise<void> {
  try {
    managerTags = await listTags();
  } catch (err) {
    console.warn("list_tags (tag manager) failed", err);
    managerTags = [];
  }
  // Drop expanded ids that no longer exist.
  const alive = new Set(managerTags.map((t) => t.id));
  for (const id of [...expandedTagIds]) {
    if (!alive.has(id)) expandedTagIds.delete(id);
  }
  renderTagManager();
}

function renderTagManager(): void {
  if (!tagListEl) return;
  tagListEl.innerHTML = "";

  if (managerTags.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-tag-empty";
    empty.textContent = "No tags yet — create one above.";
    tagListEl.appendChild(empty);
    return;
  }

  for (const tag of managerTags) {
    tagListEl.appendChild(buildTagCard(tag));
  }
}

function buildTagCard(tag: Tag): HTMLElement {
  const expanded = expandedTagIds.has(tag.id);

  const card = document.createElement("div");
  card.className = "settings-tag-card tag-manager-card-item";
  card.classList.toggle("is-expanded", expanded);
  card.setAttribute("role", "listitem");
  card.dataset.tagId = String(tag.id);

  const header = document.createElement("div");
  header.className = "settings-tag-card-header";

  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "tag-manager-name-btn";
  nameBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
  nameBtn.title = expanded
    ? `Collapse settings for “${tag.name}”`
    : `Expand settings for “${tag.name}”`;

  const caret = document.createElement("span");
  caret.className = "tag-manager-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = expanded ? "▾" : "▸";

  const name = document.createElement("span");
  name.className = "settings-tag-name";
  name.textContent = tag.name;

  nameBtn.appendChild(caret);
  nameBtn.appendChild(name);
  nameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (expandedTagIds.has(tag.id)) {
      expandedTagIds.delete(tag.id);
    } else {
      expandedTagIds.add(tag.id);
    }
    renderTagManager();
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "settings-btn settings-btn-danger settings-btn-tiny";
  del.textContent = "Delete";
  del.title = `Delete tag “${tag.name}”`;
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    void onDeleteTag(tag);
  });

  header.appendChild(nameBtn);
  header.appendChild(del);
  card.appendChild(header);

  if (expanded) {
    const body = document.createElement("div");
    body.className = "tag-manager-card-body";
    body.appendChild(
      buildAssetSection(tag, "image", "Badge images", "Add image…"),
    );
    body.appendChild(
      buildAssetSection(tag, "sound", "Sounds", "Add sound…"),
    );
    card.appendChild(body);
  }

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

async function onCreateTag(): Promise<void> {
  const name = createInput?.value.trim() ?? "";
  if (!name) return;
  try {
    const tag = await createTag(name);
    if (createInput) createInput.value = "";
    // Expand the new tag so assets can be added immediately.
    expandedTagIds.add(tag.id);
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
    expandedTagIds.delete(tag.id);
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

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
