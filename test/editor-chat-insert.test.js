import assert from "node:assert/strict";

import { EditorSelectionController } from "../src/editor.js";

function install({ connected = true, key = "doc_a" } = {}) {
  const listeners = new Map();
  const editorNode = { nodeType: 1, isConnected: connected };
  const range = {
    startContainer: editorNode,
    endContainer: editorNode,
    cloneRange() { return this; },
    collapse() {},
  };
  const selection = {
    rangeCount: 1,
    getRangeAt() { return range; },
    removeAllRanges() { this.removed = true; },
    addRange(value) { this.added = value; },
  };
  const events = [];
  const finalBlock = { parentNode: {}, isConnected: true };
  const writeEl = {
    contains(node) { return node === editorNode || node === finalBlock; },
    lastElementChild: finalBlock,
    focus() { this.focused = true; },
    dispatchEvent(event) { events.push(event.type); },
  };
  const calls = [];
  global.window = { getSelection() { return selection; } };
  global.document = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    getElementById(id) { return id === "write" ? writeEl : null; },
    createRange() { return { selectNodeContents(node) { this.target = node; }, collapse() {}, startContainer: finalBlock }; },
    execCommand(command, _ui, value) { calls.push([command, value]); return true; },
  };
  return { calls, events, finalBlock, listeners, range, selection, setKey(value) { key = value; }, trigger() { listeners.get("selectionchange")?.(); }, writeEl, getKey() { return key; } };
}

{
  const fixture = install();
  const controller = new EditorSelectionController();
  controller.startCaretTracking(() => ({ key: fixture.getKey() }));
  fixture.trigger();
  assert.equal(controller.lastCaretRange, fixture.range);
  assert.equal(controller.lastCaretDocumentKey, "doc_a");

  // A panel selection has no range inside #write, so it cannot erase the saved caret.
  fixture.selection.getRangeAt = () => ({ startContainer: { nodeType: 1, isConnected: true }, endContainer: { nodeType: 1, isConnected: true }, cloneRange() { return this; } });
  fixture.trigger();
  assert.equal(controller.lastCaretRange, fixture.range);
  controller.stopCaretTracking();
  assert.equal(fixture.listeners.has("selectionchange"), false);
}

{
  const fixture = install();
  const controller = new EditorSelectionController();
  controller.startCaretTracking(() => ({ key: fixture.getKey() }));
  fixture.trigger();
  assert.deepEqual(controller.insertMarkdownAtLastCaret("answer"), { ok: true });
  assert.deepEqual(fixture.calls, [["insertText", "\n\nanswer\n\n"]]);
  assert.ok(fixture.events.includes("input"));
  assert.equal(fixture.writeEl.focused, true);
}

{
  const fixture = install();
  let fallbackTarget = null;
  global.document.createRange = () => ({
    selectNodeContents(node) { fallbackTarget = node; },
    collapse() {},
    startContainer: fixture.finalBlock,
  });
  const controller = new EditorSelectionController();
  controller.startCaretTracking(() => ({ key: fixture.getKey() }));
  fixture.trigger();
  fixture.range.startContainer.isConnected = false;
  assert.deepEqual(controller.insertMarkdownAtLastCaret("answer"), { ok: true });
  assert.equal(fallbackTarget, fixture.finalBlock);
}

{
  const fixture = install();
  const controller = new EditorSelectionController();
  controller.startCaretTracking(() => ({ key: fixture.getKey() }));
  fixture.trigger();
  fixture.setKey("doc_b");
  assert.deepEqual(controller.insertMarkdownAtLastCaret("answer"), { ok: false, reason: "document-changed" });
}

console.log("editor chat insert tests passed");
