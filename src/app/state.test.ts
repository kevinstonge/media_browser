/**
 * Unit tests for dual-history switching, stop reconcile, duration clamp, nav compose.
 * Run: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  activeHistoryBag,
  activeNavMode,
  browseHistoryBag,
  bumpNavSessionGeneration,
  canResetActiveHistory,
  clampSlideshowDurationSec,
  clearHistory,
  clearSlideshowHistory,
  composeNavMode,
  DEFAULT_SLIDESHOW_DURATION_SEC,
  isNavSessionStale,
  isSequentialMode,
  isSlideshowActive,
  navModeOrder,
  navModeScope,
  pushHistory,
  reconcileBrowseHistoryWithCurrent,
  resetActiveHistoryToCurrent,
  resetHistory,
  resetSlideshowHistory,
  slideshowHistoryBag,
  SLIDESHOW_DURATION_OPTIONS,
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

  it("uses browse bag + global navMode when slideshow idle", () => {
    state.slideshowStatus = "idle";
    state.navMode = "alpha";
    state.slideshowNavMode = "random_root";
    assert.equal(activeHistoryBag(), browseHistoryBag());
    assert.equal(activeNavMode(), "alpha");
    assert.equal(isSlideshowActive(), false);
  });

  it("uses slideshow bag but still global navMode when playing", () => {
    state.slideshowStatus = "playing";
    state.navMode = "alpha";
    state.slideshowNavMode = "random_current_dir";
    assert.equal(activeHistoryBag(), slideshowHistoryBag());
    // Mode is global — slideshow does not override.
    assert.equal(activeNavMode(), "alpha");
    assert.equal(isSlideshowActive(), true);
  });

  it("uses slideshow bag while paused (still active)", () => {
    state.slideshowStatus = "paused";
    state.navMode = "random_root";
    state.slideshowNavMode = "alpha";
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

describe("composeNavMode / order / scope", () => {
  it("maps all four combinations", () => {
    assert.equal(composeNavMode("sequential", "all"), "alpha");
    assert.equal(composeNavMode("sequential", "current"), "alpha_current_dir");
    assert.equal(composeNavMode("random", "all"), "random_root");
    assert.equal(composeNavMode("random", "current"), "random_current_dir");
  });

  it("round-trips order and scope", () => {
    for (const mode of [
      "alpha",
      "alpha_current_dir",
      "random_root",
      "random_current_dir",
    ] as const) {
      assert.equal(
        composeNavMode(navModeOrder(mode), navModeScope(mode)),
        mode,
      );
    }
  });

  it("isSequentialMode distinguishes order axis", () => {
    assert.equal(isSequentialMode("alpha"), true);
    assert.equal(isSequentialMode("alpha_current_dir"), true);
    assert.equal(isSequentialMode("random_root"), false);
    assert.equal(isSequentialMode("random_current_dir"), false);
  });
});

describe("resetActiveHistoryToCurrent", () => {
  beforeEach(resetSession);

  it("is disabled with no current media or single-entry bag", () => {
    assert.equal(canResetActiveHistory(), false);
    state.currentMediaId = 1;
    resetHistory(1);
    assert.equal(canResetActiveHistory(), false);
    assert.equal(resetActiveHistoryToCurrent(), false);
    assert.deepEqual(state.history, [1]);
  });

  it("collapses browse history to current id only", () => {
    resetHistory(1);
    pushHistory(2);
    pushHistory(3);
    state.currentMediaId = 2;
    state.historyCursor = 1;
    assert.equal(canResetActiveHistory(), true);
    assert.equal(resetActiveHistoryToCurrent(), true);
    assert.deepEqual(state.history, [2]);
    assert.equal(state.historyCursor, 0);
    assert.equal(canResetActiveHistory(), false);
  });

  it("targets slideshow bag while slideshow is active", () => {
    resetHistory(1);
    pushHistory(2);
    resetSlideshowHistory(10);
    const s = slideshowHistoryBag();
    s.history = [10, 11, 12];
    s.historyCursor = 1;
    state.currentMediaId = 11;
    state.slideshowStatus = "playing";

    assert.equal(canResetActiveHistory(), true);
    assert.equal(resetActiveHistoryToCurrent(), true);
    assert.deepEqual(state.slideshowHistory, [11]);
    assert.equal(state.slideshowHistoryCursor, 0);
    // Browse bag untouched
    assert.deepEqual(state.history, [1, 2]);
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

  it("re-reconcile after late displayMedia advances current (ISSUE-5)", () => {
    // Stop reconciled to 5 while displayMedia was in flight; then current becomes 6.
    resetHistory(1);
    pushHistory(5);
    state.currentMediaId = 5;
    reconcileBrowseHistoryWithCurrent();
    assert.deepEqual(state.history, [1, 5]);
    assert.equal(state.historyCursor, 1);

    // In-flight display applies next item after Stop.
    state.currentMediaId = 6;
    reconcileBrowseHistoryWithCurrent();
    assert.deepEqual(state.history, [1, 5, 6]);
    assert.equal(state.history[state.historyCursor], 6);
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

  it("snaps to nearest preset option", () => {
    assert.equal(clampSlideshowDurationSec(0), 5);
    assert.equal(clampSlideshowDurationSec(-3), 5);
    assert.equal(clampSlideshowDurationSec(1), 5);
    assert.equal(clampSlideshowDurationSec(5), 5);
    assert.equal(clampSlideshowDurationSec(7), 5);
    assert.equal(clampSlideshowDurationSec(12), 10);
    assert.equal(clampSlideshowDurationSec("15"), 15);
    assert.equal(clampSlideshowDurationSec(45), 30);
    assert.equal(clampSlideshowDurationSec(90), 60);
    assert.equal(clampSlideshowDurationSec(200), 120);
    assert.equal(clampSlideshowDurationSec(99999), 300);
  });

  it("preserves every listed option exactly", () => {
    for (const opt of SLIDESHOW_DURATION_OPTIONS) {
      assert.equal(clampSlideshowDurationSec(opt), opt);
    }
  });
});
