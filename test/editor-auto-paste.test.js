import assert from "node:assert/strict";

import { EditorSelectionController } from "../src/editor.js";

function makeWriteEl() {
  const events = [];
  return {
    events,
    focus() {},
    dispatchEvent(event) {
      events.push(event?.type || "");
      return true;
    },
  };
}

{
  const writeEl = makeWriteEl();
  const commands = [];
  global.window = {
    getSelection() {
      return null;
    },
  };
  global.document = {
    getElementById() {
      return writeEl;
    },
    execCommand(command) {
      commands.push(command);
      return command === "paste";
    },
  };

  const controller = new EditorSelectionController();
  controller.restoreInsertionCaret = () => true;
  const ok = await controller.autoPasteResponse("hello");
  assert.equal(ok, true);
  assert.deepEqual(commands, ["paste"]);
  assert.ok(writeEl.events.includes("input"));
}

{
  const writeEl = makeWriteEl();
  const commands = [];
  let insertedText = "";
  global.window = {
    getSelection() {
      return null;
    },
  };
  global.document = {
    getElementById() {
      return writeEl;
    },
    execCommand(command, _showUI, value) {
      commands.push(command);
      if (command === "paste") {
        return false;
      }
      if (command === "insertText") {
        insertedText = String(value || "");
        return true;
      }
      return false;
    },
  };

  const controller = new EditorSelectionController();
  controller.restoreInsertionCaret = () => true;
  controller.getElectronClipboard = () => ({
    readText() {
      return "from-clipboard";
    },
  });
  const ok = await controller.autoPasteResponse("fallback");
  assert.equal(ok, true);
  assert.deepEqual(commands, ["paste", "insertText"]);
  assert.equal(insertedText, "from-clipboard");
}

{
  const writeEl = makeWriteEl();
  let insertCalled = false;
  global.window = {
    getSelection() {
      return null;
    },
  };
  global.document = {
    getElementById() {
      return writeEl;
    },
    execCommand(command) {
      if (command === "insertText") {
        insertCalled = true;
      }
      return false;
    },
  };

  const controller = new EditorSelectionController();
  controller.restoreInsertionCaret = () => false;
  const ok = await controller.autoPasteResponse("fallback");
  assert.equal(ok, false);
  assert.equal(insertCalled, false);
}

{
  const writeEl = makeWriteEl();
  let insertedText = "";
  global.window = {
    getSelection() {
      return null;
    },
  };
  global.document = {
    getElementById() {
      return writeEl;
    },
    execCommand(command, _showUI, value) {
      if (command === "paste") {
        return false;
      }
      if (command === "insertText") {
        insertedText = String(value || "");
        return true;
      }
      return false;
    },
  };

  const controller = new EditorSelectionController();
  controller.restoreInsertionCaret = () => true;
  controller.readClipboardText = async () => "";
  const ok = await controller.autoPasteResponse("fallback-text");
  assert.equal(ok, true);
  assert.equal(insertedText, "fallback-text");
}

console.log("editor auto paste tests passed");
