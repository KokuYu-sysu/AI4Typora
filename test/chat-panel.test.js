import assert from "node:assert/strict";
import test from "node:test";

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.attributes = {}; this.className = ""; this.textContent = ""; this.hidden = false; this.disabled = false; this.value = ""; this.classList = { toggle: (name, yes) => { this.className = this.className.split(/\s+/).filter(Boolean).filter((x) => x !== name).concat(yes ? [name] : []).join(" "); } }; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children = []; nodes.forEach((node) => this.appendChild(node)); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  getBoundingClientRect() { return { width: 460 }; }
  closest(selector) { return selector === "[data-action]" && this.dataset.action ? this : this.parentNode?.closest(selector); }
  querySelector(selector) { return find(this, (n) => selector.startsWith(".") ? n.className.split(/\s+/).includes(selector.slice(1)) : selector.startsWith("[") ? n.dataset.action === selector.match(/'([^']+)'/)?.[1] : false); }
}

function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const hit = find(child, predicate); if (hit) return hit; } return null; }
function action(node, name) { return find(node, (n) => n.dataset.action === name); }

function installDom() {
  const docListeners = { mousemove: new Set(), mouseup: new Set() };
  const document = { body: new Node("body"), head: new Node("head"), createElement: (tag) => new Node(tag), getElementById() { return null; }, querySelector(selector) { return this.body.querySelector(selector) || this.head.querySelector(selector); }, addEventListener(type, fn) { docListeners[type]?.add(fn); }, removeEventListener(type, fn) { docListeners[type]?.delete(fn); } };
  globalThis.document = document;
  globalThis.window = { setInterval: () => 1, clearInterval() {}, prompt: () => "Renamed" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  return document;
}

function fakeService({ draftGate } = {}) {
  let listener; let state = { documentIdentity: null, sessions: [{ id: "old", title: "Previous chat" }], activeSession: null, requestStatus: "idle", error: null };
  const calls = [];
  const emit = () => listener?.(JSON.parse(JSON.stringify(state)));
  return { calls,
    subscribe(fn) { listener = fn; return () => { listener = null; }; }, getState: () => JSON.parse(JSON.stringify(state)),
    async openDraft(identity) { calls.push("draft"); if (draftGate && identity.key === "doc_b") await draftGate.promise; state = { ...state, documentIdentity: identity, activeSession: null }; emit(); },
    async openSession(_, id) { calls.push(`open:${id}`); state.activeSession = { id, title: "Previous chat", messages: [{ id: "a", role: "assistant", content: "Answer", status: "complete" }] }; emit(); },
    async send(text) { calls.push(`send:${text}`); state.requestStatus = "streaming"; state.activeSession = { id: "new", title: text, messages: [{ id: "stream", role: "assistant", content: "one", status: "streaming" }] }; emit(); state.activeSession.messages[0] = { ...state.activeSession.messages[0], content: "done", status: "complete" }; state.requestStatus = "idle"; emit(); },
    stop() { calls.push("stop"); }, async renameActive(title) { calls.push(`rename:${title}`); }, async deleteActive() { calls.push("delete"); }, dispose() {},
  };
}

const { createChatPanel } = await import("../src/chat-panel.js");
const identity = { persistable: true, key: "doc_a", label: "paper.md" };

test("panel opens a blank draft, streams one assistant card, and inserts without closing", async () => {
  const document = installDom(); const service = fakeService(); const inserted = [];
  const panel = createChatPanel({ service, getDocumentIdentity: () => identity, onInsertAssistant: (text) => inserted.push(text) });
  await panel.open();
  assert.deepEqual(service.calls, ["draft"]);
  assert.equal(service.getState().activeSession, null, "opening must not restore a history session");
  const input = document.querySelector(".ai-edit-chat-input"); input.value = "Hello";
  document.querySelector(".ai-edit-chat-panel").listeners.get("click")({ target: action(document.body, "send") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(action(document.body, "insert"), "completed assistant response is insertable");
  document.querySelector(".ai-edit-chat-panel").listeners.get("click")({ target: action(document.body, "insert") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(inserted, ["done"]); assert.equal(panel.isOpen(), true);
  panel.close(); assert.equal(panel.isOpen(), false);
});

test("rail selects, renames, deletes and starts a separate blank draft", async () => {
  const document = installDom(); const service = fakeService();
  const panel = createChatPanel({ service, getDocumentIdentity: () => identity }); await panel.open();
  const root = document.querySelector(".ai-edit-chat-panel");
  for (const name of ["select", "rename", "delete", "new", "rail"]) { root.listeners.get("click")({ target: action(root, name) }); await new Promise((resolve) => setTimeout(resolve, 0)); }
  assert.ok(service.calls.includes("open:old")); assert.ok(service.calls.includes("rename:Renamed")); assert.ok(service.calls.includes("delete"));
  assert.equal(service.calls.filter((x) => x === "draft").length, 2);
  panel.close();
});

test("actions wait for an in-flight document refresh before sending", async () => {
  const document = installDom();
  let release;
  const gate = { promise: new Promise((resolve) => { release = resolve; }) };
  const service = fakeService({ draftGate: gate });
  let activeIdentity = identity;
  const panel = createChatPanel({ service, getDocumentIdentity: () => activeIdentity });
  await panel.open();
  activeIdentity = { ...identity, key: "doc_b", label: "second.md" };
  const refreshing = panel.refreshDocument();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const input = document.querySelector(".ai-edit-chat-input"); input.value = "new document question";
  document.querySelector(".ai-edit-chat-panel").listeners.get("click")({ target: action(document.body, "send") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(service.calls.some((call) => call.startsWith("send:")), false, "must not send against the previous document");
  release(); await refreshing; await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(service.calls.includes("send:new document question"));
  assert.equal(service.getState().documentIdentity.key, "doc_b");
  assert.equal(document.querySelector(".ai-edit-chat-input").getAttribute("aria-label"), "Conversation message");
  panel.close();
});
