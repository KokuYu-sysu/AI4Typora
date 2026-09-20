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
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 300 }; }
  get offsetWidth() { return 500; }
  get offsetHeight() { return 300; }
  focus() {}

  set innerHTML(html) {
    this.children = [];
    if (html.includes('id="ai-edit-dialog-input"')) {
      const dialog = this.document.createElement("div"); dialog.className = "ai-edit-dialog";
      const input = this.document.createElement("textarea"); input.id = "ai-edit-dialog-input";
      const footer = this.document.createElement("div");
      const cancel = this.document.createElement("button"); cancel.dataset.action = "cancel";
      const confirm = this.document.createElement("button"); confirm.dataset.action = "confirm";
      footer.appendChild(cancel); footer.appendChild(confirm);
      dialog.appendChild(input); dialog.appendChild(footer); this.appendChild(dialog);
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
  const document = {
    body: null,
    createElement(tagName) { return new FakeElement(tagName, document); },
    querySelector(selector) { return document.body.querySelector(selector); },
    getElementById(id) { return document.querySelector(`#${id}`); },
    addEventListener(type, listener) { if (type === "keydown") keyListeners.add(listener); },
    removeEventListener(type, listener) {
      if (type === "keydown") {
        keydownRemoveCount += 1;
        keyListeners.delete(listener);
      }
    },
    fireKey(event) { for (const listener of keyListeners) listener(event); },
    getKeydownListenerCount() { return keyListeners.size; },
    getKeydownRemoveCount() { return keydownRemoveCount; },
  };
  document.body = new FakeElement("body", document);
  globalThis.document = document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  });
  globalThis.window = { ...globalThis.window, innerWidth: 1200, innerHeight: 800, setTimeout(callback) { callback(); } };
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
  plugin.editorSelection = {
    getSavedText: () => selectedText,
    getSelectedText: () => selectedText,
    getDocumentText: () => documentText,
    replaced: [],
    restoreAndReplace(value) { this.replaced.push(value); return true; },
  };
  plugin.getSettings = optimizeSettings;
  return plugin;
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
    const footer = document.getElementById("ai-edit-stream-footer");
    footer.onclick({ target: findAction(footer, "confirm") });
    assert.deepEqual(plugin.editorSelection.replaced, ["After $A$"]);
  } finally {
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
    const overlay = document.getElementById("ai-edit-dialog-overlay");
    overlay.listeners.get("click")({ target: findAction(overlay, "stop") });
    await flow;
    const footer = document.getElementById("ai-edit-stream-footer");
    footer.onclick({ target: findAction(footer, "confirm") });
    assert.deepEqual(plugin.editorSelection.replaced, []);
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
    assert.equal(document.getElementById("ai-edit-stream-output").value, "backup output");
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
