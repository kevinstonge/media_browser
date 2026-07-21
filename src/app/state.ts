/**
 * Application session state: current media, nav mode, browse + slideshow history.
 *
 * Nav mode is a single global setting (order × scope) used by all inputs and by
 * the slideshow timer — slideshow only auto-sends "next" on an interval.
 */

import type { MediaItem, RootInfo } from "./api";
import {
  clearHistory as clearHistoryBag,
  commitHistoryBack as commitBackBag,
  commitHistoryForward as commitForwardBag,
  createHistory,
  peekHistoryBack as peekBackBag,
  peekHistoryForward as peekForwardBag,
  pushHistory as pushHistoryBag,
  removeHistoryNeighbor as removeNeighborBag,
  resetHistory as resetHistoryBag,
  unshiftHistory as unshiftHistoryBag,
  type HistoryBag,
} from "./history";

/** Sequential/random × all-folders/current-folder. */
export type NavMode =
  | "alpha"
  | "alpha_current_dir"
  | "random_root"
  | "random_current_dir";

export type NavOrder = "sequential" | "random";
export type NavScope = "all" | "current";

export type StageEmptyReason =
  | "no_root"
  | "no_media"
  | "loading"
  | "error"
  | null;

/** Slideshow session: idle = not in slideshow; playing / paused while active. */
export type SlideshowStatus = "idle" | "playing" | "paused";

export const DEFAULT_SLIDESHOW_DURATION_SEC = 5;

/** Allowed slideshow interval choices (seconds). */
export const SLIDESHOW_DURATION_OPTIONS = [
  5, 10, 15, 30, 60, 120, 300,
] as const;

export type SlideshowDurationSec = (typeof SLIDESHOW_DURATION_OPTIONS)[number];

export interface AppState {
  currentMediaId: number | null;
  currentMedia: MediaItem | null;
  root: RootInfo | null;
  /**
   * Single navigation mode for browse + slideshow.
   * (slideshowNavMode is kept in sync for legacy settings keys.)
   */
  navMode: NavMode;
  /** @deprecated Prefer navMode; kept equal to navMode for load migration. */
  slideshowNavMode: NavMode;
  /** Integer seconds between auto-advances (settings-backed; discrete options). */
  slideshowDurationSec: number;
  slideshowStatus: SlideshowStatus;
  scanning: boolean;
  /** True while a next/prev resolve is in flight (debounce double-taps). */
  navigating: boolean;
  stageEmpty: StageEmptyReason;
  statusMessage: string;
  /** Browse session history of media_item ids. */
  history: number[];
  /** Index into history for the currently shown item. */
  historyCursor: number;
  /** Slideshow session history (independent of browse history). */
  slideshowHistory: number[];
  slideshowHistoryCursor: number;
  /**
   * Bumped when slideshow session starts/stops so in-flight goNext/goPrev
   * can abandon commits against a stale session.
   */
  navSessionGeneration: number;
}

const browse0 = createHistory();
const slideshow0 = createHistory();

export const state: AppState = {
  currentMediaId: null,
  currentMedia: null,
  root: null,
  navMode: "alpha",
  slideshowNavMode: "alpha",
  slideshowDurationSec: DEFAULT_SLIDESHOW_DURATION_SEC,
  slideshowStatus: "idle",
  scanning: false,
  navigating: false,
  stageEmpty: "no_root",
  statusMessage: "",
  history: browse0.history,
  historyCursor: browse0.historyCursor,
  slideshowHistory: slideshow0.history,
  slideshowHistoryCursor: slideshow0.historyCursor,
  navSessionGeneration: 0,
};

/**
 * Mutable bags bound to state history fields.
 * History helpers reassign `.history` / `.historyCursor`; proxies keep state
 * as the source of truth.
 */
const browseBagProxy: HistoryBag = {
  get history() {
    return state.history;
  },
  set history(v: number[]) {
    state.history = v;
  },
  get historyCursor() {
    return state.historyCursor;
  },
  set historyCursor(v: number) {
    state.historyCursor = v;
  },
};

const slideshowBagProxy: HistoryBag = {
  get history() {
    return state.slideshowHistory;
  },
  set history(v: number[]) {
    state.slideshowHistory = v;
  },
  get historyCursor() {
    return state.slideshowHistoryCursor;
  },
  set historyCursor(v: number) {
    state.slideshowHistoryCursor = v;
  },
};

export function browseHistoryBag(): HistoryBag {
  return browseBagProxy;
}

export function slideshowHistoryBag(): HistoryBag {
  return slideshowBagProxy;
}

/** History bag currently used by next/prev (slideshow overrides browse). */
export function activeHistoryBag(): HistoryBag {
  return state.slideshowStatus !== "idle"
    ? slideshowHistoryBag()
    : browseHistoryBag();
}

/**
 * Nav mode for next/prev — always the global setting.
 * Slideshow only auto-fires goNext; it does not use a separate mode.
 */
export function activeNavMode(): NavMode {
  return state.navMode;
}

export function isSlideshowActive(): boolean {
  return state.slideshowStatus !== "idle";
}

