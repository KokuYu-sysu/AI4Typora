import assert from "node:assert/strict";
import test from "node:test";

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.style = {}; this.listeners = new Map(); this.id = ""; this.textContent = ""; this.className = ""; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  querySelector(selector) { if (selector.startsWith("#") && this.id === selector.slice(1)) return this; for (const child of this.children) { const found = child.querySelector(selector); if (found) return found; } return null; }
}

class Settings {
  constructor() { this.values = new Map(); }
  setDefault(defaults) { for (const [key, value] of Object.entries(defaults)) if (!this.values.has(key)) this.values.set(key, value); }
  get(key) { return this.values.get(key); }
  set(key, value) { this.values.set(key, value); }
}

class Plugin {
  registerSettings(settings) { this.settings = settings; }
  registerSettingTab(tab) { this.settingTab = tab; }
}

const documentListeners = new Map();
const document = {
  head: new Node("head"), body: new Node("body"),
  createElement: (tag) => new Node(tag),
  getElementById(id) { return this.head.querySelector(`#${id}`) || this.body.querySelector(`#${id}`); },
  querySelector(selector) { return this.head.querySelector(selector) || this.body.querySelector(selector); },
  addEventListener(type, listener) { documentListeners.set(type, listener); },
  removeEventListener(type) { documentListeners.delete(type); },
};

globalThis.document = document;
globalThis.window = {
  setTimeout: () => 1,
  clearTimeout() {},
  [Symbol.for("typora-plugin-core@v2")]: {
    Plugin,
    PluginSettings: Settings,
    SettingTab: class {},
    Notice: class {},
  },
};

const { default: AiEditPlugin } = await import("../src/plugin.js");

function harness({ initializeError = null } = {}) {
  const calls = [];
  const store = {
    async initialize() { calls.push("initialize"); if (initializeError) throw initializeError; },
    async flush() { calls.push("flush"); },
  };
  const service = {
    stop() { calls.push("stop"); },
    async dispose() { calls.push("dispose"); },
  };
  let panelOptions;
  const panel = {
    async open(options) { calls.push(["open", options]); },
    close() { calls.push("close"); },
  };
  const plugin = new AiEditPlugin();
  plugin.chatRuntime = {
    createStore() { calls.push("createStore"); return store; },
    createService(options) { calls.push("createService"); assert.ok(options.createRequest); return service; },
    createPanel(options) { calls.push("createPanel"); panelOptions = options; return panel; },
    createRequest() { throw new Error("not used before Send"); },
    getDataDirectory() { return "C:\\chat"; },
    getDocumentIdentity() { return { persistable: true, key: "doc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", path: "c:\\paper.md", label: "paper.md" }; },
  };
  plugin.editorSelection = {
    startCaretTracking() { calls.push("startCaretTracking"); },
    stopCaretTracking() { calls.push("stopCaretTracking"); },
    isEditorTarget() { return true; },
    captureInsertionTarget() {},
    insertMarkdownAtLastCaret() { return { ok: true }; },
  };
  return { plugin, calls, store, service, panel, panelOptions: () => panelOptions };
}

test("plugin owns one lazy chat lifecycle for text and image drafts", async () => {
  const { plugin, calls, panelOptions } = harness();
  await plugin.onload();
  assert.deepEqual(calls.slice(0, 5), ["createStore", "initialize", "createService", "createPanel", "startCaretTracking"]);
  assert.equal(calls.some((call) => call === "createSession"), false);

  let prevented = false;
  plugin.handleKeyDown({ target: {}, key: "e", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault() { prevented = true; }, stopPropagation() {} });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.deepEqual(calls.find((call) => Array.isArray(call)), ["open", { mode: "text" }]);

  await plugin.openImageQaFlow({ src: "https://example.com/figure.png" });
  assert.deepEqual(calls.filter(Array.isArray).at(-1), ["open", { mode: "image", pendingImage: { source: "https://example.com/figure.png" } }]);
  assert.equal(calls.some((call) => call === "createSession"), false);
  assert.equal(panelOptions().warning, "");

  await plugin.onunload();
  assert.deepEqual(calls.slice(-5), ["stop", "close", "stopCaretTracking", "dispose", "flush"]);
});

test("storage initialization failure falls back without crashing and warns the panel", async () => {
  const { plugin, calls, panelOptions } = harness({ initializeError: new Error("disk denied") });
  await plugin.onload();
  assert.ok(calls.includes("createService"));
  assert.match(panelOptions().warning, /will not persist.*disk denied/i);
  await plugin.onunload();
});

test("assistant insertion keeps the panel alive and reports success through the editor boundary", async () => {
  const { plugin, calls, panelOptions } = harness();
  await plugin.onload();
  assert.deepEqual(panelOptions().onInsertAssistant("## Result"), { ok: true });
  assert.equal(calls.includes("close"), false);
  await plugin.onunload();
});
