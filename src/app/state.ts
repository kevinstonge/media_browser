/**
 * Application session state: current media, nav mode, browse history.
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

const hist0 = createHistory();

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
  history: hist0.history,
  historyCursor: hist0.historyCursor,
};

/** View of global history fields as a HistoryBag (shared arrays/cursor). */
function hist(): HistoryBag {
  return state;
}

export function setCurrentMedia(item: MediaItem | null): void {
  state.currentMedia = item;
  state.currentMediaId = item?.id ?? null;
}

/** Direct jump (scan, restore, pick): history becomes [id], cursor 0. */
export function resetHistory(id: number): void {
  resetHistoryBag(hist(), id);
}

export function clearHistory(): void {
  clearHistoryBag(hist());
}

export function pushHistory(id: number): void {
  pushHistoryBag(hist(), id);
}

export function peekHistoryBack(): number | null {
  return peekBackBag(hist());
}

export function peekHistoryForward(): number | null {
  return peekForwardBag(hist());
}

export function commitHistoryBack(): void {
  commitBackBag(hist());
}

export function commitHistoryForward(): void {
  commitForwardBag(hist());
}

export function unshiftHistory(id: number): void {
  unshiftHistoryBag(hist(), id);
}

/** Drop a dead neighbor id; keeps current entry selected. */
export function removeHistoryNeighbor(direction: "back" | "forward"): boolean {
  return removeNeighborBag(hist(), direction);
}

export function isNavMode(value: unknown): value is NavMode {
  return (
    value === "alpha" ||
    value === "random_root" ||
    value === "random_current_dir"
  );
}
