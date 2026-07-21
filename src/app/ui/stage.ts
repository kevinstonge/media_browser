/**
 * Media stage: empty states, image/video via asset protocol, missing + decode errors
 * with Open with default / VLC / parent folder actions.
 */

import { mediaUrl, pathExists, type MediaItem } from "../api";
import { state, type StageEmptyReason } from "../state";
import {
  doOpenParentFolder,
  doOpenWithDefault,
  doOpenWithVlc,
} from "./openWith";
import { clearTagPresentation, onMediaDisplayed } from "./tags";

let emptyEl: HTMLElement | null = null;
let mediaHost: HTMLElement | null = null;
let activeVideo: HTMLVideoElement | null = null;
/** Path last shown in an error/missing card (for action buttons). */
let errorPath: string | null = null;

/** Outcome of presenting media (for tag badges/sounds sequencing). */
export type PresentResult = "ready" | "missing" | "aborted";

const EMPTY_COPY: Record<Exclude<StageEmptyReason, null>, { title: string; body: string }> = {
  no_root: {
    title: "No folder selected",
    body: "Use the root folder control (📁⚙) in the toolbar to choose a media folder, then Scan.",
  },
  no_media: {
    title: "No media found",
    body: "This folder has no supported images or videos. Select another root folder or Re-scan.",
  },
  loading: {
    title: "Loading…",
    body: "",
  },
  error: {
    title: "Could not load media",
    body: "The file may be missing or unsupported in-app.",
  },
};

