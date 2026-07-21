/**
 * Copy the release binary into the portable run folder (`build/`).
 * Leaves library.db and any other files in build/ untouched.
 *
 * Invoked from tauri.conf.json → build.beforeBundleCommand after the
 * release exe is produced and before MSI/NSIS bundling.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src-tauri", "target", "release", "media-browser.exe");
const destDir = join(root, "build");
const dest = join(destDir, "media-browser.exe");

if (!existsSync(src)) {
  console.error(`copy-portable: release exe not found:\n  ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Portable app → ${dest}`);
