import { invoke } from "@tauri-apps/api/core";

/** Confirm SQLite opened and migrations ran. */
export async function dbHealth(): Promise<string> {
  return invoke<string>("db_health");
}
