export class EditorSelectionController {
  constructor() {
    this.savedRange = null;
    this.savedText = "";
    this.insertTarget = null;
    this.insertCid = "";
    this.insertionRange = null;
    this.selectionSnapshot = null;
    this.lastCaretRange = null;
    this.lastCaretDocumentKey = "";
    this.caretTrackingHandler = null;
    this.getCaretDocumentIdentity = null;
  }

  isEditorTarget(node) {
    return !!(node && node.closest && (node.closest("#write") || node.closest(".CodeMirror")));
  }

  getSelectedText() {
    const selection = window.getSelection();
    return selection ? selection.toString() : "";
  }

  captureSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.clearSavedSelection();
      return false;
    }

    this.savedRange = selection.getRangeAt(0).cloneRange();
    this.savedText = selection.toString();
    this.captureInsertionTarget();
    return true;
  }

  captureInsertionTarget() {
    try {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange();
        range.collapse(false);
        this.insertionRange = range;
      } else {
        this.insertionRange = null;
      }
      const node = selection && (selection.focusNode || selection.anchorNode);
      this.captureInsertionTargetFromNode(node, { preserveInsertionRange: true });
    } catch (_) {
      this.insertTarget = null;
      this.insertionRange = null;
    }
  }

  captureInsertionTargetFromNode(node, options = {}) {
    if (!options.preserveInsertionRange) {
      this.insertionRange = null;
    }
    try {
      const element = node && (node.nodeType === 1 ? node : node.parentElement);
      const cidBlock = element && element.closest ? element.closest("[cid]") : null;
      this.insertCid = cidBlock && cidBlock.getAttribute ? String(cidBlock.getAttribute("cid") || "") : "";
      this.insertTarget = element && (cidBlock || element.closest("p") || element.closest("li") || element.closest("h1,h2,h3,h4,h5,h6") || element);
    } catch (_) {
      this.insertTarget = null;
      this.insertCid = "";
    }
  }

  isRangeUsable(range, writeEl) {
    try {
      if (!range || !range.startContainer) {
        return false;
      }
      const container = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      if (!container || !container.isConnected) {
        return false;
      }
      if (writeEl && writeEl.contains && !writeEl.contains(container)) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  resolveInsertionTarget(writeEl) {
    let target = null;
    if (this.insertCid && typeof document !== "undefined" && document.querySelector) {
      try {
        const escapedCid = typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function"
          ? CSS.escape(this.insertCid)
          : this.insertCid.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
        target = document.querySelector(`[cid="${escapedCid}"]`);
      } catch (_) {
        target = null;
      }
    }

    if (!target && this.insertTarget && this.insertTarget.isConnected) {
      target = this.insertTarget;
    }

    if (!target && writeEl && writeEl.lastElementChild) {
      target = writeEl.lastElementChild;
    }

    return target;
  }

  notifyEditorInput(writeEl) {
    if (!writeEl || typeof writeEl.dispatchEvent !== "function") {
      return;
    }
    try {
      writeEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    } catch (_) {}
    try {
      const event = document.createEvent("Event");
      event.initEvent("input", true, false);
      writeEl.dispatchEvent(event);
    } catch (_) {}
  }

  startCaretTracking(getDocumentIdentity) {
    this.stopCaretTracking();
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    this.getCaretDocumentIdentity = typeof getDocumentIdentity === "function" ? getDocumentIdentity : null;
    this.caretTrackingHandler = () => {
      try {
        const selection = window.getSelection();
        const writeEl = document.getElementById("write");
        if (!selection || !writeEl || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0).cloneRange();
        if (!this.isRangeUsable(range, writeEl)
          || !this.isRangeUsable({ startContainer: range.endContainer }, writeEl)) return;
        const identity = this.getCaretDocumentIdentity && this.getCaretDocumentIdentity();
        const key = String(identity?.key || "");
        if (!key) return;
        this.lastCaretRange = range;
        this.lastCaretDocumentKey = key;
      } catch (_) {}
    };
    document.addEventListener("selectionchange", this.caretTrackingHandler);
  }

  stopCaretTracking() {
    if (this.caretTrackingHandler && typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("selectionchange", this.caretTrackingHandler);
    }
    this.caretTrackingHandler = null;
    this.getCaretDocumentIdentity = null;
  }

  insertMarkdownAtLastCaret(text) {
    const payload = `\n\n${String(text || "")}\n\n`;
    try {
      const selection = window.getSelection();
      const writeEl = document.getElementById("write");
      const currentKey = String(this.getCaretDocumentIdentity?.()?.key || "");
      if (!selection || !writeEl || !this.lastCaretRange || !this.lastCaretDocumentKey) {
        return { ok: false, reason: "no-caret" };
      }
      if (currentKey !== this.lastCaretDocumentKey) return { ok: false, reason: "document-changed" };

      let range;
      try {
        range = this.lastCaretRange.cloneRange();
      } catch (_) {}
      if (!this.isRangeUsable(range, writeEl)) {
        const target = writeEl.lastElementChild;
        if (!target) return { ok: false, reason: "range-detached" };
        range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
      }
      if (typeof writeEl.focus === "function") writeEl.focus();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, payload)) return { ok: false, reason: "insert-failed" };
      this.notifyEditorInput(writeEl);
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "insert-failed" };
    }
  }

  getElectronClipboard() {
    try {
      if (typeof window !== "undefined" && window.reqnode) {
        const electron = window.reqnode("electron");
        if (electron && electron.clipboard) {
          return electron.clipboard;
        }
      }
    } catch (_) {}

    try {
      if (typeof require === "function") {
        const electron = require("electron");
        if (electron && electron.clipboard) {
          return electron.clipboard;
        }
      }
    } catch (_) {}

    return null;
  }

  async readClipboardText() {
    const electronClipboard = this.getElectronClipboard();
    if (electronClipboard && typeof electronClipboard.readText === "function") {
      try {
        const text = String(electronClipboard.readText() || "");
        if (text) {
          return text;
        }
      } catch (_) {}
    }

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.readText === "function") {
        const text = String(await navigator.clipboard.readText() || "");
        if (text) {
          return text;
        }
      }
    } catch (_) {}

    return "";
  }

  restoreInsertionCaret() {
    try {
      const selection = window.getSelection();
      const writeEl = document.getElementById("write");
      if (writeEl) {
        writeEl.focus();
      }
      if (!selection) {
        return false;
      }

      if (this.insertionRange) {
        try {
          const range = this.insertionRange.cloneRange();
          if (this.isRangeUsable(range, writeEl)) {
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
          }
        } catch (_) {}
      }

      const target = this.resolveInsertionTarget(writeEl);
      const range = document.createRange();
      if (target && target.parentNode) {
        range.selectNodeContents(target);
      } else if (writeEl) {
        range.selectNodeContents(writeEl);
      } else {
        return false;
      }
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (_) {
      return false;
    }
  }

  async autoPasteResponse(text) {
    const fallbackText = String(text || "").trim();
    if (!fallbackText) {
      return false;
    }

    const writeEl = document.getElementById("write");
    if (writeEl && typeof writeEl.focus === "function") {
      writeEl.focus();
    }

    if (!this.restoreInsertionCaret()) {
      return false;
    }

    try {
      const pasted = document.execCommand("paste");
      if (pasted) {
        this.notifyEditorInput(writeEl);
        return true;
      }
    } catch (_) {}

    const clipText = await this.readClipboardText();
    const content = clipText || fallbackText;
    try {
      const inserted = document.execCommand("insertText", false, content);
      if (!inserted) {
        return false;
      }
      this.notifyEditorInput(writeEl);
      return true;
    } catch (_) {
      return false;
    }
  }

  getImageElementFromTarget(node) {
    try {
      const element = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!element) {
        return null;
      }
      if (String(element.tagName || "").toLowerCase() === "img") {
        return element;
      }

      const container = element.closest(".md-image, .md-image-wrap, .md-image-container, figure, .image-container");
      if (!container || !container.querySelector) {
        return null;
      }
      const img = container.querySelector("img");
      return img || null;
    } catch (_) {
      return null;
    }
  }

  getSavedText() {
    return this.savedText || "";
  }

  captureSelectionSnapshot(documentId) {
    const id = String(documentId || "");
    const selection = window.getSelection();
    if (!id || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    try {
      const range = selection.getRangeAt(0).cloneRange();
      const text = String(range.toString());
      if (!text) return null;
      this.selectionSnapshot = { documentId: id, text, range };
      return this.selectionSnapshot;
    } catch (_) {
      return null;
    }
  }

  validateSelectionSnapshot(snapshot, currentDocumentId) {
    if (!snapshot || snapshot.documentId !== String(currentDocumentId || "")) {
      return { ok: false, reason: "document-changed" };
    }
    const writeEl = document.getElementById("write");
    if (!writeEl || !this.isRangeUsable(snapshot.range, writeEl)
      || !this.isRangeUsable({ startContainer: snapshot.range?.endContainer }, writeEl)) {
      return { ok: false, reason: "range-detached" };
    }
    try {
      if (String(snapshot.range.toString()) !== snapshot.text) {
        return { ok: false, reason: "selection-changed" };
      }
    } catch (_) {
      return { ok: false, reason: "range-detached" };
    }
    return { ok: true };
  }

  replaceSelectionSnapshot(snapshot, nextText, currentDocumentId) {
    const validation = this.validateSelectionSnapshot(snapshot, currentDocumentId);
    if (!validation.ok) return validation;
    try {
      const selection = window.getSelection();
      if (!selection) return { ok: false, reason: "range-detached" };
      selection.removeAllRanges();
      selection.addRange(snapshot.range);
      if (!document.execCommand("insertText", false, nextText)) {
        return { ok: false, reason: "replace-failed" };
      }
      this.notifyEditorInput(document.getElementById("write"));
      if (this.selectionSnapshot === snapshot) this.selectionSnapshot = null;
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "replace-failed" };
    }
  }

  getDocumentText() {
    try {
      if (window.File && window.File.editor && typeof window.File.editor.getMarkdown === "function") {
        return window.File.editor.getMarkdown();
      }
    } catch (_) {}

    try {
      if (window.editor && typeof window.editor.getMarkdown === "function") {
        return window.editor.getMarkdown();
      }
    } catch (_) {}

    return "";
  }

  restoreAndReplace(nextText) {
    if (!this.savedRange) {
      return false;
    }

    try {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(this.savedRange);
      const ok = document.execCommand("insertText", false, nextText);
      this.clearSavedSelection();
      return !!ok;
    } catch (_) {
      this.clearSavedSelection();
      return false;
    }
  }

  insertResponse(text) {
    const payload = `\n\n${text}\n\n`;
    try {
      const selection = window.getSelection();
      const writeEl = document.getElementById("write");
      if (writeEl) {
        writeEl.focus();
      }

      let restoredInsertionRange = false;
      if (selection && this.insertionRange) {
        try {
          const range = this.insertionRange.cloneRange();
          if (this.isRangeUsable(range, writeEl)) {
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
            restoredInsertionRange = true;
          }
        } catch (_) {
          restoredInsertionRange = false;
        }
      }

      if (!restoredInsertionRange) {
        const target = this.resolveInsertionTarget(writeEl);
        const range = document.createRange();
        if (target && target.parentNode) {
          range.selectNodeContents(target);
        } else if (writeEl) {
          range.selectNodeContents(writeEl);
        } else {
          throw new Error("No valid insertion target");
        }
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      const ok = document.execCommand("insertText", false, payload);
      if (!ok) {
        throw new Error("insertText failed");
      }
      this.notifyEditorInput(writeEl);
      this.insertionRange = null;
      this.insertTarget = null;
      this.insertCid = "";
      return true;
    } catch (_) {
      this.insertionRange = null;
      this.insertTarget = null;
      this.insertCid = "";
      return false;
    }
  }

  clearSavedSelection() {
    this.savedRange = null;
    this.savedText = "";
  }
}
