function removeElement(selector) {
  const element = document.querySelector(selector);
  if (element) {
    element.remove();
  }
}

export function ensureStyles() {
  if (document.getElementById("ai-edit-plugin-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "ai-edit-plugin-style";
  style.textContent = `
    .ai-edit-toast { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 999999; padding: 10px 16px; border-radius: 8px; color: #fff; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
    .ai-edit-toast.info { background: #2563eb; }
    .ai-edit-toast.success { background: #15803d; }
    .ai-edit-toast.error { background: #dc2626; }
    .ai-edit-menu { position: fixed; z-index: 999998; min-width: 220px; padding: 6px 0; background: rgba(255,255,255,0.98); border: 1px solid rgba(15,23,42,0.12); border-radius: 10px; box-shadow: 0 16px 40px rgba(15,23,42,0.18); font-size: 13px; }
    .ai-edit-menu-item { padding: 8px 14px; cursor: pointer; }
    .ai-edit-menu-item-title { font-size: 13px; color: #111827; }
    .ai-edit-menu-item-desc { margin-top: 2px; font-size: 12px; color: #6b7280; line-height: 1.35; }
    .ai-edit-menu-item:hover { background: rgba(37,99,235,0.08); }
    .ai-edit-overlay { position: fixed; inset: 0; z-index: 999997; background: rgba(15,23,42,0.36); display: flex; align-items: center; justify-content: center; }
    .ai-edit-dialog { width: min(680px, calc(100vw - 32px)); max-height: min(84vh, 760px); background: #fff; border-radius: 14px; box-shadow: 0 20px 48px rgba(15,23,42,0.22); display: flex; flex-direction: column; overflow: hidden; }
    .ai-edit-dialog-header { display: flex; align-items: center; gap: 8px; padding: 16px 18px; border-bottom: 1px solid #e5e7eb; }
    .ai-edit-dialog-header.draggable { cursor: move; user-select: none; }
    .ai-edit-dialog-title { font-size: 15px; font-weight: 600; }
    .ai-edit-dialog-close { margin-left: auto; border: none; background: none; font-size: 22px; cursor: pointer; color: #6b7280; }
    .ai-edit-dialog-body { padding: 16px 18px; overflow: auto; }
    .ai-edit-dialog-label { display: block; margin-bottom: 8px; font-size: 13px; color: #374151; }
    .ai-edit-dialog-input { width: 100%; min-height: 120px; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 10px; font-size: 13px; line-height: 1.6; resize: vertical; }
    .ai-edit-dialog-footer { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-top: 1px solid #e5e7eb; }
    .ai-edit-spacer { flex: 1; }
    .ai-edit-btn { border: none; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
    .ai-edit-btn.primary { background: #2563eb; color: #fff; }
    .ai-edit-btn.secondary { background: #eef2f7; color: #111827; }
    .ai-edit-btn.danger { background: #dc2626; color: #fff; }
    .ai-edit-setting-grid { display: grid; gap: 10px; margin-top: 12px; }
    .ai-edit-setting-grid label { display: block; font-size: 12px; color: #374151; margin-bottom: 4px; }
    .ai-edit-setting-grid input:not([type="checkbox"]), .ai-edit-setting-grid select, .ai-edit-setting-grid textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; }
    .ai-edit-setting-grid input[type="checkbox"] { width: 16px; height: 16px; margin: 0; padding: 0; }
    .ai-edit-setting-card { padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #f8fafc; }
    .ai-edit-setting-card-title { font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 8px; }
    .ai-edit-setting-card-note { margin-top: 6px; font-size: 12px; color: #6b7280; }
    .ai-edit-setting-subgrid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-top: 8px; }
    .ai-edit-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .ai-edit-toggle-row-text { font-size: 13px; color: #374151; line-height: 1.35; }
    .ai-edit-toggle-control { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 0 !important; font-size: 12px; color: #374151; white-space: nowrap; }
    .ai-edit-setting-note { margin-top: 8px; font-size: 12px; color: #6b7280; }
    .ai-edit-setting-status.ok { color: #15803d; }
    .ai-edit-setting-status.bad { color: #dc2626; }
  `;
  document.head.appendChild(style);
}

export function removeStyles() {
  removeElement("#ai-edit-plugin-style");
}

export function showToast(message, type = "info", duration = 2600) {
  removeElement("#ai-edit-toast");
  const toast = document.createElement("div");
  toast.id = "ai-edit-toast";
  toast.className = `ai-edit-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), duration);
}

let activeMenu = null;
function onOutsideMenuClick(event) {
  if (activeMenu && !activeMenu.contains(event.target)) {
    closeContextMenu();
  }
}

export function closeContextMenu() {
  removeElement("#ai-edit-context-menu");
  activeMenu = null;
  document.removeEventListener("mousedown", onOutsideMenuClick, true);
}

export function openContextMenu(options) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.id = "ai-edit-context-menu";
  menu.className = "ai-edit-menu";

  for (const item of options.items) {
    const row = document.createElement("div");
    row.className = "ai-edit-menu-item";
    const title = document.createElement("div");
    title.className = "ai-edit-menu-item-title";
    title.textContent = item.label;
    row.appendChild(title);
    if (item.description) {
      const desc = document.createElement("div");
      desc.className = "ai-edit-menu-item-desc";
      desc.textContent = item.description;
      row.appendChild(desc);
    }
    row.addEventListener("click", () => {
      closeContextMenu();
      options.onSelect(item.value);
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(options.x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(options.y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  activeMenu = menu;
  window.setTimeout(() => document.addEventListener("mousedown", onOutsideMenuClick, true), 0);
  return menu;
}

function closeOverlay(overlay) {
  if (overlay && overlay.parentNode) {
    overlay.remove();
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function makeDialogDraggable(overlay) {
  const dialog = overlay.querySelector(".ai-edit-dialog");
  const header = overlay.querySelector(".ai-edit-dialog-header");
  if (!dialog || !header) {
    return;
  }

  header.classList.add("draggable");
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  function toFixedPosition() {
    if (dialog.dataset.fixedPosition === "1") {
      return;
    }
    const rect = dialog.getBoundingClientRect();
    dialog.style.position = "fixed";
    dialog.style.left = `${rect.left}px`;
    dialog.style.top = `${rect.top}px`;
    dialog.style.margin = "0";
    dialog.style.width = `${rect.width}px`;
    dialog.dataset.fixedPosition = "1";
  }

  function onMove(event) {
    if (!dragging) {
      return;
    }
    const maxLeft = Math.max(8, window.innerWidth - dialog.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - dialog.offsetHeight - 8);
    const left = clamp(startLeft + (event.clientX - startX), 8, maxLeft);
    const top = clamp(startTop + (event.clientY - startY), 8, maxTop);
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
  }

  function onUp() {
    dragging = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
  }

  header.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.target?.closest?.("[data-action='close']")) {
      return;
    }
    event.preventDefault();
    toFixedPosition();
    const rect = dialog.getBoundingClientRect();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  });
}

export function closeAnyDialog() {
  removeElement("#ai-edit-dialog-overlay");
}

export function promptForText(options) {
  closeAnyDialog();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "ai-edit-dialog-overlay";
    overlay.className = "ai-edit-overlay";
    overlay.innerHTML = `
      <div class="ai-edit-dialog">
        <div class="ai-edit-dialog-header">
          <div class="ai-edit-dialog-title">${options.title}</div>
          <button class="ai-edit-dialog-close" data-action="close">&times;</button>
        </div>
        <div class="ai-edit-dialog-body">
          <label class="ai-edit-dialog-label" for="ai-edit-dialog-input">${options.label}</label>
          <textarea id="ai-edit-dialog-input" class="ai-edit-dialog-input" placeholder="${options.placeholder || ""}"></textarea>
        </div>
        <div class="ai-edit-dialog-footer">
          <button class="ai-edit-btn secondary" data-action="cancel">Cancel</button>
          <div class="ai-edit-spacer"></div>
          <button class="ai-edit-btn primary" data-action="confirm">${options.confirmText || "Start"}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector("#ai-edit-dialog-input");
    input.value = options.initialValue || "";
    window.setTimeout(() => input.focus(), 50);

    function finish(value) {
      closeOverlay(overlay);
      resolve(value);
    }

    overlay.addEventListener("click", (event) => {
      const action = event.target?.dataset?.action;
      if (event.target === overlay || action === "close" || action === "cancel") {
        finish(null);
      }
      if (action === "confirm") {
        finish(input.value.trim());
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(input.value.trim());
      }
    });
  });
}

