import assert from "node:assert/strict";
import test from "node:test";

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.className = "";
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
    this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); } };
  }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; children.forEach((child) => this.appendChild(child)); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  closest(selector) { return selector === "[data-action='close']" && this.dataset.action === "close" ? this : null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 300 }; }
  get offsetWidth() { return 500; }
  get offsetHeight() { return 300; }
  focus() { this.focused = true; }

  set id(value) { this._id = value; }
  get id() { return this._id; }
  querySelector(selector) {
    const matcher = selector.startsWith("#")
      ? (node) => node.id === selector.slice(1)
      : selector.startsWith(".")
        ? (node) => node.className.split(/\s+/).includes(selector.slice(1))
        : () => false;
    for (const child of this.children) {
      if (matcher(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function installFakeDom() {
  const keyListeners = new Set();
  const document = {
    body: null,
    head: null,
    createElement(tagName) { return new FakeElement(tagName, document); },
    querySelector(selector) { return document.body.querySelector(selector) || document.head.querySelector(selector); },
    getElementById(id) { return document.querySelector(`#${id}`); },
    addEventListener(type, listener) { if (type === "keydown") keyListeners.add(listener); },
    removeEventListener(type, listener) { if (type === "keydown") keyListeners.delete(listener); },
    fireKey(event) { for (const listener of keyListeners) listener(event); },
    getKeydownListenerCount() { return keyListeners.size; },
  };
  document.body = new FakeElement("body", document);
  document.head = new FakeElement("head", document);
  globalThis.document = document;
  globalThis.window = { innerWidth: 1200, innerHeight: 800, setTimeout(callback) { callback(); } };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  });
  return document;
}

function findAction(element, action) {
  if (element.dataset.action === action) return element;
  for (const child of element.children) {
    const found = findAction(child, action);
    if (found) return found;
  }
  return null;
}

const { createDiffDialog } = await import("../src/diff-dialog.js");

test("diff dialog streams plain output, then enables complete actions", () => {
  const document = installFakeDom();
  let regenerated = 0;
  let replaced = null;
  const dialog = createDiffDialog({
    title: "Rewrite",
    originalText: "old wording",
    onRegenerate() { regenerated += 1; },
    onReplace(text) { replaced = text; },
  });

  dialog.beginGeneration();
  dialog.setStreamingText("new wording");
  const output = document.querySelector(".ai-edit-diff-output");
  assert.equal(output.textContent, "new wording");
  assert.ok(findAction(document.body, "stop"));

  dialog.complete({ candidateText: "new wording", replaceAllowed: true });
  for (const action of ["copy", "regenerate", "close", "replace"]) {
    assert.ok(findAction(document.body, action), `missing ${action}`);
  }
  findAction(document.body, "regenerate").listeners.get("click")({ target: findAction(document.body, "regenerate") });
  assert.equal(regenerated, 1);
  assert.ok(document.getElementById("ai-edit-dialog-overlay"), "regenerate keeps dialog open");
  findAction(document.body, "replace").listeners.get("click")({ target: findAction(document.body, "replace") });
  assert.equal(replaced, "new wording");
});

test("stopped output ignores late stream and completion without enabling replacement", () => {
  const document = installFakeDom();
  let stopped = 0;
  const dialog = createDiffDialog({
    title: "Rewrite",
    originalText: "old wording",
    onStop() { stopped += 1; throw new Error("abort failed"); },
  });
  dialog.beginGeneration();
  dialog.setStreamingText("partial wording");
  assert.doesNotThrow(() => findAction(document.body, "stop").listeners.get("click")({ target: findAction(document.body, "stop") }));
  dialog.setStreamingText("late wording");
  dialog.complete({ candidateText: "late completion", replaceAllowed: true });

  assert.equal(stopped, 1);
  assert.equal(document.querySelector(".ai-edit-diff-output").textContent, "partial wording");
  assert.ok(findAction(document.body, "regenerate"));
  assert.equal(findAction(document.body, "replace"), null);
});

test("diff dialog has basic dialog semantics and removes Escape handling on close", () => {
  const document = installFakeDom();
  let closes = 0;
  createDiffDialog({ title: "Rewrite", originalText: "old", onClose() { closes += 1; } });
  const dialog = document.querySelector(".ai-edit-dialog");
  const title = document.querySelector(".ai-edit-dialog-title");
  const close = findAction(document.body, "close");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("aria-labelledby"), title.id);
  assert.equal(close.getAttribute("aria-label"), "Close dialog");
  assert.equal(dialog.focused, true);
  let prevented = false;
  document.fireKey({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(closes, 1);
  assert.equal(document.getElementById("ai-edit-dialog-overlay"), null);
  assert.equal(document.getKeydownListenerCount(), 0);
});

test("invalid completion shows validation without an enabled replacement", () => {
  const document = installFakeDom();
  const dialog = createDiffDialog({ title: "Rewrite", originalText: "old" });
  dialog.complete({ candidateText: "candidate", replaceAllowed: false, validationMessage: "Formula placeholders changed." });

  assert.equal(document.querySelector(".ai-edit-diff-validation").textContent, "Formula placeholders changed.");
  assert.equal(findAction(document.body, "replace"), null);
  assert.ok(findAction(document.body, "regenerate"));
});

test("diff content is rendered through text nodes and close is idempotent", () => {
  const document = installFakeDom();
  let closeCount = 0;
  const unsafe = "<img src=x onerror=alert(1)>";
  const dialog = createDiffDialog({
    title: unsafe,
    originalText: unsafe,
    onClose() { closeCount += 1; },
  });
  dialog.complete({ candidateText: `${unsafe} revised`, replaceAllowed: true });

  assert.equal(document.querySelector(".ai-edit-dialog-title").textContent, unsafe);
  assert.ok(document.querySelector(".ai-edit-diff-insert"));
  dialog.close("test");
  dialog.close("again");
  assert.equal(closeCount, 1);
  assert.equal(document.getElementById("ai-edit-dialog-overlay"), null);
});
