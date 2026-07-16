/**
 * Application session state.
 * Navigation history / slideshow timer land in later PRs.
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
  stageEmpty: StageEmptyReason;
  statusMessage: string;
}

export const state: AppState = {
  currentMediaId: null,
  currentMedia: null,
  root: null,
  navMode: "alpha",
  slideshowActive: false,
  scanning: false,
  stageEmpty: "no_root",
  statusMessage: "",
};

export function setCurrentMedia(item: MediaItem | null): void {
  state.currentMedia = item;
  state.currentMediaId = item?.id ?? null;
}
