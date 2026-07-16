/**
 * Media stage: empty states, image, or video via asset protocol.
 */

import { mediaUrl, type MediaItem } from "../api";
import { state, type StageEmptyReason } from "../state";
import { clearTagPresentation, onMediaDisplayed } from "./tags";

let emptyEl: HTMLElement | null = null;
let mediaHost: HTMLElement | null = null;
let activeVideo: HTMLVideoElement | null = null;

const EMPTY_COPY: Record<Exclude<StageEmptyReason, null>, { title: string; body: string }> = {
  no_root: {
    title: "No folder selected",
    body: "Open Settings (⚙) and choose a media folder, then Scan.",
  },
  no_media: {
    title: "No media found",
    body: "This folder has no supported images or videos. Pick another folder or Re-scan.",
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

/** Show empty stage (no root / no media / loading / error). */
export function showEmpty(reason: StageEmptyReason): void {
  state.stageEmpty = reason;
  clearMedia();
  renderEmpty(reason);
  // ISSUE-3: only wipe the tag editor when there is no current media.
  // Decode/load errors keep currentMediaId set — stop sounds + clear badges,
  // but leave the per-item tag panel so add/remove still works.
  if (state.currentMediaId == null) {
    onMediaDisplayed(null);
  } else {
    clearTagPresentation();
  }
}

/** Load and display a media item (image or video). */
export function showMedia(item: MediaItem): void {
  if (!mediaHost) return;
  state.stageEmpty = null;
  renderEmpty(null);
  clearMedia();

  if (item.isMissing) {
    showEmpty("error");
    if (emptyEl) {
      emptyEl.innerHTML = `
        <div class="stage-empty-card">
          <div class="stage-empty-title">File missing</div>
          <div class="stage-empty-body">${escapeHtml(item.path)}</div>
        </div>
      `;
      emptyEl.hidden = false;
    }
    return;
  }

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
      showEmpty("error");
      if (emptyEl) {
        emptyEl.innerHTML = `
          <div class="stage-empty-card">
            <div class="stage-empty-title">Could not play video</div>
            <div class="stage-empty-body">${escapeHtml(item.filename)}</div>
          </div>
        `;
        emptyEl.hidden = false;
      }
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
      showEmpty("error");
      if (emptyEl) {
        emptyEl.innerHTML = `
          <div class="stage-empty-card">
            <div class="stage-empty-title">Could not load image</div>
            <div class="stage-empty-body">${escapeHtml(item.filename)}</div>
          </div>
        `;
        emptyEl.hidden = false;
      }
    });
    mediaHost.appendChild(img);
  }
}
