/**
 * Application session state (stubs for later PRs).
 * Navigation, slideshow timer, and history live here.
 */

export type NavMode = "alpha" | "random_root" | "random_current_dir";

export interface AppState {
  currentMediaId: number | null;
  navMode: NavMode;
  slideshowActive: boolean;
}

export const state: AppState = {
  currentMediaId: null,
  navMode: "alpha",
  slideshowActive: false,
};