/** Invalidate in-flight goNext/goPrev that captured an older generation. */
export function bumpNavSessionGeneration(): void {
  state.navSessionGeneration += 1;
}

export function isNavSessionStale(generation: number): boolean {
  return generation !== state.navSessionGeneration;
}

export function setCurrentMedia(item: MediaItem | null): void {
  state.currentMedia = item;
  state.currentMediaId = item?.id ?? null;
}

// --- Browse history (always browse bag) ------------------------------------

/** Direct jump (scan, restore, pick): browse history becomes [id], cursor 0. */
export function resetHistory(id: number): void {
  resetHistoryBag(browseHistoryBag(), id);
}

export function clearHistory(): void {
  clearHistoryBag(browseHistoryBag());
}

export function pushHistory(id: number): void {
  pushHistoryBag(browseHistoryBag(), id);
}

export function peekHistoryBack(): number | null {
  return peekBackBag(browseHistoryBag());
}

export function peekHistoryForward(): number | null {
  return peekForwardBag(browseHistoryBag());
}

export function commitHistoryBack(): void {
  commitBackBag(browseHistoryBag());
}

export function commitHistoryForward(): void {
  commitForwardBag(browseHistoryBag());
}

export function unshiftHistory(id: number): void {
  unshiftHistoryBag(browseHistoryBag(), id);
}

/** Drop a dead neighbor id; keeps current entry selected. */
export function removeHistoryNeighbor(direction: "back" | "forward"): boolean {
  return removeNeighborBag(browseHistoryBag(), direction);
}

// --- Slideshow history only ------------------------------------------------

export function resetSlideshowHistory(id: number): void {
  resetHistoryBag(slideshowHistoryBag(), id);
}

export function clearSlideshowHistory(): void {
  clearHistoryBag(slideshowHistoryBag());
}

/**
 * True when the active nav bag (browse or slideshow) has more than the
 * current tip — i.e. Prev/Next would walk stored history.
 */
export function canResetActiveHistory(): boolean {
  if (state.currentMediaId == null) return false;
  return activeHistoryBag().history.length > 1;
}

/**
 * Collapse active view history to `[currentId]` so the next Prev/Next
 * extends a fresh path (new random pick, or sequential neighbor from here).
 * Keeps the displayed media. Returns true if the bag was changed.
 */
export function resetActiveHistoryToCurrent(): boolean {
  const id = state.currentMediaId;
  if (id == null) return false;
  const bag = activeHistoryBag();
  if (
    bag.history.length === 1 &&
    bag.historyCursor === 0 &&
    bag.history[0] === id
  ) {
    return false;
  }
  resetHistoryBag(bag, id);
  return true;
}

/**
 * After leaving slideshow, ensure browse history tip matches the displayed item
 * so Prev/Next from Stop continue from current (without wiping the stack).
 * Prefers push-if-not-at-cursor over resetHistory.
 */
export function reconcileBrowseHistoryWithCurrent(): void {
  const id = state.currentMediaId;
  if (id == null) return;
  const atCursor =
    state.historyCursor >= 0 && state.history[state.historyCursor] === id;
  if (!atCursor) {
    pushHistory(id);
  }
}

export function isNavMode(value: unknown): value is NavMode {
  return (
    value === "alpha" ||
    value === "alpha_current_dir" ||
    value === "random_root" ||
    value === "random_current_dir"
  );
}

export function isNavOrder(value: unknown): value is NavOrder {
  return value === "sequential" || value === "random";
}

export function isNavScope(value: unknown): value is NavScope {
  return value === "all" || value === "current";
}

/** Compose order × scope into the stored NavMode. */
export function composeNavMode(order: NavOrder, scope: NavScope): NavMode {
  if (order === "random") {
    return scope === "current" ? "random_current_dir" : "random_root";
  }
  return scope === "current" ? "alpha_current_dir" : "alpha";
}

export function navModeOrder(mode: NavMode): NavOrder {
  return mode === "random_root" || mode === "random_current_dir"
    ? "random"
    : "sequential";
}

export function navModeScope(mode: NavMode): NavScope {
  return mode === "alpha_current_dir" || mode === "random_current_dir"
    ? "current"
    : "all";
}

/** True for alphabetical / sequential modes (SQL neighbor, not random pick). */
export function isSequentialMode(mode: NavMode): boolean {
  return mode === "alpha" || mode === "alpha_current_dir";
}

/**
 * Snap duration to nearest allowed option (or default).
 * Accepts legacy free-form values by rounding to closest preset.
 */
export function clampSlideshowDurationSec(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SLIDESHOW_DURATION_SEC;
  const i = Math.floor(n);
  if (i < 1) return SLIDESHOW_DURATION_OPTIONS[0];

  let best: number = SLIDESHOW_DURATION_OPTIONS[0];
  let bestDist = Math.abs(i - best);
  for (const opt of SLIDESHOW_DURATION_OPTIONS) {
    const d = Math.abs(i - opt);
    if (d < bestDist) {
      best = opt;
      bestDist = d;
    }
  }
  return best;
}
