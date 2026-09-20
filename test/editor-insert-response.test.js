import assert from "node:assert/strict";

import { EditorSelectionController } from "../src/editor.js";

function makeSelection() {
  const startContainer = {
    nodeType: 1,
    isConnected: true,
    parentElement: null,
  };
  return {
    rangeCount: 1,
    focusNode: null,
    anchorNode: null,
    removed: false,
    addedRange: null,
    getRangeAt() {
      const cloned = {
        startContainer,
        collapse() {},
        cloneRange() {
          return this;
        },
      };
      return {
        cloneRange() {
          return cloned;
        },
      };
    },
    removeAllRanges() {
      this.removed = true;
    },
    addRange(range) {
      this.addedRange = range;
    },
    toString() {
      return "";
    },
  };
}

{
  const selection = makeSelection();
  const paragraph = {
    nodeType: 1,
    parentNode: {},
    closest() {
      return this;
    },
  };
  selection.focusNode = { nodeType: 3, parentElement: paragraph };
  selection.anchorNode = selection.focusNode;

  let createRangeCalled = 0;
  let insertPayload = "";
  const dispatchedEventTypes = [];
  const writeEl = {
    focus() {},
    dispatchEvent(event) {
      dispatchedEventTypes.push(event?.type || "");
      return true;
    },
  };
  global.window = {
    getSelection() {
      return selection;
    },
  };
  global.document = {
    getElementById() {
      return writeEl;
    },
    createRange() {
      createRangeCalled += 1;
      return {
        selectNodeContents() {},
        collapse() {},
      };
    },
    execCommand(command, _showUI, value) {
      assert.equal(command, "insertText");
      insertPayload = String(value);
      return true;
    },
  };

  const controller = new EditorSelectionController();
  controller.captureInsertionTarget();
  const ok = controller.insertResponse("Q&A result");

  assert.equal(ok, true);
  assert.equal(createRangeCalled, 0);
  assert.equal(selection.removed, true);
  assert.ok(selection.addedRange);
  assert.equal(insertPayload, "\n\nQ&A result\n\n");
  assert.ok(dispatchedEventTypes.includes("input"));
}

{
  const selection = makeSelection();
  let selectNodeContentsArg = null;
  global.window = {
    getSelection() {
      return selection;
    },
  };
  global.document = {
    getElementById() {
      return { focus() {} };
    },
    createRange() {
      return {
        selectNodeContents(node) {
          selectNodeContentsArg = node;
        },
        collapse() {},
      };
    },
    execCommand() {
      return true;
    },
  };

  const controller = new EditorSelectionController();
  controller.insertionRange = {
    cloneRange() {
      throw new Error("stale range");
    },
  };
  const target = {
    parentNode: {},
    isConnected: true,
  };
  controller.insertTarget = target;

  const ok = controller.insertResponse("fallback");
  assert.equal(ok, true);
  assert.equal(selectNodeContentsArg, target);
}

console.log("editor insert response tests passed");
