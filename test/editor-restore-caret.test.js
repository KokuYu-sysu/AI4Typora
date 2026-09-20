import assert from "node:assert/strict";

import { EditorSelectionController } from "../src/editor.js";

function createSelection() {
  return {
    removed: false,
    addedRange: null,
    removeAllRanges() {
      this.removed = true;
    },
    addRange(range) {
      this.addedRange = range;
    },
  };
}

{
  const selection = createSelection();
  const validRange = {
    startContainer: {
      nodeType: 1,
      isConnected: true,
    },
    collapse() {},
    cloneRange() {
      return this;
    },
  };
  let createRangeCalled = 0;
  global.window = {
    getSelection() {
      return selection;
    },
  };
  global.document = {
    getElementById() {
      return {
        focus() {},
        contains() {
          return true;
        },
      };
    },
    createRange() {
      createRangeCalled += 1;
      return {
        selectNodeContents() {},
        collapse() {},
      };
    },
  };

  const controller = new EditorSelectionController();
  controller.insertionRange = validRange;
  const ok = controller.restoreInsertionCaret();
  assert.equal(ok, true);
  assert.equal(createRangeCalled, 0);
  assert.equal(selection.removed, true);
  assert.equal(selection.addedRange, validRange);
}

{
  const selection = createSelection();
  const target = {
    isConnected: true,
    parentNode: {},
  };
  let selectedTarget = null;
  global.window = {
    getSelection() {
      return selection;
    },
  };
  global.document = {
    getElementById() {
      return {
        focus() {},
        contains() {
          return true;
        },
      };
    },
    querySelector() {
      return null;
    },
    createRange() {
      return {
        selectNodeContents(node) {
          selectedTarget = node;
        },
        collapse() {},
      };
    },
  };

  const controller = new EditorSelectionController();
  controller.insertionRange = {
    cloneRange() {
      throw new Error("stale");
    },
  };
  controller.insertTarget = target;

  const ok = controller.restoreInsertionCaret();
  assert.equal(ok, true);
  assert.equal(selectedTarget, target);
}

{
  const selection = createSelection();
  const previousRange = {
    startContainer: {
      nodeType: 1,
      isConnected: true,
    },
    collapse() {},
    cloneRange() {
      return this;
    },
  };
  const imageTarget = {
    nodeType: 1,
    isConnected: true,
    parentNode: {},
    closest(selector) {
      return selector === "[cid]" ? null : this;
    },
  };
  selection.rangeCount = 1;
  selection.focusNode = {
    nodeType: 3,
    parentElement: {
      isConnected: true,
      parentNode: {},
      closest(selector) {
        return selector === "[cid]" ? null : this;
      },
    },
  };
  selection.anchorNode = selection.focusNode;
  selection.getRangeAt = () => ({
    cloneRange() {
      return previousRange;
    },
  });
  let selectedTarget = null;
  global.window = {
    getSelection() {
      return selection;
    },
  };
  global.document = {
    getElementById() {
      return {
        focus() {},
        contains() {
          return true;
        },
      };
    },
    querySelector() {
      return null;
    },
    createRange() {
      return {
        selectNodeContents(node) {
          selectedTarget = node;
        },
        collapse() {},
      };
    },
  };

  const controller = new EditorSelectionController();
  controller.captureInsertionTarget();
  assert.equal(controller.insertionRange, previousRange);
  controller.captureInsertionTargetFromNode(imageTarget);

  const ok = controller.restoreInsertionCaret();
  assert.equal(ok, true);
  assert.notEqual(selection.addedRange, previousRange);
  assert.equal(selectedTarget, imageTarget);
}

console.log("editor restore caret tests passed");
