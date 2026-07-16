import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** Confirm SQLite opened and migrations ran. */
export async function dbHealth(): Promise<string> {
  return invoke<string>("db_health");
}

export interface RootInfo {
  id: number;
  path: string;
  lastScanned: string | null;
  itemCount: number;
  needsScan: boolean;
}

export interface MediaItem {
  id: number;
  rootDirId: number;
  path: string;
  filename: string;
  parentDir: string;
  relPath: string;
  mediaType: string;
  ext: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  isMissing: boolean;
}

export interface ScanResult {
  rootId: number;
  rootPath: string;
  scanned: number;
  upserted: number;
  missingMarked: number;
}

export async function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

export async function getLastRoot(): Promise<RootInfo | null> {
  return invoke<RootInfo | null>("get_last_root");
}

export async function getRootInfo(rootId: number): Promise<RootInfo | null> {
  return invoke<RootInfo | null>("get_root_info", { rootId });
}

export async function settingsGet(key: string): Promise<string | null> {
  return invoke<string | null>("settings_get", { key });
}

export async function settingsSet(key: string, value: string): Promise<void> {
  return invoke("settings_set", { key, value });
}

export async function scanRoot(path: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_root", { path });
}

export async function getMedia(id: number): Promise<MediaItem | null> {
  return invoke<MediaItem | null>("get_media", { id });
}

export async function getFirstMedia(rootId: number): Promise<MediaItem | null> {
  return invoke<MediaItem | null>("get_first_media", { rootId });
}

export async function getNeighbor(
  id: number,
  direction: "next" | "prev",
): Promise<MediaItem | null> {
  return invoke<MediaItem | null>("get_neighbor", { id, direction });
}

export async function getRandom(
  rootId: number,
  parentDir?: string | null,
): Promise<MediaItem | null> {
  return invoke<MediaItem | null>("get_random", {
    rootId,
    parentDir: parentDir ?? null,
  });
}

/** Convert absolute filesystem path to a URL loadable by img/video (asset protocol). */
export function mediaUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}
