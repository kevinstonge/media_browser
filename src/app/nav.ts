/**
 * Navigation: next/prev with sequential | random modes and session history.
 *
 * One global nav mode applies to every input (keyboard, mouse, wheel, toolbar)
 * and to the slideshow timer (which only auto-sends "next").
 *
 * While slideshow is active (playing or paused), next/prev use slideshow
 * history. Manual steps notify the slideshow timer so the duration clock resets.
 *
 * Each goNext/goPrev freezes the history bag + nav session generation at
 * entry so Stop/Start mid-await cannot redirect mutations onto the other bag.
 *
 * Sequential (all/current): SQL neighbors wrap at list ends (first↔last within
 * the active scope). Random: session history grows at either end — next past
 * the tip appends a new random id; prev past the start prepends a new random id
 * so browsing is infinite in both directions.
 *
 * Inputs: Right = next, Left = prev; right-click = next, left-click = prev;
 * wheel down = next, wheel up = prev; toolbar Previous / Next buttons.
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
  commitHistoryBack as commitBackBag,
  commitHistoryForward as commitForwardBag,
  peekHistoryBack as peekBackBag,
  peekHistoryForward as peekForwardBag,
  pushHistory as pushHistoryBag,
  removeHistoryNeighbor as removeNeighborBag,
  unshiftHistory as unshiftHistoryBag,
  type HistoryBag,
} from "./history";
import {
  activeHistoryBag,
  activeNavMode,
  clampSlideshowDurationSec,
  composeNavMode,
  isNavMode,
  isNavSessionStale,
  isSequentialMode,
  isSlideshowActive,
  reconcileBrowseHistoryWithCurrent,
  resetHistory,
  setCurrentMedia,
  state,
  type NavMode,
  type NavOrder,
  type NavScope,
} from "./state";
import { isOverChrome } from "./ui/chrome";
import { showMedia } from "./ui/stage";
import { clearTagPresentation, onMediaDisplayed } from "./ui/tags";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let statusClearTimer: number | null = null;

/** Fired after a successful next/prev step (for slideshow timer reset). */
let onNavStepListener: (() => void) | null = null;

/** Fired after media is shown (toolbar filename / folder lists). */
let onMediaChromeListener: (() => void) | null = null;

/** Fired when global nav mode or duration changes (toolbar / settings sync). */
let onNavSettingsListener: (() => void) | null = null;

/** Serialized last_media_id writes — always flush the latest id. */
let lastMediaWriteQueue: Promise<void> = Promise.resolve();
let latestLastMediaId: number | null = null;

export function initNav(statusFn: StatusFn): void {
  setStatus = statusFn;
}

/** Slideshow registers this to reset the duration clock on manual next/prev. */
export function setNavStepListener(fn: (() => void) | null): void {
  onNavStepListener = fn;
}

/** Top toolbar registers this to refresh folder/file chrome after display. */
export function setMediaChromeListener(fn: (() => void) | null): void {
  onMediaChromeListener = fn;
}

/** Toolbar / settings register to keep dropdowns in sync. */
export function setNavSettingsListener(fn: (() => void) | null): void {
  onNavSettingsListener = fn;
}

function notifyNavStep(): void {
  try {
    onNavStepListener?.();
  } catch (err) {
    console.warn("nav step listener failed", err);
  }
}

function notifyMediaChrome(): void {
  try {
    onMediaChromeListener?.();
  } catch (err) {
    console.warn("media chrome listener failed", err);
  }
}

