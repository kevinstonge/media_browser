import { getCurrentWindow } from "@tauri-apps/api/window";
import { dbHealth } from "./app/api";
import { handleNavKey, initNav, wireNavClicks, wireNavWheel } from "./app/nav";
import { mountChrome } from "./app/ui/chrome";
import { handleHelpKey, mountHelp } from "./app/ui/help";
import { initOpenWith } from "./app/ui/openWith";
import { mountSettings } from "./app/ui/settings";
import { mountSlideshow, toggleSlideshowPlayback } from "./app/ui/slideshow";
import { mountStage } from "./app/ui/stage";
import { mountTags } from "./app/ui/tags";

const appWindow = getCurrentWindow();

/** Normalize Tauri invoke / unknown rejections for display. */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

function setStatus(message: string, visible = true): void {
  const el = document.querySelector<HTMLElement>("#status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("visible", visible && message.length > 0);
}

async function toggleFullscreen(): Promise<void> {
  const isFullscreen = await appWindow.isFullscreen();
  await appWindow.setFullscreen(!isFullscreen);
}

async function exitFullscreenIfNeeded(): Promise<boolean> {
  const isFullscreen = await appWindow.isFullscreen();
  if (isFullscreen) {
    await appWindow.setFullscreen(false);
    return true;
  }
  return false;
}

async function quitApp(): Promise<void> {
  await appWindow.close();
}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }

    // Help overlay: `?` toggle; Esc closes help before leaving fullscreen.
    if (handleHelpKey(e)) return;

    if (e.key === "F11") {
      e.preventDefault();
      void toggleFullscreen();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      void (async () => {
        await exitFullscreenIfNeeded();
      })();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "q") {
      e.preventDefault();
      void quitApp();
      return;
    }

    // Space: slideshow start / pause / resume (not when typing).
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      toggleSlideshowPlayback();
      return;
    }

    // Left / Right navigation
    if (handleNavKey(e)) return;
  });
}

async function init(): Promise<void> {
  initNav(setStatus);
  initOpenWith(setStatus);
  wireKeyboard();

  const stageRoot = document.querySelector<HTMLElement>("#stage");
  const appRoot = document.querySelector<HTMLElement>("#app");
  if (stageRoot) {
    mountStage(stageRoot);
    wireNavClicks(stageRoot);
    wireNavWheel(stageRoot);
  }
  if (appRoot) {
    mountTags(appRoot, setStatus);
    mountSettings(appRoot, setStatus);
    mountSlideshow(appRoot, setStatus);
    mountHelp(appRoot);
    mountChrome(appRoot);
  }

  try {
    const health = await dbHealth();
    setStatus(`DB ready · ${health}`, true);
    window.setTimeout(() => setStatus("", false), 2500);
  } catch (err) {
    console.error("DB health check failed:", err);
    setStatus(`DB error: ${formatError(err)}`, true);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void init();
});
