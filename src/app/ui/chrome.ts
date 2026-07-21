/**
 * Hover hit-region helpers for chrome overlays.
 * Shared selectors for nav click exclusion and toolbar auto-hide reveal.
 */

/** Padded hit regions + overlay roots that must not trigger stage navigation. */
export const CHROME_SELECTORS =
  ".slideshow-chrome, .help-overlay, .tag-manager-overlay, .root-folder-overlay, .stage-empty-actions, .stage-empty-card-actions, .nav-exclude";

/** Keep toolbar visible briefly after a dropdown item is chosen. */
const TOOLBAR_HIDE_DELAY_MS = 3000;

let appEl: HTMLElement | null = null;
let chromeEl: HTMLElement | null = null;
let pointerInTopZone = false;
/** Last known pointer position in viewport coords (for resize re-check). */
let lastPointerClientX = 0;
let lastPointerClientY = 0;
let hasPointerSample = false;
let hideDelayTimer: number | null = null;
let autoHideWired = false;

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

/**
 * Pointer-Y auto-hide for the top toolbar.
 *
 * H = toolbar bar height + 2 × natural top padding (distance from app top to bar top).
 * Reveal when the cursor is in the top H px of the app, any toolbar dropdown is open,
 * a native toolbar <select> is focused, or a post-selection hide delay is active.
 */
export function mountToolbarAutoHide(app: HTMLElement, chrome: HTMLElement): void {
  appEl = app;
  chromeEl = chrome;

  if (!autoHideWired) {
    autoHideWired = true;
    document.addEventListener("pointermove", onToolbarPointerMove, {
      passive: true,
    });
    // Leaving the window / document clears the top-zone flag.
    document.documentElement.addEventListener("mouseleave", onToolbarPointerLeave);
    window.addEventListener("blur", onToolbarPointerLeave);
    window.addEventListener("resize", onToolbarRevealLayoutChange, {
      passive: true,
    });
  }

  // Focus on native selects keeps the bar up while the OS menu is open.
  chrome.addEventListener("focusin", updateToolbarReveal);
  chrome.addEventListener("focusout", () => {
    // focusout fires before the next focus lands; defer to see the new target.
    window.setTimeout(updateToolbarReveal, 0);
  });

  updateToolbarReveal();
}

/** Re-evaluate reveal after open/close of custom toolbar dropdowns. */
export function notifyToolbarDropdownChanged(): void {
  updateToolbarReveal();
}

/**
 * After a dropdown item is chosen: keep the toolbar visible for 3s even if the
 * cursor is below H, then re-apply the normal Y / open-menu rules.
 */
export function armToolbarHideDelay(): void {
  clearToolbarHideDelayTimer();
  hideDelayTimer = window.setTimeout(() => {
    hideDelayTimer = null;
    updateToolbarReveal();
  }, TOOLBAR_HIDE_DELAY_MS);
  updateToolbarReveal();
}

/** Cancel a pending post-selection hold (e.g. menus dismissed without a selection). */
export function clearToolbarHideDelay(): void {
  clearToolbarHideDelayTimer();
  updateToolbarReveal();
}

function clearToolbarHideDelayTimer(): void {
  if (hideDelayTimer != null) {
    window.clearTimeout(hideDelayTimer);
    hideDelayTimer = null;
  }
}

function isHideDelayActive(): boolean {
  return hideDelayTimer != null;
}

/**
 * H = bar height + 2 × (barTop − appTop).
 * Falls back to the chrome root height when the bar is missing.
 */
function measureRevealHeight(): number {
  if (!appEl || !chromeEl) return 0;
  const bar = chromeEl.querySelector<HTMLElement>(".slideshow-bar");
  if (!bar) return chromeEl.offsetHeight;

  const appRect = appEl.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const naturalPad = Math.max(0, barRect.top - appRect.top);
  return barRect.height + 2 * naturalPad;
}

function isAnyToolbarDropdownOpen(): boolean {
  if (!chromeEl) return false;
  return Boolean(chromeEl.querySelector(".toolbar-dropdown:not([hidden])"));
}

function isToolbarSelectFocused(): boolean {
  if (!chromeEl) return false;
  const active = document.activeElement;
  return Boolean(
    active instanceof HTMLSelectElement && chromeEl.contains(active),
  );
}

function computePointerInTopZone(clientX: number, clientY: number): boolean {
  if (!appEl) return false;
  const rect = appEl.getBoundingClientRect();
  const y = clientY - rect.top;
  const x = clientX - rect.left;
  const h = measureRevealHeight();
  return h > 0 && y >= 0 && y < h && x >= 0 && x <= rect.width;
}

function onToolbarPointerMove(e: PointerEvent): void {
  lastPointerClientX = e.clientX;
  lastPointerClientY = e.clientY;
  hasPointerSample = true;
  const inZone = computePointerInTopZone(e.clientX, e.clientY);
  if (inZone === pointerInTopZone) return;
  pointerInTopZone = inZone;
  updateToolbarReveal();
}

function onToolbarPointerLeave(): void {
  hasPointerSample = false;
  if (!pointerInTopZone) return;
  pointerInTopZone = false;
  updateToolbarReveal();
}

function onToolbarRevealLayoutChange(): void {
  // H may change with window size / toolbar wrap; re-check last pointer sample.
  if (hasPointerSample) {
    const inZone = computePointerInTopZone(
      lastPointerClientX,
      lastPointerClientY,
    );
    if (inZone !== pointerInTopZone) {
      pointerInTopZone = inZone;
    }
  }
  updateToolbarReveal();
}

function updateToolbarReveal(): void {
  if (!chromeEl) return;
  const show =
    pointerInTopZone ||
    isAnyToolbarDropdownOpen() ||
    isToolbarSelectFocused() ||
    isHideDelayActive();
  chromeEl.classList.toggle("toolbar-revealed", show);
}
