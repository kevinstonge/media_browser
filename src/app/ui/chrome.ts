/**
 * Hover hit-region helpers for chrome overlays.
 * Shared selectors for nav click exclusion and chrome wiring.
 */

/** Padded hit regions + overlay roots that must not trigger stage navigation. */
export const CHROME_SELECTORS =
  ".slideshow-chrome, .help-overlay, .tag-manager-overlay, .root-folder-overlay, .stage-empty-actions, .stage-empty-card-actions, .nav-exclude";

/** Returns true if the element (or an ancestor) is a nav-excluded chrome region. */
export function isOverChrome(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(CHROME_SELECTORS));
}

/**
 * Ensure padded hit regions stay interactive while media stage receives nav clicks.
 * Call after chrome mounts; safe to call once.
 */
export function mountChrome(root: HTMLElement): void {
  // Stabilize pointer targets: chrome roots already have ~10px padding in CSS.
  // Mark as nav-exclude so future dynamic chrome is covered if class is present.
  root.querySelectorAll(".slideshow-chrome").forEach((el) => {
    el.classList.add("nav-exclude");
    if (el instanceof HTMLElement) {
      // Explicit hit-testing: padding is part of the hover target.
      el.style.pointerEvents = "auto";
    }
  });
}