function notifyNavSettings(): void {
  try {
    onNavSettingsListener?.();
  } catch (err) {
    console.warn("nav settings listener failed", err);
  }
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

/**
 * Apply tag panel / badges after stage knows whether the file is present.
 * Disk-missing (not soft-flagged) is treated like isMissing for badges/sounds.
 */
function applyTagsAfterPresent(
  item: MediaItem,
  present: "ready" | "missing" | "aborted",
): void {
  if (present === "aborted") return;
  if (present === "missing") {
    // Panel still editable; badges/sounds only when file is on disk.
    onMediaDisplayed({ ...item, isMissing: true });
    return;
  }
  onMediaDisplayed(item);
}

/** Show an item already resolved from DB; does not touch history. */
export async function displayMedia(item: MediaItem): Promise<void> {
  setCurrentMedia(item);
  // Stop previous badges/sounds immediately; wait for path check before new ones.
  clearTagPresentation();
  const present = await showMedia(item);
  applyTagsAfterPresent(item, present);
  // Filename is shown in the top toolbar file selector — no bottom flash.
  notifyMediaChrome();
  // Await so navigating gate covers the write; queue keeps latest id wins.
  await persistLastMediaId(item.id);
}

/**
 * displayMedia for goNext/goPrev/walkHistory (generation-aware).
 *
 * - If already stale before apply: skip setCurrentMedia/showMedia entirely.
 * - If Stop/Start races during the persist await after apply: re-tip browse at
 *   the final current so Prev matches the item on screen (ISSUE-5).
 *
 * @returns true when the nav session is still live
 */
async function displayMediaForNav(
  item: MediaItem,
  generation: number,
): Promise<boolean> {
  if (isNavSessionStale(generation)) return false;

  setCurrentMedia(item);
  clearTagPresentation();
  const present = await showMedia(item);
  if (isNavSessionStale(generation)) {
    // Stage may have applied media for a now-stale session; abandon tag apply.
    return false;
  }
  applyTagsAfterPresent(item, present);
  notifyMediaChrome();
  await persistLastMediaId(item.id);

  if (isNavSessionStale(generation)) {
    // Stop reconciled against pre-display id while we were in flight; retip.
    reconcileBrowseHistoryWithCurrent();
    return false;
  }
  return true;
}

/** Direct jump: reset browse history to [id] and show. */
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

/** Parent-dir constraint for current-folder modes. */
function parentDirForMode(mode: NavMode): string | null {
  if (mode === "alpha_current_dir" || mode === "random_current_dir") {
    return state.currentMedia?.parentDir ?? null;
  }
  return null;
}

async function pickRandomNext(
  mode: NavMode,
  excludeId: number | null,
): Promise<MediaItem | null> {
  const root = state.root;
  if (!root) return null;
  if (mode === "random_current_dir") {
    const parent = state.currentMedia?.parentDir ?? null;
    return getRandom(root.id, parent, excludeId);
  }
  return getRandom(root.id, null, excludeId);
}

/**
 * Walk a frozen history bag: peek → load → commit on success.
 * Aborts cleanly if nav session generation changes mid-flight (Stop/Start).
 *
 * @returns "loaded" | "exhausted" | "error" | "aborted"
 */
async function walkHistory(
  bag: HistoryBag,
  direction: "back" | "forward",
  generation: number,
): Promise<"loaded" | "exhausted" | "error" | "aborted"> {
  let skipped = 0;
  while (true) {
    if (isNavSessionStale(generation)) return "aborted";

    const id =
      direction === "back" ? peekBackBag(bag) : peekForwardBag(bag);
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
      if (isNavSessionStale(generation)) return "aborted";

      if (!item) {
        // Hard-deleted / gone row — drop slot and retry next neighbor.
        if (!removeNeighborBag(bag, direction)) {
          return "exhausted";
        }
        skipped += 1;
        continue;
      }
      if (direction === "back") commitBackBag(bag);
      else commitForwardBag(bag);
      if (!(await displayMediaForNav(item, generation))) return "aborted";
      return "loaded";
    } catch (err) {
      console.error("history load failed", err);
      flashStatus(`Navigate failed: ${formatErr(err)}`, 4000);
      return "error";
    }
  }
}

/** Next item per active nav mode + history rules. */
export async function goNext(): Promise<void> {
  if (!canNavigate() || state.currentMediaId == null) return;

  // Freeze bag + mode + generation so Stop mid-await cannot redirect writes.
  const bag = activeHistoryBag();
  const mode = activeNavMode();
  const generation = state.navSessionGeneration;
  const startId = state.currentMediaId;

  state.navigating = true;
  try {
    // Random modes: replay forward history when not at tip (peek, then commit).
    if (!isSequentialMode(mode)) {
      const result = await walkHistory(bag, "forward", generation);
      if (result === "loaded") {
        if (!isNavSessionStale(generation)) notifyNavStep();
        return;
      }
      if (result === "error" || result === "aborted") return;
      // exhausted → pick a new random item below
    }

    if (isNavSessionStale(generation)) return;

    let item: MediaItem | null = null;
    if (isSequentialMode(mode)) {
      item = await getNeighbor(startId, "next", parentDirForMode(mode));
    } else {
      item = await pickRandomNext(mode, startId);
    }

    if (isNavSessionStale(generation)) return;
    if (!item) return;

    // Single-item library / same id: keep history stable, skip media rebuild.
    if (item.id === state.currentMediaId) {
      pushHistoryBag(bag, item.id);
      if (!isNavSessionStale(generation)) notifyNavStep();
      return;
    }

    pushHistoryBag(bag, item.id);
    if (isNavSessionStale(generation)) return;
    if (await displayMediaForNav(item, generation)) {
      notifyNavStep();
    }
  } catch (err) {
    console.error("goNext failed", err);
    flashStatus(`Navigate failed: ${formatErr(err)}`, 4000);
  } finally {
    state.navigating = false;
  }
}

