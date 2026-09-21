import assert from "node:assert/strict";
import test from "node:test";

import { restoreMath } from "../src/math-protection.js";

globalThis.window = {
  [Symbol.for("typora-plugin-core@v2")]: {
    Plugin: class {},
    PluginSettings: class {},
    SettingTab: class {},
    Notice: class {},
  },
};

const { default: AiEditPlugin, prepareContextRewrite } = await import("../src/plugin.js");
const { closeAnyDialog, createStreamDialog, promptForText } = await import("../src/ui.js");

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
    this.classList = { add() {} };
    this.listeners = new Map();
    this.value = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 100;
  }

  set id(value) { this._id = value; }
  get id() { return this._id; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; children.forEach((child) => this.appendChild(child)); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 300 }; }
  get offsetWidth() { return 500; }
  get offsetHeight() { return 300; }
  focus() {}

  set innerHTML(html) {
    this.children = [];
    if (html.includes('id="ai-edit-dialog-input"')) {
      const dialog = this.document.createElement("div"); dialog.className = "ai-edit-dialog";
      const header = this.document.createElement("div"); header.className = "ai-edit-dialog-header";
      const input = this.document.createElement("textarea"); input.id = "ai-edit-dialog-input";
      const footer = this.document.createElement("div");
      const cancel = this.document.createElement("button"); cancel.dataset.action = "cancel";
      const confirm = this.document.createElement("button"); confirm.dataset.action = "confirm";
      footer.appendChild(cancel); footer.appendChild(confirm);
      dialog.appendChild(header); dialog.appendChild(input); dialog.appendChild(footer); this.appendChild(dialog);
      return;
    }
    if (html.includes("ai-edit-stream-output")) {
      const dialog = this.document.createElement("div"); dialog.className = "ai-edit-dialog";
      const header = this.document.createElement("div"); header.className = "ai-edit-dialog-header";
      const title = this.document.createElement("div"); title.className = "ai-edit-dialog-title";
      const close = this.document.createElement("button"); close.dataset.action = "close";
      header.appendChild(title); header.appendChild(close);
      const body = this.document.createElement("div");
      const output = this.document.createElement("textarea"); output.id = "ai-edit-stream-output";
      body.appendChild(output);
      const footer = this.document.createElement("div"); footer.id = "ai-edit-stream-footer";
      const stop = this.document.createElement("button"); stop.dataset.action = "stop";
      footer.appendChild(stop);
      dialog.appendChild(header); dialog.appendChild(body); dialog.appendChild(footer);
      this.appendChild(dialog);
      return;
    }
    for (const match of html.matchAll(/data-action="([^"]+)"[^>]*>([^<]*)</g)) {
      const button = this.document.createElement("button");
      button.dataset.action = match[1]; button.textContent = match[2]; this.appendChild(button);
    }
  }
  get innerHTML() { return ""; }

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
  let keydownRemoveCount = 0;
  let copiedText = null;
  let execCommandCalls = 0;
  const dragListeners = {
    mousemove: new Set(),
    mouseup: new Set(),
  };
  const dragRemoveCounts = {
    mousemove: 0,
    mouseup: 0,
  };
  const document = {
    body: null,
    head: null,
    createElement(tagName) { return new FakeElement(tagName, document); },
    querySelector(selector) { return document.body.querySelector(selector) || document.head.querySelector(selector); },
    getElementById(id) { return document.querySelector(`#${id}`); },
    execCommand() { execCommandCalls += 1; return true; },
    addEventListener(type, listener) {
      if (type === "keydown") keyListeners.add(listener);
      if (dragListeners[type]) dragListeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "keydown") {
        keydownRemoveCount += 1;
        keyListeners.delete(listener);
      }
      if (dragListeners[type]) {
        dragRemoveCounts[type] += 1;
        dragListeners[type].delete(listener);
      }
    },
    fireKey(event) { for (const listener of keyListeners) listener(event); },
    getKeydownListenerCount() { return keyListeners.size; },
    getKeydownRemoveCount() { return keydownRemoveCount; },
    getDragListenerCount(type) { return dragListeners[type].size; },
    getDragRemoveCount(type) { return dragRemoveCounts[type]; },
  };
  document.body = new FakeElement("body", document);
  document.head = new FakeElement("head", document);
  globalThis.document = document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { copiedText = text; } } },
  });
  document.getCopiedText = () => copiedText;
  document.getExecCommandCalls = () => execCommandCalls;
  globalThis.window = {
    ...globalThis.window,
    File: { filePath: "C:\\docs\\rewrite.md" },
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout(callback) { callback(); },
  };
  return document;
}

