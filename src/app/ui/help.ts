/**
 * Optional keyboard help overlay toggled with `?`.
 */

let overlay: HTMLElement | null = null;

const HELP_ROWS: Array<{ keys: string; action: string }> = [
  { keys: "← / →", action: "Previous / next item" },
  { keys: "Click L / R", action: "Previous / next (stage)" },
  { keys: "Right-click", action: "Next item" },
  { keys: "Space", action: "Start / pause / resume slideshow" },
  { keys: "F11", action: "Toggle fullscreen" },
  { keys: "Esc", action: "Close help / exit fullscreen" },
  { keys: "Ctrl+Q", action: "Quit" },
  { keys: "?", action: "Toggle this help" },
  { keys: "⚙", action: "Settings (hover top-right)" },
];

export function mountHelp(root: HTMLElement): void {
  overlay = document.createElement("div");
  overlay.id = "keyboard-help";
  overlay.className = "help-overlay nav-exclude";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Keyboard shortcuts");
  overlay.innerHTML = `
    <div class="help-card">
      <div class="help-title">Keyboard shortcuts</div>
      <table class="help-table">
        <tbody>
          ${HELP_ROWS.map(
            (r) => `
            <tr>
              <td class="help-keys">${escapeHtml(r.keys)}</td>
              <td class="help-action">${escapeHtml(r.action)}</td>
            </tr>`,
          ).join("")}
        </tbody>
      </table>
      <p class="help-footer">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</p>
    </div>
  `;
  root.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    // Click dimmed backdrop closes; clicks on the card do not.
    if (e.target === overlay) hideHelp();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isHelpOpen(): boolean {
  return Boolean(overlay && !overlay.hidden);
}

export function showHelp(): void {
  if (!overlay) return;
  overlay.hidden = false;
}

export function hideHelp(): void {
  if (!overlay) return;
  overlay.hidden = true;
}

export function toggleHelp(): void {
  if (!overlay) return;
  if (overlay.hidden) showHelp();
  else hideHelp();
}

/** Handle `?` / Esc for help. Returns true if the event was consumed. */
export function handleHelpKey(e: KeyboardEvent): boolean {
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
    e.preventDefault();
    toggleHelp();
    return true;
  }
  if (e.key === "Escape" && isHelpOpen()) {
    e.preventDefault();
    hideHelp();
    return true;
  }
  return false;
}

/** True when the event target is over the help overlay. */
export function isOverHelp(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(".help-overlay"));
}
