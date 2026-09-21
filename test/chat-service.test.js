import assert from "node:assert/strict";
import test from "node:test";
import { createChatService } from "../src/chat-service.js";

const identity = { persistable: true, key: "doc_0123456789abcdef0123456789abcdef", path: "C:\\paper.md", label: "paper.md" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeStore() {
  const calls = [];
  const sessions = new Map();
  const copy = (x) => JSON.parse(JSON.stringify(x));
  return {
    calls, sessions,
    async listSessions() { return [...sessions.values()].map(({ messages, ...s }) => ({ ...copy(s), messageCount: messages.length })); },
    async getSession(_, id) { return copy(sessions.get(id) || null); },
    async createSession(_, session) { const value = { ...copy(session), messages: [] }; sessions.set(value.id, value); calls.push("create"); return copy(value); },
    async appendMessage(_, id, message) { const session = sessions.get(id); session.messages.push(copy(message)); calls.push(`append:${message.role}:${message.status}`); return copy(session); },
    async renameSession(_, id, title) { sessions.get(id).title = title; },
    async deleteSession(_, id) { sessions.delete(id); },
    async saveImageAsset(source) { calls.push(`save:${source}`); return { assetId: "a".repeat(64), originalSource: source, mimeType: "image/png", storedPath: "chat-assets/a.png", fallbackUrl: "" }; },
    async resolveImageAsset(image) { calls.push(`resolve:${image.assetId}`); if (image.assetId === "missing") throw new Error("Stored image asset is unavailable."); return "data:image/png;base64,AA"; },
    async releaseImageAsset(image) { calls.push(`release:${image.assetId}`); },
  };
}

function requests() {
  const made = [];
  return {
    made,
    createRequest(options) {
      let resolve; let reject;
      const handle = { aborts: 0, promise: new Promise((ok, bad) => { resolve = ok; reject = bad; }), abort() { this.aborts += 1; const error = new Error("aborted"); error.name = "AbortError"; reject(error); } };
      made.push({ options, handle, resolve, reject });
      return handle;
    },
  };
}

test("draft is lazy, first send streams then persists, and follow-up replays history", async () => {
  const store = fakeStore(); const factory = requests();
  const service = createChatService({ store, createRequest: factory.createRequest, now: () => new Date("2026-01-01T00:00:00.000Z") });
  await service.openDraft(identity);
  service.dispose();
  assert.equal(store.calls.length, 0);
  await service.openDraft(identity);
  const sending = service.send("first question"); await tick();
  assert.deepEqual(store.calls.slice(0, 2), ["create", "append:user:complete"]);
  factory.made[0].options.onChunk("answer"); factory.made[0].resolve("answer"); await sending;
  assert.ok(store.calls.includes("append:assistant:complete"));
  const follow = service.send("follow up"); await tick();
  assert.deepEqual(factory.made[1].options.messages.map((m) => m.content), ["first question", "answer", "follow up"]);
  factory.made[1].resolve("next"); await follow;
});

test("stop saves partial output; failure is retryable and failover reset clears partial", async () => {
  const store = fakeStore(); const factory = requests();
  const service = createChatService({ store, createRequest: factory.createRequest });
  await service.openDraft(identity);
  const pending = service.send("question"); await tick();
  factory.made[0].options.onChunk("partial"); service.stop(); await tick();
  assert.equal(service.getState().activeSession.messages.at(-1).status, "stopped");
  assert.ok(store.calls.includes("append:assistant:stopped")); await pending;
  const failed = service.send("fails"); await tick(); factory.made[1].reject(new Error("network down")); await failed;
  assert.match(service.getState().error, /network down/);
  assert.equal(service.getState().activeSession.messages.at(-1).role, "user");
  const retried = service.retryLastFailed(); await tick();
  assert.equal(store.calls.filter((call) => call === "append:user:complete").length, 2);
  factory.made[2].options.onChunk("bad"); factory.made[2].options.onAttemptStart({ resetOutput: true });
  assert.equal(service.getState().activeSession.messages.at(-1).content, "");
  factory.made[2].resolve("good"); await retried;
});

test("switches abort stale streams and image drafts save once then replay the original image", async () => {
  const store = fakeStore(); const factory = requests();
  const service = createChatService({ store, createRequest: factory.createRequest });
  await service.openDraft(identity, { imageSource: "C:\\image.png" });
  const first = service.send("what is this?"); await tick();
  assert.deepEqual(store.calls.slice(0, 4), ["save:C:\\image.png", "create", "append:user:complete", `resolve:${"a".repeat(64)}`]);
  assert.equal(factory.made[0].options.messages[0].imageInput, "data:image/png;base64,AA");
  await service.openDraft({ ...identity, key: "doc_abcdef0123456789abcdef0123456789" });
  assert.equal(factory.made[0].handle.aborts, 1);
  factory.made[0].options.onChunk("late");
  assert.equal(service.getState().activeSession, null);
  await first;
  await service.openSession(identity, [...store.sessions.keys()][0]);
  const follow = service.send("and then?"); await tick();
  assert.equal(factory.made[1].options.messages[0].imageInput, "data:image/png;base64,AA");
  factory.made[1].resolve("ok"); await follow;
});
