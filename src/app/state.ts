/**
 * Application session state: current media, nav mode, browse + slideshow history.
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

export type NavMode = "alpha" | "random_root" | "random_current_dir";

export type StageEmptyReason =
  | "no_root"
  | "no_media"
  | "loading"
  | "error"
  | null;

/** Slideshow session: idle = not in slideshow; playing / paused while active. */
export type SlideshowStatus = "idle" | "playing" | "paused";

export const DEFAULT_SLIDESHOW_DURATION_SEC = 5;

export interface AppState {
  currentMediaId: number | null;
  currentMedia: MediaItem | null;
  root: RootInfo | null;
  navMode: NavMode;
  /** Separate nav mode used only while slideshow is active. */
  slideshowNavMode: NavMode;
  /** Integer seconds between auto-advances (settings-backed). */
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

function browseBag(): HistoryBag {
  return browseBagProxy;
}

function slideshowBag(): HistoryBag {
  return slideshowBagProxy;
}

/** History bag currently used by next/prev (slideshow overrides browse). */
export function activeHistoryBag(): HistoryBag {
  return state.slideshowStatus !== "idle" ? slideshowBag() : browseBag();
}

/** Nav mode currently used by next/prev. */
export function activeNavMode(): NavMode {
  return state.slideshowStatus !== "idle"
    ? state.slideshowNavMode
    : state.navMode;
}

export function isSlideshowActive(): boolean {
  return state.slideshowStatus !== "idle";
}

export function setCurrentMedia(item: MediaItem | null): void {
  state.currentMedia = item;
  state.currentMediaId = item?.id ?? null;
}

// --- Browse history (always browse bag) ------------------------------------

/** Direct jump (scan, restore, pick): browse history becomes [id], cursor 0. */
export function resetHistory(id: number): void {
  resetHistoryBag(browseBag(), id);
}

export function clearHistory(): void {
  clearHistoryBag(browseBag());
}

export function pushHistory(id: number): void {
  pushHistoryBag(browseBag(), id);
}

export function peekHistoryBack(): number | null {
  return peekBackBag(browseBag());
}

export function peekHistoryForward(): number | null {
  return peekForwardBag(browseBag());
}

export function commitHistoryBack(): void {
  commitBackBag(browseBag());
}

export function commitHistoryForward(): void {
  commitForwardBag(browseBag());
}

export function unshiftHistory(id: number): void {
  unshiftHistoryBag(browseBag(), id);
}

/** Drop a dead neighbor id; keeps current entry selected. */
export function removeHistoryNeighbor(direction: "back" | "forward"): boolean {
  return removeNeighborBag(browseBag(), direction);
}

// --- Active (browse or slideshow) history — used by nav next/prev ----------

export function resetActiveHistory(id: number): void {
  resetHistoryBag(activeHistoryBag(), id);
}

export function clearActiveHistory(): void {
  clearHistoryBag(activeHistoryBag());
}

export function pushActiveHistory(id: number): void {
  pushHistoryBag(activeHistoryBag(), id);
}

export function peekActiveHistoryBack(): number | null {
  return peekBackBag(activeHistoryBag());
}

export function peekActiveHistoryForward(): number | null {
  return peekForwardBag(activeHistoryBag());
}

export function commitActiveHistoryBack(): void {
  commitBackBag(activeHistoryBag());
}

export function commitActiveHistoryForward(): void {
  commitForwardBag(activeHistoryBag());
}

export function unshiftActiveHistory(id: number): void {
  unshiftHistoryBag(activeHistoryBag(), id);
}

export function removeActiveHistoryNeighbor(
  direction: "back" | "forward",
): boolean {
  return removeNeighborBag(activeHistoryBag(), direction);
}

// --- Slideshow history only ------------------------------------------------

export function resetSlideshowHistory(id: number): void {
  resetHistoryBag(slideshowBag(), id);
}

export function clearSlideshowHistory(): void {
  clearHistoryBag(slideshowBag());
}

export function isNavMode(value: unknown): value is NavMode {
  return (
    value === "alpha" ||
    value === "random_root" ||
    value === "random_current_dir"
  );
}

export function clampSlideshowDurationSec(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SLIDESHOW_DURATION_SEC;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 3600) return 3600;
  return i;
}
