export interface AlertOptions {
  title: string;
  body: string;
  /** Label of the primary button; it is also the only one when `cancelLabel` is left out. */
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * A styled modal in the look of the unsupported-browser alert, for warnings the user should read
 * before carrying on. Resolves true for the primary button and false for Cancel or Escape.
 */
export function showAlert(opts: AlertOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = document.createElement("div");
    overlay.className = "browser-alert-overlay";
    overlay.innerHTML = `
      <div class="browser-alert is-warning" role="alertdialog" aria-modal="true" aria-labelledby="appAlertTitle" aria-describedby="appAlertBody">
        <div class="browser-alert-icon" aria-hidden="true">&#9888;</div>
        <h2 id="appAlertTitle"></h2>
        <p id="appAlertBody"></p>
        <div class="browser-alert-actions"></div>
      </div>
    `;
    // Set as text, so a file name or any other string can never be read as markup.
    overlay.querySelector("h2")!.textContent = opts.title;
    overlay.querySelector("p")!.textContent = opts.body;

    const close = (answer: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      previous?.focus?.();
      resolve(answer);
    };
    const button = (label: string, className: string, answer: boolean) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = className;
      b.textContent = label;
      b.addEventListener("click", () => close(answer));
      return b;
    };

    const actions = overlay.querySelector(".browser-alert-actions")!;
    const confirm = button(opts.confirmLabel ?? "OK", "btn-primary", true);
    const buttons = [confirm];
    if (opts.cancelLabel) buttons.unshift(button(opts.cancelLabel, "btn-secondary", false));
    for (const b of buttons) actions.appendChild(b);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Tab") {
        // Keep focus inside the dialog.
        e.preventDefault();
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    confirm.focus();
  });
}
