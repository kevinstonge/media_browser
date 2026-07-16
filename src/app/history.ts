/**
 * Pure session-history helpers (media_item ids).
 * Operates on a HistoryBag so unit tests need no app globals.
 */

export interface HistoryBag {
  history: number[];
  historyCursor: number;
}

export function createHistory(): HistoryBag {
  return { history: [], historyCursor: -1 };
}

/** Direct jump: history becomes [id], cursor 0. */
export function resetHistory(h: HistoryBag, id: number): void {
  h.history = [id];
  h.historyCursor = 0;
}

export function clearHistory(h: HistoryBag): void {
  h.history = [];
  h.historyCursor = -1;
}

/**
 * Append a newly visited id after truncating any forward branch.
 * No-op if id is already at cursor (still truncates forward if present).
 */
export function pushHistory(h: HistoryBag, id: number): void {
  if (h.historyCursor >= 0 && h.history[h.historyCursor] === id) {
    if (h.historyCursor < h.history.length - 1) {
      h.history = h.history.slice(0, h.historyCursor + 1);
    }
    return;
  }
  if (h.historyCursor < h.history.length - 1) {
    h.history = h.history.slice(0, h.historyCursor + 1);
  }
  h.history.push(id);
  h.historyCursor = h.history.length - 1;
}

/** Id one step back, or null — does not mutate. */
export function peekHistoryBack(h: HistoryBag): number | null {
  if (h.historyCursor <= 0) return null;
  return h.history[h.historyCursor - 1] ?? null;
}

/** Id one step forward, or null — does not mutate. */
export function peekHistoryForward(h: HistoryBag): number | null {
  if (h.historyCursor < 0) return null;
  if (h.historyCursor >= h.history.length - 1) return null;
  return h.history[h.historyCursor + 1] ?? null;
}

/** Commit a back step (call only after load succeeded). */
export function commitHistoryBack(h: HistoryBag): void {
  if (h.historyCursor > 0) {
    h.historyCursor -= 1;
  }
}

/** Commit a forward step (call only after load succeeded). */
export function commitHistoryForward(h: HistoryBag): void {
  if (h.historyCursor >= 0 && h.historyCursor < h.history.length - 1) {
    h.historyCursor += 1;
  }
}

/** Prepend id when alpha-preving past the start of history. */
export function unshiftHistory(h: HistoryBag, id: number): void {
  if (h.history[0] === id) {
    h.historyCursor = 0;
    return;
  }
  h.history.unshift(id);
  h.historyCursor = 0;
}
