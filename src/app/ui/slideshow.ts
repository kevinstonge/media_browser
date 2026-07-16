/**
 * Slideshow toolbar (bottom-right, hover-reveal) + timer.
 *
 * Start: clear slideshow history; seed with current (or first); play; schedule timer.
 * Pause: cancel timer; keep history + cursor; stay in slideshow mode.
 * Resume: restart timer from full duration.
 * Stop: cancel timer; erase slideshow history; exit slideshow mode.
 *
 * Manual next/prev while active use slideshow nav mode + history (via nav.ts)
 * and reset the duration clock through the nav step listener.
 */

import { getFirstMedia } from "../api";
import {
  displayMedia,
  goNext,
  setNavStepListener,
  type StatusFn,
} from "../nav";
import {
  bumpNavSessionGeneration,
  clearSlideshowHistory,
  reconcileBrowseHistoryWithCurrent,
  resetSlideshowHistory,
  state,
} from "../state";

let setStatus: StatusFn = () => {};
let timerId: number | null = null;
let startBtn: HTMLButtonElement | null = null;
let pauseBtn: HTMLButtonElement | null = null;
let resumeBtn: HTMLButtonElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;

export function mountSlideshow(root: HTMLElement, statusFn: StatusFn): void {
  setStatus = statusFn;

  const chrome = document.createElement("div");
  chrome.className = "slideshow-chrome nav-exclude";
  chrome.innerHTML = `
    <div class="slideshow-bar" role="toolbar" aria-label="Slideshow">
      <span class="slideshow-status" id="slideshow-status" aria-live="polite"></span>
      <button type="button" class="slideshow-btn" id="slideshow-start" title="Start slideshow">Start</button>
      <button type="button" class="slideshow-btn" id="slideshow-pause" title="Pause slideshow" hidden>Pause</button>
      <button type="button" class="slideshow-btn" id="slideshow-resume" title="Resume slideshow" hidden>Resume</button>
      <button type="button" class="slideshow-btn" id="slideshow-stop" title="Stop slideshow" hidden>Stop</button>
    </div>
  `;
  root.appendChild(chrome);

  startBtn = chrome.querySelector("#slideshow-start");
  pauseBtn = chrome.querySelector("#slideshow-pause");
  resumeBtn = chrome.querySelector("#slideshow-resume");
  stopBtn = chrome.querySelector("#slideshow-stop");
  statusEl = chrome.querySelector("#slideshow-status");

  startBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void startSlideshow();
  });
  pauseBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    pauseSlideshow();
  });
  resumeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    resumeSlideshow();
  });
  stopBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    stopSlideshow();
  });

  // Any successful next/prev (manual or timer-driven) resets the clock while playing.
  setNavStepListener(() => {
    if (state.slideshowStatus === "playing") {
      scheduleTimer();
    }
  });

  updateControls();
}

function cancelTimer(): void {
  if (timerId != null) {
    window.clearTimeout(timerId);
    timerId = null;
  }
}

function scheduleTimer(): void {
  cancelTimer();
  if (state.slideshowStatus !== "playing") return;
  // Duration is clamped on set/load; still guard NaN/0 for safety.
  const sec = Math.max(1, state.slideshowDurationSec || 1);
  const ms = sec * 1000;
  timerId = window.setTimeout(() => {
    timerId = null;
    void onTimerTick();
  }, ms);
}

async function onTimerTick(): Promise<void> {
  if (state.slideshowStatus !== "playing") return;
  // goNext notifies the step listener, which reschedules when still playing.
  await goNext();
  // If goNext was a no-op (e.g. empty / blocked), ensure we keep ticking.
  if (state.slideshowStatus === "playing" && timerId == null) {
    scheduleTimer();
  }
}

/**
 * Enter slideshow: clear slideshow history, seed current (or first), play.
 * Browse history is left untouched.
 */
