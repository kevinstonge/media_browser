import { getCurrentWindow } from "@tauri-apps/api/window";
import { dbHealth } from "./app/api";

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
    // Ignore when typing in form fields (future settings UI)
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }

    if (e.key === "F11") {
      e.preventDefault();
      void toggleFullscreen();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      void (async () => {
        const exited = await exitFullscreenIfNeeded();
        if (!exited) {
          // Esc when not fullscreen: no-op for now (quit via Ctrl+Q)
        }
      })();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "q") {
      e.preventDefault();
      void quitApp();
    }
  });
}

async function init(): Promise<void> {
  wireKeyboard();

  try {
    const health = await dbHealth();
    setStatus(`DB ready · ${health}`, true);
    // Fade status after a few seconds
    window.setTimeout(() => setStatus("", false), 4000);
  } catch (err) {
    console.error("DB health check failed:", err);
    setStatus(`DB error: ${formatError(err)}`, true);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void init();
});
