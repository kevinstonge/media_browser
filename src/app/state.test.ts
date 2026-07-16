/**
 * Unit tests for dual-history switching, stop reconcile, duration clamp.
 * Run: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  activeHistoryBag,
  activeNavMode,
  browseHistoryBag,
  bumpNavSessionGeneration,
  clampSlideshowDurationSec,
  clearHistory,
  clearSlideshowHistory,
  DEFAULT_SLIDESHOW_DURATION_SEC,
  isNavSessionStale,
  isSlideshowActive,
  pushHistory,
  reconcileBrowseHistoryWithCurrent,
  resetHistory,
  resetSlideshowHistory,
  slideshowHistoryBag,
  state,
} from "./state.ts";

/** Reset mutable session fields between cases (module-level state). */
function resetSession(): void {
  state.currentMediaId = null;
  state.currentMedia = null;
  state.navMode = "alpha";
  state.slideshowNavMode = "random_root";
  state.slideshowDurationSec = DEFAULT_SLIDESHOW_DURATION_SEC;
  state.slideshowStatus = "idle";
  state.scanning = false;
  state.navigating = false;
  clearHistory();
  clearSlideshowHistory();
  // Leave generation as-is (monotonic); tests that care capture before/after.
}

describe("activeHistoryBag / activeNavMode", () => {
  beforeEach(resetSession);

  it("uses browse bag + navMode when slideshow idle", () => {
    state.slideshowStatus = "idle";
    state.navMode = "alpha";
    state.slideshowNavMode = "random_root";
    assert.equal(activeHistoryBag(), browseHistoryBag());
    assert.equal(activeNavMode(), "alpha");
    assert.equal(isSlideshowActive(), false);
  });

  it("uses slideshow bag + slideshowNavMode when playing", () => {
    state.slideshowStatus = "playing";
    state.navMode = "alpha";
    state.slideshowNavMode = "random_current_dir";
    assert.equal(activeHistoryBag(), slideshowHistoryBag());
    assert.equal(activeNavMode(), "random_current_dir");
    assert.equal(isSlideshowActive(), true);
  });

  it("uses slideshow bag while paused (still active)", () => {
    state.slideshowStatus = "paused";
    state.navMode = "alpha";
    state.slideshowNavMode = "random_root";
    assert.equal(activeHistoryBag(), slideshowHistoryBag());
    assert.equal(activeNavMode(), "random_root");
    assert.equal(isSlideshowActive(), true);
  });

  it("browse and slideshow bags stay independent", () => {
    resetHistory(1);
    pushHistory(2);
    pushHistory(3);
    resetSlideshowHistory(10);
    // "advance" slideshow only
    const s = slideshowHistoryBag();
    s.history = [10, 11, 12];
    s.historyCursor = 2;

    assert.deepEqual(state.history, [1, 2, 3]);
    assert.equal(state.historyCursor, 2);
    assert.deepEqual(state.slideshowHistory, [10, 11, 12]);
    assert.equal(state.slideshowHistoryCursor, 2);

    clearSlideshowHistory();
    assert.deepEqual(state.history, [1, 2, 3]);
    assert.equal(state.historyCursor, 2);
    assert.deepEqual(state.slideshowHistory, []);
    assert.equal(state.slideshowHistoryCursor, -1);
  });
});

describe("reconcileBrowseHistoryWithCurrent (Stop semantics)", () => {
  beforeEach(resetSession);

  it("does not clear browse stack", () => {
    resetHistory(1);
    pushHistory(2);
    pushHistory(3);
    state.currentMediaId = 6;
    reconcileBrowseHistoryWithCurrent();
    assert.ok(state.history.includes(1));
    assert.ok(state.history.includes(2));
    assert.ok(state.history.includes(3));
  });

  it("pushes current when cursor points at pre-slideshow tip", () => {
    // Browse [1,2,3] cursor on 3; slideshow left us on 6
    resetHistory(1);
    pushHistory(2);
    pushHistory(3);
    state.currentMediaId = 6;
    reconcileBrowseHistoryWithCurrent();
    assert.deepEqual(state.history, [1, 2, 3, 6]);
    assert.equal(state.historyCursor, 3);
    assert.equal(state.history[state.historyCursor], 6);
  });

  it("is no-op when current already at browse cursor", () => {
    resetHistory(1);
    pushHistory(2);
    state.currentMediaId = 2;
    reconcileBrowseHistoryWithCurrent();
    assert.deepEqual(state.history, [1, 2]);
    assert.equal(state.historyCursor, 1);
  });

  it("no-op when currentMediaId is null", () => {
    resetHistory(1);
    state.currentMediaId = null;
    reconcileBrowseHistoryWithCurrent();
    assert.deepEqual(state.history, [1]);
    assert.equal(state.historyCursor, 0);
  });
});

describe("nav session generation", () => {
  beforeEach(resetSession);

  it("bump invalidates prior generation tokens", () => {
    const g = state.navSessionGeneration;
    assert.equal(isNavSessionStale(g), false);
    bumpNavSessionGeneration();
    assert.equal(isNavSessionStale(g), true);
    assert.equal(isNavSessionStale(state.navSessionGeneration), false);
  });
});

describe("clampSlideshowDurationSec", () => {
  it("defaults non-finite to 5", () => {
    assert.equal(clampSlideshowDurationSec(NaN), DEFAULT_SLIDESHOW_DURATION_SEC);
    assert.equal(clampSlideshowDurationSec(Infinity), DEFAULT_SLIDESHOW_DURATION_SEC);
    assert.equal(clampSlideshowDurationSec("nope"), DEFAULT_SLIDESHOW_DURATION_SEC);
    assert.equal(clampSlideshowDurationSec(null), DEFAULT_SLIDESHOW_DURATION_SEC);
  });

  it("floors and clamps to 1..3600", () => {
    assert.equal(clampSlideshowDurationSec(0), 1);
    assert.equal(clampSlideshowDurationSec(-3), 1);
    assert.equal(clampSlideshowDurationSec(1.9), 1);
    assert.equal(clampSlideshowDurationSec(5), 5);
    assert.equal(clampSlideshowDurationSec("12"), 12);
    assert.equal(clampSlideshowDurationSec(99999), 3600);
  });
});