export function mountStage(root: HTMLElement): void {
  root.innerHTML = "";
  root.classList.add("stage");

  emptyEl = document.createElement("div");
  emptyEl.className = "stage-empty";
  emptyEl.setAttribute("aria-live", "polite");
  root.appendChild(emptyEl);

  mediaHost = document.createElement("div");
  mediaHost.className = "stage-media-host";
  root.appendChild(mediaHost);

  // Error action buttons (event delegation — re-rendered HTML keeps working).
  emptyEl.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.closest<HTMLElement>("[data-open-action]")?.dataset.openAction;
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    const path = errorPath ?? state.currentMedia?.path ?? null;
    if (action === "default") void doOpenWithDefault(path);
    else if (action === "vlc") void doOpenWithVlc(path);
    else if (action === "parent") void doOpenParentFolder(path);
  });

  // Clicks on the empty/error card must not bubble to stage nav (left/right).
  emptyEl.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest(".stage-empty-card-actions")) {
      e.stopPropagation();
    }
  });
  emptyEl.addEventListener("contextmenu", (e) => {
    if (e.target instanceof Element && e.target.closest(".stage-empty-card-actions")) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  renderEmpty(state.stageEmpty ?? "no_root");
}

function clearMedia(): void {
  if (activeVideo) {
    activeVideo.pause();
    activeVideo.removeAttribute("src");
    activeVideo.load();
    activeVideo = null;
  }
  if (mediaHost) {
    mediaHost.innerHTML = "";
    mediaHost.hidden = true;
  }
}

function renderEmpty(reason: StageEmptyReason): void {
  if (!emptyEl) return;
  errorPath = null;
  if (!reason) {
    emptyEl.hidden = true;
    emptyEl.innerHTML = "";
    return;
  }
  const copy = EMPTY_COPY[reason];
  emptyEl.hidden = false;
  emptyEl.innerHTML = `
    <div class="stage-empty-card">
      <div class="stage-empty-title">${escapeHtml(copy.title)}</div>
      ${copy.body ? `<div class="stage-empty-body">${escapeHtml(copy.body)}</div>` : ""}
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openActionsHtml(opts: {
  showDefault: boolean;
  showVlc: boolean;
  showParent: boolean;
}): string {
  const buttons: string[] = [];
  if (opts.showDefault) {
    buttons.push(
      `<button type="button" class="stage-action-btn" data-open-action="default">Open with default</button>`,
    );
  }
  if (opts.showVlc) {
    buttons.push(
      `<button type="button" class="stage-action-btn" data-open-action="vlc">Open with VLC</button>`,
    );
  }
  if (opts.showParent) {
    buttons.push(
      `<button type="button" class="stage-action-btn stage-action-btn-secondary" data-open-action="parent">Open parent folder</button>`,
    );
  }
  if (buttons.length === 0) return "";
  return `<div class="stage-empty-actions nav-exclude">${buttons.join("")}</div>`;
}

function renderMissing(path: string, filename: string): void {
  if (!emptyEl) return;
  errorPath = path;
  state.stageEmpty = "error";
  emptyEl.hidden = false;
  // PLAN §10.2: missing → message + path + parent folder only (no default/VLC —
  // those require the file on disk and would hard-fail).
  emptyEl.innerHTML = `
    <div class="stage-empty-card stage-empty-card-actions nav-exclude">
      <div class="stage-empty-title">File missing</div>
      <div class="stage-empty-body">${escapeHtml(path || filename)}</div>
      ${openActionsHtml({
        showDefault: false,
        showVlc: false,
        showParent: true,
      })}
      <p class="stage-empty-hint">Open the parent folder, or Re-scan to soft-flag missing files (tags kept).</p>
    </div>
  `;
}

function renderDecodeError(path: string, filename: string, kind: "image" | "video"): void {
  if (!emptyEl) return;
  errorPath = path;
  state.stageEmpty = "error";
  emptyEl.hidden = false;
  emptyEl.innerHTML = `
    <div class="stage-empty-card stage-empty-card-actions nav-exclude">
      <div class="stage-empty-title">${
        kind === "video" ? "Could not play video" : "Could not load image"
      }</div>
      <div class="stage-empty-body">${escapeHtml(filename || path)}</div>
      ${openActionsHtml({ showDefault: true, showVlc: true, showParent: false })}
      <p class="stage-empty-hint">Try VLC or the system default player for this format.</p>
    </div>
  `;
}

/** Show empty stage (no root / no media / loading / error). */
export function showEmpty(reason: StageEmptyReason): void {
  state.stageEmpty = reason;
  clearMedia();
  renderEmpty(reason);
  // only wipe the tag editor when there is no current media.
  // Decode/load errors keep currentMediaId set — stop sounds + clear badges,
  // but leave the per-item tag panel so add/remove still works.
  if (state.currentMediaId == null) {
    onMediaDisplayed(null);
  } else {
    clearTagPresentation();
  }
}

/**
 * Load and display a media item (image or video).
 * Awaits disk existence check so callers can sequence tag badges/sounds.
 *
 * @returns `"ready"` when media element is mounted, `"missing"` when the file
 *   is soft-missing or gone on disk, `"aborted"` if navigation moved on.
 */
export async function showMedia(item: MediaItem): Promise<PresentResult> {
  if (!mediaHost) return "aborted";
  state.stageEmpty = null;
  renderEmpty(null);
  clearMedia();
  errorPath = null;

  // Soft-missing from DB, or confirm on disk before loading.
  return presentMedia(item);
}

async function presentMedia(item: MediaItem): Promise<PresentResult> {
  // If navigation moved on, abandon this load.
  if (state.currentMediaId !== item.id) return "aborted";

  if (item.isMissing) {
    clearMedia();
    renderMissing(item.path, item.filename);
    clearTagPresentation();
    return "missing";
  }

  let exists = true;
  try {
    exists = await pathExists(item.path);
  } catch (err) {
    console.warn("path_exists failed", err);
  }
  if (state.currentMediaId !== item.id) return "aborted";

  if (!exists) {
    clearMedia();
    renderMissing(item.path, item.filename);
    clearTagPresentation();
    return "missing";
  }

  if (!mediaHost) return "aborted";
  const url = mediaUrl(item.path);
  mediaHost.hidden = false;

  if (item.mediaType === "video") {
    const video = document.createElement("video");
    video.className = "stage-media stage-video";
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener("error", () => {
      if (state.currentMediaId !== item.id) return;
      clearMedia();
      renderDecodeError(item.path, item.filename, "video");
      clearTagPresentation();
    });
    mediaHost.appendChild(video);
    activeVideo = video;
  } else {
    const img = document.createElement("img");
    img.className = "stage-media stage-image";
    img.alt = item.filename;
    img.draggable = false;
    img.src = url;
    img.addEventListener("error", () => {
      if (state.currentMediaId !== item.id) return;
      clearMedia();
      renderDecodeError(item.path, item.filename, "image");
      clearTagPresentation();
    });
    mediaHost.appendChild(img);
  }
  return "ready";
}
