/**
 * Navigation: next/prev with alpha | random modes and session history.
 *
 * Inputs: Right = next, Left = prev; right-click = next, left-click = prev.
 * Clicks over chrome / form controls / video do not fire left-click prev.
 */

import {
  getMedia,
  getNeighbor,
  getRandom,
  settingsSet,
  type MediaItem,
} from "./api";
import {
  commitHistoryBack,
  commitHistoryForward,
  isNavMode,
  peekHistoryBack,
  peekHistoryForward,
  pushHistory,
  removeHistoryNeighbor,
  resetHistory,
  setCurrentMedia,
  state,
  unshiftHistory,
  type NavMode,
} from "./state";
import { isOverChrome } from "./ui/chrome";
import { showMedia } from "./ui/stage";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let statusClearTimer: number | null = null;

/** Serialized last_media_id writes — always flush the latest id. */
let lastMediaWriteQueue: Promise<void> = Promise.resolve();
let latestLastMediaId: number | null = null;

export function initNav(statusFn: StatusFn): void {
  setStatus = statusFn;
}

function flashStatus(message: string, ms = 2500): void {
  setStatus(message, true);
  if (statusClearTimer != null) window.clearTimeout(statusClearTimer);
  statusClearTimer = window.setTimeout(() => setStatus("", false), ms);
}

function persistLastMediaId(id: number | null): Promise<void> {
  latestLastMediaId = id;
  lastMediaWriteQueue = lastMediaWriteQueue
    .then(async () => {
      const value = latestLastMediaId;
      await settingsSet("last_media_id", JSON.stringify(value));
    })
    .catch((err) => {
      console.warn("persist last_media_id failed", err);
    });
  return lastMediaWriteQueue;
}

/** Show an item already resolved from DB; does not touch history. */
export async function displayMedia(item: MediaItem): Promise<void> {
  setCurrentMedia(item);
  showMedia(item);
  flashStatus(item.filename);
  // Await so navigating gate covers the write; queue keeps latest id wins.
  await persistLastMediaId(item.id);
}

/** Direct jump: reset history to [id] and show. */
export async function jumpToMedia(item: MediaItem): Promise<void> {
  resetHistory(item.id);
  await displayMedia(item);
}

export async function loadMediaById(id: number): Promise<MediaItem | null> {
  const item = await getMedia(id);
  if (!item) return null;
  await displayMedia(item);
  return item;
}

function canNavigate(): boolean {
  return (
    !state.scanning &&
    !state.navigating &&
    state.root != null &&
    state.root.id > 0 &&
    state.currentMediaId != null
  );
}

async function pickRandomNext(): Promise<MediaItem | null> {
  const root = state.root;
  if (!root) return null;
  const excludeId = state.currentMediaId;
  if (state.navMode === "random_current_dir") {
    const parent = state.currentMedia?.parentDir ?? null;
    return getRandom(root.id, parent, excludeId);
  }
  return getRandom(root.id, null, excludeId);
}

/**
 * Walk history in direction: peek → load → commit on success.
 * Dead (null) ids are spliced out and the walk retries so Prev/Next cannot stick.
 * Transient IPC errors stop without mutating history.
 *
 * @returns "loaded" | "exhausted" (no more history) | "error"
 */
async function walkHistory(
  direction: "back" | "forward",
): Promise<"loaded" | "exhausted" | "error"> {
  let skipped = 0;
  while (true) {
    const id =
      direction === "back" ? peekHistoryBack() : peekHistoryForward();
    if (id == null) {
      if (skipped > 0) {
        flashStatus(
          skipped === 1
            ? "History item missing — skipped"
            : `Skipped ${skipped} missing history items`,
          2500,
        );
      }
      return "exhausted";
    }

    try {
      const item = await getMedia(id);
      if (!item) {
        // Hard-deleted / gone row — drop slot and retry next neighbor.
        if (!removeHistoryNeighbor(direction)) {
          return "exhausted";
        }
        skipped += 1;
        continue;
      }
      if (direction === "back") commitHistoryBack();
      else commitHistoryForward();
      await displayMedia(item);
      if (skipped > 0) {
        // Brief note; displayMedia also flashes filename.
        flashStatus(item.filename, 2500);
      }
      return "loaded";
    } catch (err) {
      console.error("history load failed", err);
      flashStatus(`Navigate failed: ${formatErr(err)}`, 4000);
      return "error";
    }
  }
}

