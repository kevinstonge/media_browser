/**
 * Hover hit-region helpers for chrome overlays.
 * Navigation clicks are excluded over `.nav-exclude` / settings chrome (see nav.ts).
 */

/** Returns true if the element (or an ancestor) is a nav-excluded chrome region. */
export function isOverChrome(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      ".settings-chrome, .slideshow-chrome, .tags-chrome, .nav-exclude",
    ),
  );
}

export function mountChrome(_root: HTMLElement): void {
  // Reserved for shared chrome wiring in later PRs.
}
