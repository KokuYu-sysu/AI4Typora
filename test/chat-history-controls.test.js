import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = {
  [Symbol.for("typora-plugin-core@v2")]: { Plugin: class {}, PluginSettings: class {}, SettingTab: class {}, Notice: class {} },
};

const { bindChatHistoryControls } = await import("../src/settings-tab.js");
const { default: AiEditPlugin } = await import("../src/plugin.js");

function button() {
  let click;
  return {
    disabled: false,
    addEventListener(type, handler) { if (type === "click") click = handler; },
    async click() { await click?.(); },
  };
}

function controls() {
  const current = button();
  const all = button();
  return {
    current, all,
    querySelector(selector) {
      return selector === "#ai-edit-clear-current-history" ? current
        : selector === "#ai-edit-clear-all-history" ? all : null;
    },
  };
}

test("current-file history control is disabled for an unsaved document", () => {
  const ui = controls();
  bindChatHistoryControls(ui, { getCurrentDocumentIdentity: () => ({ persistable: false }) });
  assert.equal(ui.current.disabled, true);
});

test("cancelling a history clear does not call the store boundary", async () => {
  const ui = controls(); let calls = 0;
  bindChatHistoryControls(ui, {
    getCurrentDocumentIdentity: () => ({ persistable: true, key: "doc" }),
    async clearCurrentFileChatHistory() { calls += 1; },
    async clearAllChatHistory() { calls += 1; },
  }, { confirm: async () => false });
  await ui.current.click(); await ui.all.click();
  assert.equal(calls, 0);
});

test("confirmed current-file clear resets the open chat draft", async () => {
  const ui = controls(); const calls = []; const notices = [];
  const identity = { persistable: true, key: "doc" };
  const plugin = new AiEditPlugin();
  plugin.chatRuntime.getDocumentIdentity = () => identity;
  plugin.chatService = { async stop() { calls.push("stop"); } };
  plugin.chatStore = { async clearDocument(value) { calls.push(value); } };
  plugin.chatPanel = { isOpen: () => true, async open(options) { calls.push(options); } };
  bindChatHistoryControls(ui, plugin, { confirm: async () => true, notify: (message) => notices.push(message) });
  await ui.current.click();
  assert.deepEqual(calls, ["stop", identity, { mode: "text" }]);
  assert.deepEqual(notices, ["Current file chat history cleared."]);
});

test("all-history failures remain visible without a false success notice", async () => {
  const ui = controls(); const notices = []; let calls = 0;
  const plugin = new AiEditPlugin();
  plugin.chatRuntime.getDocumentIdentity = () => ({ persistable: true, key: "doc" });
  plugin.chatStore = { async clearAll() { calls += 1; throw new Error("disk denied"); } };
  bindChatHistoryControls(ui, plugin, { confirm: async () => true, notify: (message) => notices.push(message) });
  await ui.all.click();
  assert.equal(calls, 1);
  assert.deepEqual(notices, ["Could not clear all chat history: disk denied"]);
});
