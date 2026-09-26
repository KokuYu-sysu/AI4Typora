import { buildTextDiff } from "./text-diff.js";
import { translate } from "./i18n.js";
import { ensureStyles, makeDialogDraggable, registerDialog, unregisterDialog } from "./ui.js";

const COLLAPSE_AFTER = 600;
const CONTEXT_LENGTH = 220;
let dialogSequence = 0;

function addElement(parent, tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  parent.appendChild(element);
  return element;
}

function addButton(parent, action, label, kind = "secondary") {
  const button = addElement(parent, "button", `ai-edit-btn ${kind}`, label);
  button.dataset.action = action;
  return button;
}

function renderOperation(parent, operation, tr) {
  if (operation.type === "equal" && operation.text.length > COLLAPSE_AFTER) {
    const collapsed = addElement(parent, "span", "ai-edit-diff-equal");
    addElement(collapsed, "span", "", operation.text.slice(0, CONTEXT_LENGTH));
    const expand = addElement(collapsed, "button", "ai-edit-diff-collapsed", tr("diff.showUnchanged"));
    expand.type = "button";
    expand.addEventListener("click", () => {
      collapsed.replaceChildren();
      collapsed.textContent = operation.text;
    });
    addElement(collapsed, "span", "", operation.text.slice(-CONTEXT_LENGTH));
    return;
  }

  const tagName = operation.type === "delete" ? "del" : operation.type === "insert" ? "ins" : "span";
  addElement(parent, tagName, `ai-edit-diff-${operation.type}`, operation.text);
}

export function createDiffDialog(options) {
  ensureStyles();
  const tr = (key) => translate(options.language ?? "en", key);

  const overlay = document.createElement("div");
  overlay.id = "ai-edit-dialog-overlay";
  overlay.className = "ai-edit-overlay";
  const dialogElement = addElement(overlay, "div", "ai-edit-dialog");
  const titleId = `ai-edit-diff-title-${++dialogSequence}`;
  dialogElement.setAttribute("role", "dialog");
  dialogElement.setAttribute("aria-modal", "true");
  dialogElement.setAttribute("aria-labelledby", titleId);
  dialogElement.tabIndex = -1;
  const header = addElement(dialogElement, "div", "ai-edit-dialog-header");
  const title = addElement(header, "div", "ai-edit-dialog-title", options.title || tr("diff.rewrite"));
  title.id = titleId;
  const closeButton = addButton(header, "close", "×");
  closeButton.className = "ai-edit-dialog-close";
  closeButton.setAttribute("aria-label", tr("common.closeDialog"));
  const body = addElement(dialogElement, "div", "ai-edit-dialog-body");
  const output = addElement(body, "div", "ai-edit-diff-output");
  const validation = addElement(body, "div", "ai-edit-diff-validation");
  const footer = addElement(dialogElement, "div", "ai-edit-dialog-footer");

  let closed = false;
  let state = "idle";
  let candidateText = "";
  let replaceAllowed = false;

  const lifecycle = { close };
  registerDialog(lifecycle);
  document.body.appendChild(overlay);
  const disposeDrag = makeDialogDraggable(overlay);
  dialogElement.focus?.();

  function renderFooter(actions) {
    footer.replaceChildren();
    for (const [action, label, kind] of actions) {
      const button = addButton(footer, action, label, kind);
      button.addEventListener("click", () => act(action));
    }
  }

  function renderPreview(text) {
    output.replaceChildren();
    output.textContent = String(text ?? "");
  }

  function renderDiff() {
    output.replaceChildren();
    for (const operation of buildTextDiff(options.originalText, candidateText, options.diffOptions)) {
      renderOperation(output, operation, tr);
    }
  }

  function showStopped() {
    state = "stopped";
    validation.textContent = tr("diff.stopped");
    renderFooter([["copy", tr("common.copy")], ["regenerate", tr("common.regenerate")], ["close", tr("common.close")]]);
  }

  function beginGeneration() {
    if (closed) return;
    state = "generating";
    candidateText = "";
    replaceAllowed = false;
    validation.textContent = "";
    renderPreview(tr("common.waiting"));
    renderFooter([["stop", tr("common.stop"), "danger"]]);
  }

  function setStreamingText(text) {
    if (closed || state !== "generating") return;
    candidateText = String(text ?? "");
    renderPreview(candidateText);
  }

  function complete(result = {}) {
    if (closed || state === "stopped" || state === "failed") return;
    state = "complete";
    candidateText = String(result.candidateText ?? "");
    replaceAllowed = result.replaceAllowed !== false;
    validation.textContent = result.validationMessage || "";
    renderDiff();
    const actions = [["copy", tr("common.copy")], ["regenerate", tr("common.regenerate")], ["close", tr("common.close")]];
    if (replaceAllowed) actions.push(["replace", tr("common.replace"), "primary"]);
    renderFooter(actions);
  }

  function fail(message) {
    if (closed || state === "stopped" || state === "failed" || state === "complete") return;
    state = "failed";
    replaceAllowed = false;
    validation.textContent = String(message || tr("diff.failed"));
    renderPreview(candidateText);
    renderFooter([["regenerate", tr("common.regenerate")], ["close", tr("common.close")]]);
  }

  function close(reason = "close") {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeyDown, true);
    disposeDrag();
    overlay.remove();
    unregisterDialog(lifecycle);
    options.onClose?.({ reason, state, candidateText });
  }

  function copy() {
    navigator.clipboard?.writeText(candidateText).catch(() => {});
  }

  function act(action) {
    if (action === "close") return close("close");
    if (action === "stop" && state === "generating") {
      showStopped();
      try {
        options.onStop?.();
      } catch (_) {}
      return;
    }
    if (action === "regenerate" && state !== "generating") return options.onRegenerate?.();
    if (action === "replace" && state === "complete" && replaceAllowed) return options.onReplace?.(candidateText);
    if (action === "copy") return copy();
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close("overlay");
  });
  closeButton.addEventListener("click", () => act("close"));
  function onKeyDown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault?.();
    close("escape");
  }
  document.addEventListener("keydown", onKeyDown, true);

  return { beginGeneration, setStreamingText, complete, fail, close };
}
