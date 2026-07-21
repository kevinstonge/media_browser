/**
 * App bootstrap: load persisted nav/slideshow settings and restore the last
 * library root. Root folder select / re-scan lives on the main toolbar
 * (see rootFolder.ts). Fullscreen toggle lives on the toolbar (see slideshow.ts).
 */

import { settingsGet } from "../api";
import { parseNavMode } from "../nav";
import {
  clampSlideshowDurationSec,
  DEFAULT_SLIDESHOW_DURATION_SEC,
  state,
  type NavMode,
} from "../state";
import { restoreLastRoot } from "./rootFolder";
import { onSlideshowSettingsChanged } from "./slideshow";

export type StatusFn = (message: string, visible?: boolean) => void;

export function mountSettings(_root: HTMLElement, _statusFn: StatusFn): void {
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await loadSettings();
  await restoreLastRoot();
}

async function loadSettings(): Promise<void> {
  // Single global nav mode. Prefer nav_mode; fall back to legacy slideshow_nav_mode.
  let mode: NavMode = "alpha";
  try {
    const raw = await settingsGet("nav_mode");
    if (raw) {
      mode = parseNavMode(raw);
    } else {
      const legacy = await settingsGet("slideshow_nav_mode");
      if (legacy) mode = parseNavMode(legacy);
    }
  } catch (err) {
    console.warn("load nav_mode failed", err);
    mode = "alpha";
  }
  state.navMode = mode;
  state.slideshowNavMode = mode;

  try {
    const raw = await settingsGet("slideshow_duration_sec");
    let value: unknown = raw;
    if (raw != null) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    const sec = clampSlideshowDurationSec(value ?? DEFAULT_SLIDESHOW_DURATION_SEC);
    state.slideshowDurationSec = sec;
  } catch (err) {
    console.warn("load slideshow_duration_sec failed", err);
    state.slideshowDurationSec = DEFAULT_SLIDESHOW_DURATION_SEC;
  }

  // Sync top-toolbar selects + duration status with loaded settings.
  onSlideshowSettingsChanged();
}
