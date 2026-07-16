/**
 * Unit tests for pure history helpers.
 * Run: npm run test:unit
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearHistory,
  commitHistoryBack,
  commitHistoryForward,
  createHistory,
  peekHistoryBack,
  peekHistoryForward,
  pushHistory,
  removeHistoryNeighbor,
  resetHistory,
  unshiftHistory,
} from "./history.ts";

describe("history", () => {
  it("starts empty", () => {
    const h = createHistory();
    assert.equal(h.historyCursor, -1);
    assert.deepEqual(h.history, []);
    assert.equal(peekHistoryBack(h), null);
    assert.equal(peekHistoryForward(h), null);
  });

  it("resetHistory sets single entry at cursor 0", () => {
    const h = createHistory();
    resetHistory(h, 10);
    assert.deepEqual(h.history, [10]);
    assert.equal(h.historyCursor, 0);
    assert.equal(peekHistoryBack(h), null);
    assert.equal(peekHistoryForward(h), null);
  });

  it("pushHistory appends and advances cursor", () => {
    const h = createHistory();
    resetHistory(h, 1);
    pushHistory(h, 2);
    pushHistory(h, 3);
    assert.deepEqual(h.history, [1, 2, 3]);
    assert.equal(h.historyCursor, 2);
  });

  it("pushHistory same id at tip is no-op", () => {
    const h = createHistory();
    resetHistory(h, 5);
    pushHistory(h, 5);
    assert.deepEqual(h.history, [5]);
    assert.equal(h.historyCursor, 0);
  });

  it("pushHistory truncates forward branch", () => {
    const h = createHistory();
    resetHistory(h, 1);
    pushHistory(h, 2);
    pushHistory(h, 3);
    // Walk back without commit helpers: set cursor mid-stack
    h.historyCursor = 0;
    pushHistory(h, 9);
    assert.deepEqual(h.history, [1, 9]);
    assert.equal(h.historyCursor, 1);
  });

  it("peek + commit back/forward keep cursor aligned", () => {
    const h = createHistory();
    resetHistory(h, 1);
    pushHistory(h, 2);
    pushHistory(h, 3);
    assert.equal(peekHistoryBack(h), 2);
    assert.equal(h.historyCursor, 2); // peek does not mutate
    commitHistoryBack(h);
    assert.equal(h.historyCursor, 1);
    assert.equal(peekHistoryForward(h), 3);
    commitHistoryForward(h);
    assert.equal(h.historyCursor, 2);
  });

  it("historyBack at start peeks null; commit is safe no-op", () => {
    const h = createHistory();
    resetHistory(h, 1);
    assert.equal(peekHistoryBack(h), null);
    commitHistoryBack(h);
    assert.equal(h.historyCursor, 0);
  });

  it("historyForward at tip peeks null; commit is safe no-op", () => {
    const h = createHistory();
    resetHistory(h, 1);
    pushHistory(h, 2);
    assert.equal(peekHistoryForward(h), null);
    commitHistoryForward(h);
    assert.equal(h.historyCursor, 1);
  });

  it("unshiftHistory prepends past start", () => {
    const h = createHistory();
    resetHistory(h, 2);
    pushHistory(h, 3);
    unshiftHistory(h, 1);
    assert.deepEqual(h.history, [1, 2, 3]);
    assert.equal(h.historyCursor, 0);
  });

  it("unshiftHistory same first id keeps single and cursor 0", () => {
    const h = createHistory();
    resetHistory(h, 7);
    unshiftHistory(h, 7);
    assert.deepEqual(h.history, [7]);
    assert.equal(h.historyCursor, 0);
  });

  it("clearHistory empties bag", () => {
    const h = createHistory();
    resetHistory(h, 1);
    pushHistory(h, 2);
    clearHistory(h);
    assert.deepEqual(h.history, []);
    assert.equal(h.historyCursor, -1);
  });

  it("removeHistoryNeighbor back drops previous dead id and keeps current", () => {
    const h = createHistory();
    resetHistory(h, 1);
    pushHistory(h, 99); // dead
    pushHistory(h, 3);
    assert.equal(h.historyCursor, 2);
    assert.equal(peekHistoryBack(h), 99);
    assert.equal(removeHistoryNeighbor(h, "back"), true);
    assert.deepEqual(h.history, [1, 3]);
    // Current was 3 at index 2; after removing index 1 → 3 at index 1
    assert.equal(h.historyCursor, 1);
    assert.equal(h.history[h.historyCursor], 3);
    assert.equal(peekHistoryBack(h), 1);
  });

  it("removeHistoryNeighbor forward drops next dead id and keeps current", () => {
    const h = createHistory();
    resetHistory(h, 1);
    pushHistory(h, 2);
    pushHistory(h, 99); // dead
    pushHistory(h, 4);
    h.historyCursor = 1; // on 2
    assert.equal(peekHistoryForward(h), 99);
    assert.equal(removeHistoryNeighbor(h, "forward"), true);
    assert.deepEqual(h.history, [1, 2, 4]);
    assert.equal(h.historyCursor, 1);
    assert.equal(h.history[h.historyCursor], 2);
    assert.equal(peekHistoryForward(h), 4);
  });

  it("removeHistoryNeighbor at ends is no-op", () => {
    const h = createHistory();
    resetHistory(h, 1);
    assert.equal(removeHistoryNeighbor(h, "back"), false);
    assert.equal(removeHistoryNeighbor(h, "forward"), false);
    assert.deepEqual(h.history, [1]);
    assert.equal(h.historyCursor, 0);
  });
});
