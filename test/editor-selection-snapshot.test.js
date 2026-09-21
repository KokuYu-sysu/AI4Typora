import assert from "node:assert/strict";

import { EditorSelectionController } from "../src/editor.js";

function installEditor({ text = "original", connected = true, documentId = "doc_a" } = {}) {
  const container = { nodeType: 1, isConnected: connected, parentElement: null };
  const makeRange = () => ({
    startContainer: container,
    endContainer: container,
    toString() { return text; },
    cloneRange: makeRange,
  });
  const range = makeRange();
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    removed: false,
    added: null,
    getRangeAt() { return range; },
    toString() { return text; },
    removeAllRanges() { this.removed = true; },
    addRange(nextRange) { this.added = nextRange; },
  };
  const inputEvents = [];
  const writeEl = {
    contains(node) { return node === container; },
    dispatchEvent(event) { inputEvents.push(event.type); return true; },
  };
  const commands = [];
  global.window = { getSelection() { return selection; } };
  global.document = {
    getElementById(id) { return id === "write" ? writeEl : null; },
    execCommand(command, _showUi, value) {
      commands.push([command, value]);
      return true;
    },
  };
  return { commands, container, documentId, inputEvents, range, selection };
}

{
  const fixture = installEditor();
  const controller = new EditorSelectionController();
  const snapshot = controller.captureSelectionSnapshot(fixture.documentId);
  assert.equal(snapshot.text, "original");
  assert.notEqual(snapshot.range, fixture.range);
  assert.deepEqual(controller.validateSelectionSnapshot(snapshot, fixture.documentId), { ok: true });
  assert.deepEqual(controller.validateSelectionSnapshot(snapshot, "doc_b"), { ok: false, reason: "document-changed" });
}

{
  const fixture = installEditor({ connected: false });
  const controller = new EditorSelectionController();
  const snapshot = controller.captureSelectionSnapshot(fixture.documentId);
  assert.deepEqual(controller.validateSelectionSnapshot(snapshot, fixture.documentId), { ok: false, reason: "range-detached" });
}

{
  const fixture = installEditor();
  const controller = new EditorSelectionController();
  const snapshot = controller.captureSelectionSnapshot(fixture.documentId);
  snapshot.range.endContainer = { nodeType: 1, isConnected: true, parentElement: null };
  assert.deepEqual(controller.validateSelectionSnapshot(snapshot, fixture.documentId), { ok: false, reason: "range-detached" });
  assert.deepEqual(controller.replaceSelectionSnapshot(snapshot, "replacement", fixture.documentId), { ok: false, reason: "range-detached" });
  assert.deepEqual(fixture.commands, []);
}

{
  const fixture = installEditor();
  const controller = new EditorSelectionController();
  const snapshot = controller.captureSelectionSnapshot(fixture.documentId);
  snapshot.range.toString = () => "edited";
  assert.deepEqual(controller.validateSelectionSnapshot(snapshot, fixture.documentId), { ok: false, reason: "selection-changed" });
  assert.deepEqual(controller.replaceSelectionSnapshot(snapshot, "replacement", fixture.documentId), { ok: false, reason: "selection-changed" });
  assert.deepEqual(fixture.commands, []);
}

{
  const fixture = installEditor();
  const controller = new EditorSelectionController();
  const snapshot = controller.captureSelectionSnapshot(fixture.documentId);
  assert.deepEqual(controller.replaceSelectionSnapshot(snapshot, "replacement", fixture.documentId), { ok: true });
  assert.deepEqual(fixture.commands, [["insertText", "replacement"]]);
  assert.ok(fixture.inputEvents.includes("input"));
  assert.equal(controller.selectionSnapshot, null);
}

console.log("editor selection snapshot tests passed");