function findAction(element, action) {
  if (element.dataset.action === action) return element;
  for (const child of element.children) {
    const match = findAction(child, action);
    if (match) return match;
  }
  return null;
}

function clickAction(element, action) {
  const target = findAction(element, action);
  target?.listeners.get("click")?.({ target });
}

function completePrompt(document, value = "") {
  const overlay = document.getElementById("ai-edit-dialog-overlay");
  document.getElementById("ai-edit-dialog-input").value = value;
  overlay.listeners.get("click")({ target: findAction(overlay, "confirm") });
}

function sseResponse(events) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events));
        controller.close();
      },
    }),
  };
}

function abortIgnoringStreamResponse(initialText) {
  let controller;
  const response = {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(streamController) {
        controller = streamController;
        streamController.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: initialText } }] })}\n\n`,
        ));
      },
    }),
  };
  return {
    response,
    resolveLate(text) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      ));
      controller.close();
    },
  };
}

function optimizeSettings() {
  return {
    provider: "openai_compat",
    openaiCompat: { baseUrl: "https://primary.example.com", apiKey: "key", model: "model" },
    openaiCompatBackups: [],
    prompts: {
      optimize: { system: "system", user: "Improve: {selection}" },
      optimize_with_context: { system: "system", user: "Selection: {selection}\nDocument: {document}" },
    },
  };
}

function createOptimizePlugin(selectedText, documentText = "") {
  const plugin = new AiEditPlugin();
  const snapshot = { documentId: "doc", text: selectedText, range: {} };
  plugin.editorSelection = {
    getSavedText: () => selectedText,
    getSelectedText: () => selectedText,
    getDocumentText: () => documentText,
    captureSelectionSnapshot: () => snapshot,
    validateSelectionSnapshot: () => ({ ok: true }),
    replaced: [],
    replaceSelectionSnapshot(_snapshot, value) { this.replaced.push(value); return { ok: true }; },
  };
  plugin.getSettings = optimizeSettings;
  return plugin;
}

function qaSettings() {
  return {
    ...optimizeSettings(),
    prompts: {
      ...optimizeSettings().prompts,
      qa: { system: "qa system", user: "Question: {question}" },
      qa_with_context: { system: "qa context system", user: "Question: {question}\nDocument: {document}" },
      image_qa: { system: "image system", user: "Image question: {question}" },
    },
  };
}

function createQaPlugin() {
  const plugin = new AiEditPlugin();
  plugin.editorSelection = {
    getDocumentText: () => "Document context",
    restoreInsertionCaretCalls: 0,
    restoreInsertionCaret() { this.restoreInsertionCaretCalls += 1; },
    autoPasteResponseCalls: 0,
    async autoPasteResponse() { this.autoPasteResponseCalls += 1; return true; },
  };
  plugin.getSettings = qaSettings;
  return plugin;
}

async function completeTextQaPrompts(document, question = "Question") {
  completePrompt(document, question);
  await Promise.resolve();
  completePrompt(document, "");
  await Promise.resolve();
}

test("prepareContextRewrite protects only selected math and leaves document context unchanged", () => {
  const selected = "Start $A$ then $$ B $$ end";
  const documentText = "Document $C$ remains verbatim.";
  const prompt = "Selection:\n{selection}\n\nDocument:\n{document}";
  const result = prepareContextRewrite(selected, prompt, documentText);

  assert.match(result.userPrompt, /⟪AI_EDIT_MATH_0⟫/);
  assert.match(result.userPrompt, /⟪AI_EDIT_MATH_1⟫/);
  assert.match(result.userPrompt, /Document \$C\$ remains verbatim\./);
  assert.equal(result.mathEntries.length, 2);
  assert.deepEqual(restoreMath(result.userPrompt.match(/Selection:\n([\s\S]*?)\n\nDocument/)[1], result.mathEntries), {
    ok: true,
    text: selected,
  });
});

test("prepareContextRewrite preserves literal sentinel collisions without mutating inputs", () => {
  const selected = "literal ⟪AI_EDIT_MATH_0⟫ and $A$";
  const documentText = "document ⟪AI_EDIT_MATH_0⟫";
  const prompt = "{selection} // {document}";
  const before = { selected, documentText, prompt };
  const result = prepareContextRewrite(selected, prompt, documentText);

  assert.equal(result.mathEntries.length, 2);
  assert.deepEqual(restoreMath(result.userPrompt.split(" // ")[0], result.mathEntries), {
    ok: true,
    text: selected,
  });
  assert.deepEqual({ selected, documentText, prompt }, before);
});

test("stream dialog setValue replaces prior streamed text", () => {
  const document = installFakeDom();
  const stream = createStreamDialog({ title: "Stream", waitingText: "Waiting" });
  stream.append("primary partial");
  stream.setValue("backup output");

  assert.equal(document.getElementById("ai-edit-stream-output").value, "backup output");
  stream.close();
});

test("invalid completion renders validation text and cannot confirm by click or Ctrl+Enter", () => {
  const document = installFakeDom();
  let confirmations = 0;
  const stream = createStreamDialog({ title: "Stream", waitingText: "Waiting" });
  stream.setValue("candidate");
  stream.showCompleted({
    confirmText: "Replace",
    replaceAllowed: false,
    validationMessage: "Missing math placeholder: <unsafe>",
    onConfirm() { confirmations += 1; },
  });

  const footer = document.getElementById("ai-edit-stream-footer");
  footer.onclick({ target: findAction(footer, "confirm") });
  document.fireKey({ key: "Enter", ctrlKey: true, preventDefault() {} });
  assert.equal(confirmations, 0);
  assert.equal(findAction(footer, "confirm"), null);
  assert.equal(findAction(footer, "validation").textContent, "Missing math placeholder: <unsafe>");
  stream.close();
});

test("valid context completion replaces only strict-restored text", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const plugin = createOptimizePlugin("Before $A$ after", "Document $C$");
  globalThis.fetch = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    const token = prompt.match(/⟪AI_EDIT_MATH_\d+⟫/)[0];
    return sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: `After ${token}` } }] })}\n\n`);
  };

  try {
    const flow = plugin.openOptimizeFlow(true);
    completePrompt(document);
    await flow;
    clickAction(document.body, "replace");
    assert.deepEqual(plugin.editorSelection.replaced, ["After $A$"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("replace revalidates the snapshot and keeps a stale candidate open", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const plugin = createOptimizePlugin("Original");
  plugin.editorSelection.replaceSelectionSnapshot = () => ({ ok: false, reason: "selection-changed" });
  globalThis.fetch = async () => sseResponse(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Candidate" } }] })}\n\n`,
  );

  try {
    const flow = plugin.openOptimizeFlow(false);
    completePrompt(document);
    await flow;
    clickAction(document.body, "replace");

    assert.ok(document.getElementById("ai-edit-dialog-overlay"));
    assert.equal(findAction(document.body, "replace"), null);
    assert.match(document.querySelector(".ai-edit-diff-validation").textContent, /selection changed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unsaved document can generate but never exposes Replace", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const plugin = createOptimizePlugin("Original");
  window.File = {};
  globalThis.fetch = async () => sseResponse(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Candidate" } }] })}\n\n`,
  );

  try {
    const flow = plugin.openOptimizeFlow(false);
    completePrompt(document);
    await flow;

    assert.equal(findAction(document.body, "replace"), null);
    assert.match(document.querySelector(".ai-edit-diff-validation").textContent, /save the document/i);
    assert.equal(document.getExecCommandCalls(), 0);
  } finally {
    closeAnyDialog("test cleanup");
    globalThis.fetch = originalFetch;
  }
});

test("separate unsaved rewrite flows never share a replacement identity", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const capturedIds = [];
  window.File = {};
  globalThis.fetch = async () => sseResponse(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Candidate" } }] })}\n\n`,
  );

  try {
    for (const selectedText of ["First", "Second"]) {
      const plugin = createOptimizePlugin(selectedText);
      plugin.editorSelection.captureSelectionSnapshot = (documentId) => {
        capturedIds.push(documentId);
        return { documentId, text: selectedText, range: {} };
      };
      const flow = plugin.openOptimizeFlow(false);
      completePrompt(document);
      await flow;
      assert.equal(findAction(document.body, "replace"), null);
      closeAnyDialog("next unsaved document");
    }

    assert.equal(capturedIds.length, 2);
    assert.notEqual(capturedIds[0], capturedIds[1]);
    assert.equal(document.getExecCommandCalls(), 0);
  } finally {
    closeAnyDialog("test cleanup");
    globalThis.fetch = originalFetch;
  }
});

test("stopped optimize flow never replaces a partial response", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const plugin = createOptimizePlugin("Before $A$ after");
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    }, { once: true });
  });

  try {
    const flow = plugin.openOptimizeFlow(false);
    completePrompt(document);
    await Promise.resolve();
    clickAction(document.body, "stop");
    await flow;
    assert.equal(findAction(document.body, "replace"), null);
    assert.deepEqual(plugin.editorSelection.replaced, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stopping optimize freezes pre-stop output when an abort-ignoring provider completes late", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const plugin = createOptimizePlugin("Selected");
  let request;
  globalThis.fetch = () => {
    request = abortIgnoringStreamResponse("pre-stop optimize");
    return request.response;
  };

  try {
    const flow = plugin.openOptimizeFlow(false);
    completePrompt(document);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.querySelector(".ai-edit-diff-output").textContent, "pre-stop optimize");
    clickAction(document.body, "stop");
    request.resolveLate(" late optimize");
    await flow;

    const output = document.querySelector(".ai-edit-diff-output");
    const footer = document.querySelector(".ai-edit-dialog-footer");
    assert.equal(output.textContent, "pre-stop optimize");
    const copy = findAction(footer, "copy");
    assert.ok(copy);
    assert.ok(findAction(footer, "close"));
    assert.equal(findAction(footer, "replace"), null);
    assert.equal(findAction(footer, "stop"), null);
    assert.deepEqual(plugin.editorSelection.replaced, []);
    clickAction(footer, "copy");
    assert.equal(document.getCopiedText(), "pre-stop optimize");
    assert.ok(document.getElementById("ai-edit-dialog-overlay"));
    clickAction(footer, "close");
    assert.equal(document.getElementById("ai-edit-dialog-overlay"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failover clears primary partial output before rendering backup output", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const plugin = createOptimizePlugin("Selected");
  const settings = optimizeSettings();
  settings.openaiCompatBackups = [{ name: "Backup", baseUrl: "https://backup.example.com", apiKey: "key", model: "model" }];
  plugin.getSettings = () => settings;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: "primary partial" } }] })}\n\ndata: {bad}\n\n`);
    }
    return sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: "backup output" } }] })}\n\n`);
  };

  try {
    const flow = plugin.openOptimizeFlow(false);
    completePrompt(document);
    await flow;
    assert.equal(document.querySelector(".ai-edit-diff-output").textContent, "backup output");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("superseding a stream closes it once and removes its keydown listener", () => {
  closeAnyDialog("test cleanup");
  const document = installFakeDom();
  let closeCount = 0;
  createStreamDialog({
    title: "First",
    onClose() { closeCount += 1; },
  });
  assert.equal(document.getKeydownListenerCount(), 1);

  createStreamDialog({ title: "Second" });
  assert.equal(closeCount, 1);
  assert.equal(document.getKeydownListenerCount(), 1);
  assert.equal(document.getKeydownRemoveCount(), 1);
});

test("superseding a prompt resolves its pending result with null", async () => {
  const document = installFakeDom();
  const prompt = promptForText({ title: "Prompt", label: "Value" });
  createStreamDialog({ title: "Replacement" });

  assert.equal(await Promise.race([prompt, Promise.resolve("pending")]), null);
  assert.ok(document.getElementById("ai-edit-stream-output"));
});

test("closing an active optimize dialog aborts its request and ignores late output", async () => {
  const document = installFakeDom();
  const originalFetch = globalThis.fetch;
  const plugin = createOptimizePlugin("Selected $A$");
  let aborted = false;
  let resolveResponse;
  globalThis.fetch = (_url, options) => {
    options.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise((resolve) => { resolveResponse = resolve; });
  };

  try {
    const flow = plugin.openOptimizeFlow(true);
    completePrompt(document);
    await Promise.resolve();
    closeAnyDialog("unload");
    assert.equal(aborted, true);
    resolveResponse(sseResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: "late output" } }] })}\n\n`));
    await flow;
    assert.deepEqual(plugin.editorSelection.replaced, []);
    assert.equal(document.getElementById("ai-edit-dialog-overlay"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("closing a dialog is idempotent and a stale close cannot clear a newer dialog", () => {
  const document = installFakeDom();
  let firstCloseCount = 0;
  let secondCloseCount = 0;
  const first = createStreamDialog({ onClose() { firstCloseCount += 1; } });
  first.close();
  const second = createStreamDialog({ onClose() { secondCloseCount += 1; } });
  first.close();
  first.close();

  assert.equal(firstCloseCount, 1);
  assert.equal(secondCloseCount, 0);
  assert.ok(document.getElementById("ai-edit-stream-output"));
  second.close();
  assert.equal(secondCloseCount, 1);
});

test("closing a stream dialog during drag removes drag listeners once", () => {
  closeAnyDialog("test cleanup");
  const document = installFakeDom();
  const stream = createStreamDialog({ title: "Drag me" });
  const header = document.querySelector(".ai-edit-dialog-header");
  header.listeners.get("mousedown")({
    button: 0,
    target: { closest() { return null; } },
    clientX: 10,
    clientY: 10,
    preventDefault() {},
  });
  assert.equal(document.getDragListenerCount("mousemove"), 1);
  assert.equal(document.getDragListenerCount("mouseup"), 1);

  stream.close();
  stream.close();

  assert.equal(document.getDragListenerCount("mousemove"), 0);
  assert.equal(document.getDragListenerCount("mouseup"), 0);
  assert.equal(document.getDragRemoveCount("mousemove"), 1);
  assert.equal(document.getDragRemoveCount("mouseup"), 1);
});

test("closing a prompt dialog during drag removes drag listeners once", () => {
  closeAnyDialog("test cleanup");
  const document = installFakeDom();
  const prompt = promptForText({ title: "Prompt", label: "Value" });
  const onDown = document.querySelector(".ai-edit-dialog-header").listeners.get("mousedown");
  assert.equal(typeof onDown, "function");
  onDown({
    button: 0,
    target: { closest() { return null; } },
    clientX: 10,
    clientY: 10,
    preventDefault() {},
  });
  closeAnyDialog("close prompt");

  assert.equal(document.getDragListenerCount("mousemove"), 0);
  assert.equal(document.getDragListenerCount("mouseup"), 0);
  assert.equal(document.getDragRemoveCount("mousemove"), 1);
  assert.equal(document.getDragRemoveCount("mouseup"), 1);
  void prompt;
});

test("superseding a dragged dialog cleans only its own listeners", () => {
  closeAnyDialog("test cleanup");
  const document = installFakeDom();
  const first = createStreamDialog({ title: "First" });
  document.querySelector(".ai-edit-dialog-header").listeners.get("mousedown")({
    button: 0,
    target: { closest() { return null; } },
    clientX: 10,
    clientY: 10,
    preventDefault() {},
  });
  const second = createStreamDialog({ title: "Second" });
  assert.equal(document.getDragRemoveCount("mousemove"), 1);
  assert.equal(document.getDragRemoveCount("mouseup"), 1);

  document.querySelector(".ai-edit-dialog-header").listeners.get("mousedown")({
    button: 0,
    target: { closest() { return null; } },
    clientX: 20,
    clientY: 20,
    preventDefault() {},
  });
  first.close();
  assert.equal(document.getDragListenerCount("mousemove"), 1);
  assert.equal(document.getDragListenerCount("mouseup"), 1);

  second.close();
  assert.equal(document.getDragListenerCount("mousemove"), 0);
  assert.equal(document.getDragListenerCount("mouseup"), 0);
  assert.equal(document.getDragRemoveCount("mousemove"), 2);
  assert.equal(document.getDragRemoveCount("mouseup"), 2);
});

// Multi-turn text/image chat lifecycle coverage lives in plugin-chat-lifecycle.test.js.