/**
 * Previous: history first; when exhausted past the start:
 * - sequential: SQL-prev (wraps within all/current scope) and unshift
 * - random: pick a new random item and unshift so history grows infinitely
 *   in both directions (browse + slideshow share this path)
 */
export async function goPrev(): Promise<void> {
  if (!canNavigate() || state.currentMediaId == null) return;

  const bag = activeHistoryBag();
  const mode = activeNavMode();
  const generation = state.navSessionGeneration;
  const startId = state.currentMediaId;

  state.navigating = true;
  try {
    const result = await walkHistory(bag, "back", generation);
    if (result === "loaded") {
      if (!isNavSessionStale(generation)) notifyNavStep();
      return;
    }
    if (result === "error" || result === "aborted") return;
    // exhausted history — extend past the start (sequential wrap or new random)

    if (isNavSessionStale(generation)) return;

    let item: MediaItem | null = null;
    if (isSequentialMode(mode)) {
      item = await getNeighbor(startId, "prev", parentDirForMode(mode));
    } else {
      // Mirror goNext at the tip: grow history with a fresh random pick.
      item = await pickRandomNext(mode, startId);
    }

    if (isNavSessionStale(generation)) return;
    if (!item) return;

    // Single-item library / same id: keep history stable, skip media rebuild.
    if (item.id === state.currentMediaId) {
      unshiftHistoryBag(bag, item.id);
      if (!isNavSessionStale(generation)) notifyNavStep();
      return;
    }

    unshiftHistoryBag(bag, item.id);
    if (isNavSessionStale(generation)) return;
    if (await displayMediaForNav(item, generation)) {
      notifyNavStep();
    }
  } catch (err) {
    console.error("goPrev failed", err);
    flashStatus(`Navigate failed: ${formatErr(err)}`, 4000);
  } finally {
    state.navigating = false;
  }
}

/** Set global nav mode (browse + slideshow). Persists and keeps legacy key in sync. */
export async function setNavMode(mode: NavMode): Promise<void> {
  state.navMode = mode;
  state.slideshowNavMode = mode;
  try {
    await settingsSet("nav_mode", JSON.stringify(mode));
  } catch (err) {
    console.warn("persist nav_mode failed", err);
  }
  // Keep legacy slideshow_nav_mode key aligned so older builds still read sense.
  try {
    await settingsSet("slideshow_nav_mode", JSON.stringify(mode));
  } catch (err) {
    console.warn("persist slideshow_nav_mode failed", err);
  }
  notifyNavSettings();
}

/** Compose from order × scope dropdowns. */
export async function setNavOrderAndScope(
  order: NavOrder,
  scope: NavScope,
): Promise<void> {
  await setNavMode(composeNavMode(order, scope));
}

/**
 * @deprecated Use setNavMode — slideshow shares the global mode.
 * Kept so existing call sites compile until fully removed.
 */
export async function setSlideshowNavMode(mode: NavMode): Promise<void> {
  await setNavMode(mode);
}

export async function setSlideshowDurationSec(seconds: number): Promise<void> {
  const clamped = clampSlideshowDurationSec(seconds);
  state.slideshowDurationSec = clamped;
  try {
    await settingsSet("slideshow_duration_sec", JSON.stringify(clamped));
  } catch (err) {
    console.warn("persist slideshow_duration_sec failed", err);
  }
  // Duration change while playing: reschedule from full new duration.
  if (isSlideshowActive()) {
    notifyNavStep();
  }
  notifyNavSettings();
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

/**
 * Wire mouse wheel: up = previous, down = next.
 * Ignores chrome / form controls; debounced by navigating gate.
 */
export function wireNavWheel(stageEl: HTMLElement): void {
  stageEl.addEventListener(
    "wheel",
    (e) => {
      if (isNavClickBlocked(e.target)) return;
      // Ignore trackpad pinch / modified gestures
      if (e.ctrlKey || e.metaKey) return;
      // Prefer vertical delta; fall back to horizontal for shift-wheel / tilted
      const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (dy === 0) return;
      e.preventDefault();
      if (dy < 0) {
        void goPrev();
      } else {
        void goNext();
      }
    },
    { passive: false },
  );
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
