/**
 * Shared Open with default / VLC / parent-folder actions + toast helpers.
 */

import {
  openParentFolder,
  openWithDefault,
  openWithVlc,
} from "../api";

export type StatusFn = (message: string, visible?: boolean) => void;

let setStatus: StatusFn = () => {};
let statusClearTimer: number | null = null;

export function initOpenWith(statusFn: StatusFn): void {
  setStatus = statusFn;
}

function flash(message: string, ms = 3500): void {
  setStatus(message, true);
  if (statusClearTimer != null) window.clearTimeout(statusClearTimer);
  statusClearTimer = window.setTimeout(() => {
    setStatus("", false);
    statusClearTimer = null;
  }, ms);
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

export async function doOpenWithDefault(path: string | null | undefined): Promise<void> {
  if (!path) {
    flash("No file to open");
    return;
  }
  try {
    await openWithDefault(path);
    flash("Opened with default app");
  } catch (err) {
    flash(`Open with default failed: ${formatErr(err)}`);
  }
}

export async function doOpenWithVlc(path: string | null | undefined): Promise<void> {
  if (!path) {
    flash("No file to open");
    return;
  }
  try {
    await openWithVlc(path);
    flash("Opened with VLC");
  } catch (err) {
    // Backend message is already user-facing for missing VLC.
    flash(formatErr(err));
  }
}

export async function doOpenParentFolder(path: string | null | undefined): Promise<void> {
  if (!path) {
    flash("No path available");
    return;
  }
  try {
    await openParentFolder(path);
    flash("Opened parent folder");
  } catch (err) {
    flash(`Open folder failed: ${formatErr(err)}`);
  }
}