export function createStreamDialog(options) {
  closeAnyDialog();
  const overlay = document.createElement("div");
  overlay.id = "ai-edit-dialog-overlay";
  overlay.className = "ai-edit-overlay";
  overlay.innerHTML = `
    <div class="ai-edit-dialog">
      <div class="ai-edit-dialog-header">
        <div class="ai-edit-dialog-title">${options.title}</div>
        <button class="ai-edit-dialog-close" data-action="close">&times;</button>
      </div>
      <div class="ai-edit-dialog-body">
        <textarea id="ai-edit-stream-output" class="ai-edit-dialog-input" readonly></textarea>
      </div>
      <div class="ai-edit-dialog-footer" id="ai-edit-stream-footer">
        <button class="ai-edit-btn danger" data-action="stop">Stop</button>
        <div class="ai-edit-spacer"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  makeDialogDraggable(overlay);

  const output = overlay.querySelector("#ai-edit-stream-output");
  const footer = overlay.querySelector("#ai-edit-stream-footer");
  output.value = options.waitingText || "Waiting for response...";
  const waitingText = options.waitingText || "Waiting for response...";
  let completedActions = null;

  function emitClose(reason) {
    if (typeof options.onClose === "function") {
      try {
        options.onClose({
          reason,
          value: getOutputText(),
          rawValue: output.value === waitingText ? "" : output.value,
        });
      } catch (_) {}
    }
  }

  function getOutputText() {
    if (output.value === waitingText) {
      return "";
    }
    return output.value.trim();
  }

  function copyOutputAndClose() {
    const text = output.value === waitingText ? "" : output.value;
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast("Copied to clipboard.", "success");
    api.close("copy");
  }

  function runConfirm() {
    if (!completedActions || typeof completedActions.onConfirm !== "function") {
      return;
    }
    completedActions.onConfirm(getOutputText());
  }

  function onDialogKeyDown(event) {
    if (!completedActions) {
      return;
    }

    const ctrlLike = event.ctrlKey || event.metaKey;
    if (!ctrlLike) {
      return;
    }

    const key = String(event.key || "").toLowerCase();
    if (key === "enter") {
      event.preventDefault();
      runConfirm();
      return;
    }
    if (key === "c") {
      event.preventDefault();
      copyOutputAndClose();
    }
  }

  document.addEventListener("keydown", onDialogKeyDown, true);

  const api = {
    append(delta) {
      if (output.value === waitingText) {
        output.value = "";
      }
      output.value += delta;
      output.scrollTop = output.scrollHeight;
    },
    getValue() {
      return output.value;
    },
    showError(message) {
      completedActions = null;
      output.value = `${output.value}\n\n${message}`.trim();
      footer.innerHTML = '<div class="ai-edit-spacer"></div><button class="ai-edit-btn primary" data-action="close">Close</button>';
    },
    showCompleted(completedOptions) {
      completedActions = completedOptions;
      footer.innerHTML = `
        <button class="ai-edit-btn secondary" data-action="copy">Copy</button>
        <div class="ai-edit-spacer"></div>
        <button class="ai-edit-btn secondary" data-action="close">Close</button>
        <button class="ai-edit-btn primary" data-action="confirm">${completedOptions.confirmText || "Insert"}</button>
      `;
      footer.onclick = (event) => {
        const action = event.target?.dataset?.action;
        if (action === "copy") {
          copyOutputAndClose();
        }
        if (action === "close") {
          api.close("close");
        }
        if (action === "confirm") {
          runConfirm();
        }
      };
    },
    close(reason = "close") {
      document.removeEventListener("keydown", onDialogKeyDown, true);
      closeOverlay(overlay);
      emitClose(reason);
    },
  };

  overlay.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action === "close") {
      api.close("close");
    }
    if (action === "stop" && options.onStop) {
      options.onStop();
    }
  });

  return api;
}
