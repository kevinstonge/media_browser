/**
 * Application session state: current media, nav mode, browse history.
 */

import type { MediaItem, RootInfo } from "./api";

export type NavMode = "alpha" | "random_root" | "random_current_dir";

export type StageEmptyReason =
  | "no_root"
  | "no_media"
  | "loading"
  | "error"
  | null;

export interface AppState {
  currentMediaId: number | null;
  currentMedia: MediaItem | null;
  root: RootInfo | null;
  navMode: NavMode;
  slideshowActive: boolean;
  scanning: boolean;
  /** True while a next/prev resolve is in flight (debounce double-taps). */
  navigating: boolean;
  stageEmpty: StageEmptyReason;
  statusMessage: string;
  /** Browse session history of media_item ids. */
  history: number[];
  /** Index into history for the currently shown item. */
  historyCursor: number;
}

export const state: AppState = {
  currentMediaId: null,
  currentMedia: null,
  root: null,
  navMode: "alpha",
  slideshowActive: false,
  scanning: false,
  navigating: false,
  stageEmpty: "no_root",
  statusMessage: "",
  history: [],
  historyCursor: -1,
};

export function setCurrentMedia(item: MediaItem | null): void {
  state.currentMedia = item;
  state.currentMediaId = item?.id ?? null;
}

/** Direct jump (scan, restore, pick): history becomes [id], cursor 0. */
export function resetHistory(id: number): void {
  state.history = [id];
  state.historyCursor = 0;
}

export function clearHistory(): void {
  state.history = [];
  state.historyCursor = -1;
}

/**
 * Append a newly visited id after truncating any forward branch.
 * No-op if id is already the tip at cursor.
 */
export function pushHistory(id: number): void {
  if (state.historyCursor >= 0 && state.history[state.historyCursor] === id) {
    // Already showing this id at cursor — drop any forward entries only if needed.
    if (state.historyCursor < state.history.length - 1) {
      state.history = state.history.slice(0, state.historyCursor + 1);
    }
    return;
  }
  if (state.historyCursor < state.history.length - 1) {
    state.history = state.history.slice(0, state.historyCursor + 1);
  }
  state.history.push(id);
  state.historyCursor = state.history.length - 1;
}

/** Move cursor back one step. Returns id or null if already at start. */
export function historyBack(): number | null {
  if (state.historyCursor <= 0) return null;
  state.historyCursor -= 1;
  return state.history[state.historyCursor] ?? null;
}

/** Move cursor forward one step. Returns id or null if already at tip. */
export function historyForward(): number | null {
  if (state.historyCursor < 0) return null;
  if (state.historyCursor >= state.history.length - 1) return null;
  state.historyCursor += 1;
  return state.history[state.historyCursor] ?? null;
}

/** Prepend id when alpha-preving past the start of history. */
export function unshiftHistory(id: number): void {
  if (state.history[0] === id) {
    state.historyCursor = 0;
    return;
  }
  state.history.unshift(id);
  state.historyCursor = 0;
}

export function isNavMode(value: unknown): value is NavMode {
  return (
    value === "alpha" ||
    value === "random_root" ||
    value === "random_current_dir"
  );
}
