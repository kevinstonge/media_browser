/**
 * Hover hit-region helpers for chrome overlays.
 * Shared selectors for nav click exclusion and future chrome wiring.
 */

/** Padded hit regions + overlay roots that must not trigger stage navigation. */
export const CHROME_SELECTORS =
  ".settings-chrome, .slideshow-chrome, .tags-chrome, .nav-exclude";

/** Returns true if the element (or an ancestor) is a nav-excluded chrome region. */
export function isOverChrome(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(CHROME_SELECTORS));
}

export function mountChrome(_root: HTMLElement): void {
  // Reserved for shared chrome wiring in later PRs.
}