export async function startSlideshow(): Promise<void> {
  if (state.scanning || !state.root || state.root.id <= 0) {
    setStatus("Select and scan a folder first", true);
    window.setTimeout(() => setStatus("", false), 2500);
    return;
  }
  if (state.root.itemCount === 0) {
    setStatus("No media for slideshow", true);
    window.setTimeout(() => setStatus("", false), 2500);
    return;
  }

  // Invalidate any in-flight browse nav so it cannot write slideshow bag mid-start.
  bumpNavSessionGeneration();
  clearSlideshowHistory();

  try {
    if (state.currentMediaId != null && state.currentMedia) {
      resetSlideshowHistory(state.currentMediaId);
    } else {
      const first = await getFirstMedia(state.root.id);
      if (!first) {
        setStatus("No media for slideshow", true);
        window.setTimeout(() => setStatus("", false), 2500);
        return;
      }
      resetSlideshowHistory(first.id);
      await displayMedia(first);
    }
  } catch (err) {
    console.error("startSlideshow failed", err);
    setStatus(`Slideshow failed: ${formatErr(err)}`, true);
    clearSlideshowHistory();
    state.slideshowStatus = "idle";
    bumpNavSessionGeneration();
    updateControls();
    return;
  }

  state.slideshowStatus = "playing";
  // Fresh generation for the playing session (invalidates any race from seed await).
  bumpNavSessionGeneration();
  scheduleTimer();
  updateControls();
  setStatus(
    `Slideshow · ${state.slideshowDurationSec}s · ${labelMode(state.slideshowNavMode)}`,
    true,
  );
  window.setTimeout(() => setStatus("", false), 2500);
}

/** Cancel timer; keep slideshow history + current item; stay in mode. */
export function pauseSlideshow(): void {
  if (state.slideshowStatus !== "playing") return;
  cancelTimer();
  state.slideshowStatus = "paused";
  updateControls();
  setStatus("Slideshow paused", true);
  window.setTimeout(() => setStatus("", false), 2000);
}

/** Restart timer from full duration. */
export function resumeSlideshow(): void {
  if (state.slideshowStatus !== "paused") return;
  state.slideshowStatus = "playing";
  scheduleTimer();
  updateControls();
  setStatus("Slideshow resumed", true);
  window.setTimeout(() => setStatus("", false), 2000);
}

/**
 * Exit slideshow: cancel timer, erase slideshow history.
 * Current media remains; browse history is reconciled so Prev continues
 * from the displayed item (stack preserved via push, not reset).
 *
 * Bumps nav session generation first so any in-flight goNext/goPrev that
 * captured the slideshow bag abandons further commits/displays.
 */
export function stopSlideshow(): void {
  if (state.slideshowStatus === "idle") return;
  cancelTimer();
  // Invalidate in-flight nav before flipping status → idle (avoids browse writes).
  bumpNavSessionGeneration();
  clearSlideshowHistory();
  state.slideshowStatus = "idle";
  // Manual browse continues on current item: tip browse history at current.
  reconcileBrowseHistoryWithCurrent();
  updateControls();
  setStatus("Slideshow stopped", true);
  window.setTimeout(() => setStatus("", false), 2000);
}

/** Reschedule if playing after settings duration change (also via nav listener). */
export function onSlideshowSettingsChanged(): void {
  if (state.slideshowStatus === "playing") {
    scheduleTimer();
  }
  updateControls();
}

function updateControls(): void {
  const status = state.slideshowStatus;
  if (startBtn) startBtn.hidden = status !== "idle";
  if (pauseBtn) pauseBtn.hidden = status !== "playing";
  if (resumeBtn) resumeBtn.hidden = status !== "paused";
  if (stopBtn) stopBtn.hidden = status === "idle";

  if (statusEl) {
    if (status === "playing") {
      statusEl.textContent = `▶ ${state.slideshowDurationSec}s`;
    } else if (status === "paused") {
      statusEl.textContent = "❚❚";
    } else {
      statusEl.textContent = "";
    }
  }
}

function labelMode(mode: string): string {
  switch (mode) {
    case "alpha":
      return "alpha";
    case "random_root":
      return "random";
    case "random_current_dir":
      return "random folder";
    default:
      return mode;
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