/** Next item per nav mode + history rules. */
export async function goNext(): Promise<void> {
  if (!canNavigate() || state.currentMediaId == null) return;

  state.navigating = true;
  try {
    // Random modes: replay forward history when not at tip (peek, then commit).
    // Dead ids are pruned so we never stick on a missing slot.
    if (state.navMode !== "alpha") {
      const result = await walkHistory("forward");
      if (result === "loaded" || result === "error") return;
      // exhausted → pick a new random item below
    }

    let item: MediaItem | null = null;
    if (state.navMode === "alpha") {
      item = await getNeighbor(state.currentMediaId, "next");
    } else {
      item = await pickRandomNext();
    }

    if (!item) return;

    // Single-item library / same id: keep history stable, skip media rebuild.
    if (item.id === state.currentMediaId) {
      pushHistory(item.id);
      return;
    }

    pushHistory(item.id);
    await displayMedia(item);
  } catch (err) {
    console.error("goNext failed", err);
    flashStatus(`Navigate failed: ${formatErr(err)}`, 4000);
  } finally {
    state.navigating = false;
  }
}

/** Previous: history first; alpha may SQL-prev past start; random no-ops at start. */
export async function goPrev(): Promise<void> {
  if (!canNavigate() || state.currentMediaId == null) return;

  state.navigating = true;
  try {
    const result = await walkHistory("back");
    if (result === "loaded" || result === "error") return;
    // exhausted history — alpha can still SQL-prev; random stays at first entry

    if (state.navMode !== "alpha") {
      return;
    }

    const item = await getNeighbor(state.currentMediaId, "prev");
    if (!item) return;

    if (item.id === state.currentMediaId) {
      // Single-item wrap — no DOM rebuild.
      unshiftHistory(item.id);
      return;
    }

    unshiftHistory(item.id);
    await displayMedia(item);
  } catch (err) {
    console.error("goPrev failed", err);
    flashStatus(`Navigate failed: ${formatErr(err)}`, 4000);
  } finally {
    state.navigating = false;
  }
}

export async function setNavMode(mode: NavMode): Promise<void> {
  state.navMode = mode;
  try {
    await settingsSet("nav_mode", JSON.stringify(mode));
  } catch (err) {
    console.warn("persist nav_mode failed", err);
  }
}

export function parseNavMode(raw: string | null | undefined): NavMode {
  if (!raw) return "alpha";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isNavMode(parsed)) return parsed;
  } catch {
    if (isNavMode(raw)) return raw;
  }
  return "alpha";
}

/**
 * True when the event target is over chrome / form controls where nav clicks must not fire.
 * Non-Element targets are blocked (safer for click nav).
 */
export function isNavClickBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (isOverChrome(target)) return true;

  // Interactive form controls (not media surface).
  if (
    target.closest(
      "button, input, select, textarea, a, label, option, summary",
    )
  ) {
    return true;
  }

  return false;
}

/** Left-click prev: also skip video/audio (native controls retarget to media element). */
function isLeftClickNavBlocked(target: EventTarget | null): boolean {
  if (isNavClickBlocked(target)) return true;
  if (target instanceof Element && target.closest("video, audio")) return true;
  return false;
}

/** True when a chrome panel is open — outside click should close it, not navigate. */
function isAnyPanelOpen(): boolean {
  const panel = document.querySelector("#settings-panel");
  return Boolean(panel && !panel.hasAttribute("hidden"));
}

function closeOpenPanels(): void {
  const panel = document.querySelector("#settings-panel");
  if (panel && !panel.hasAttribute("hidden")) {
    panel.setAttribute("hidden", "");
  }
}

/** Wire left/right click navigation on the stage. */
export function wireNavClicks(stageEl: HTMLElement): void {
  stageEl.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    if (isLeftClickNavBlocked(e.target)) return;
    // Ignore multi-click / modified
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    // Outside click closes settings; don't also step prev.
    if (isAnyPanelOpen()) return;
    e.preventDefault();
    void goPrev();
  });

  stageEl.addEventListener("contextmenu", (e) => {
    if (isNavClickBlocked(e.target)) return;
    // Align with left-click: close open panel, never show browser menu on stage.
    if (isAnyPanelOpen()) {
      e.preventDefault();
      closeOpenPanels();
      return;
    }
    e.preventDefault();
    void goNext();
  });
}

/** Keyboard Left/Right for prev/next. Call from main keydown handler. */
export function handleNavKey(e: KeyboardEvent): boolean {
  if (e.key === "ArrowRight") {
    e.preventDefault();
    void goNext();
    return true;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    void goPrev();
    return true;
  }
  return false;
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
