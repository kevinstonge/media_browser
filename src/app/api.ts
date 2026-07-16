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

export interface TagAsset {
  id: number;
  tagId: number;
  assetType: "image" | "sound" | string;
  path: string;
  sortOrder: number;
}

export interface Tag {
  id: number;
  name: string;
  createdAt: string;
  assets: TagAsset[];
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
  /** Present when loaded via get_media; may be empty for other queries. */
  tags?: Tag[];
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

/** Native file picker. kind: "image" | "sound" | "any". */
export async function pickFile(
  kind?: "image" | "sound" | "any" | null,
): Promise<string | null> {
  return invoke<string | null>("pick_file", { kind: kind ?? null });
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
  excludeId?: number | null,
): Promise<MediaItem | null> {
  return invoke<MediaItem | null>("get_random", {
    rootId,
    parentDir: parentDir ?? null,
    excludeId: excludeId ?? null,
  });
}

// --- Tags -------------------------------------------------------------------

export async function listTags(): Promise<Tag[]> {
  return invoke<Tag[]>("list_tags");
}

export async function createTag(name: string): Promise<Tag> {
  return invoke<Tag>("create_tag", { name });
}

export async function deleteTag(tagId: number): Promise<void> {
  return invoke("delete_tag", { tagId });
}

export async function addMediaTag(
  mediaItemId: number,
  tagId: number,
): Promise<Tag> {
  return invoke<Tag>("add_media_tag", { mediaItemId, tagId });
}

export async function removeMediaTag(
  mediaItemId: number,
  tagId: number,
): Promise<void> {
  return invoke("remove_media_tag", { mediaItemId, tagId });
}

export async function addTagAsset(
  tagId: number,
  assetType: "image" | "sound",
  path: string,
): Promise<TagAsset> {
  return invoke<TagAsset>("add_tag_asset", { tagId, assetType, path });
}

export async function removeTagAsset(assetId: number): Promise<void> {
  return invoke("remove_tag_asset", { assetId });
}

/** Convert absolute filesystem path to a URL loadable by img/video/audio (asset protocol). */
export function mediaUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}
