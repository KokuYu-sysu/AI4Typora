import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChatStore } from "../src/chat-store.js";
import { getChatDataDirectory } from "../src/platform.js";

const documentA = {
  persistable: true,
  key: "doc_a",
  path: "c:\\notes\\a.md",
  label: "a.md",
};
const documentB = {
  persistable: true,
  key: "doc_b",
  path: "c:\\notes\\b.md",
  label: "b.md",
};

function clock(start = Date.parse("2026-09-21T00:00:00.000Z")) {
  let value = start;
  return () => new Date(value++).toISOString();
}

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-edit-chat-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function session(id, overrides = {}) {
  return { id, title: id, mode: "text", ...overrides };
}

function message(id, role, status = "complete", content = id) {
  return { id, role, status, content };
}

test("list is lazy and sessions stay isolated and newest-first", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();

    assert.deepEqual(await store.listSessions(documentA), []);
    assert.deepEqual(await readdir(baseDir).catch(() => []), []);

    await store.createSession(documentA, session("old"));
    await store.createSession(documentB, session("other"));
    await store.createSession(documentA, session("new"));

    assert.deepEqual((await store.listSessions(documentA)).map(({ id }) => id), ["new", "old"]);
    assert.deepEqual((await store.listSessions(documentB)).map(({ id }) => id), ["other"]);
    assert.equal(await store.getSession(documentB, "old"), null);
  });
});

test("persists schema v1 and performs same-directory flush-close-rename", async () => {
  await withTempDir(async (baseDir) => {
    const events = [];
    const observedFs = {
      ...fsPromises,
      async open(filePath, flags) {
        events.push(["open", filePath, flags]);
        const handle = await fsPromises.open(filePath, flags);
        return {
          writeFile: async (...args) => {
            events.push(["write", filePath]);
            return handle.writeFile(...args);
          },
          sync: async () => {
            events.push(["sync", filePath]);
            return handle.sync();
          },
          close: async () => {
            events.push(["close", filePath]);
            return handle.close();
          },
        };
      },
      async rename(from, to) {
        events.push(["rename", from, to]);
        return fsPromises.rename(from, to);
      },
    };
    const store = createChatStore({ baseDir, fs: observedFs, path, now: clock() });
    await store.initialize();
    await store.createSession(documentA, session("persisted"));

    const tempPath = path.join(baseDir, "chat-history-v1.json.tmp");
    const mainPath = path.join(baseDir, "chat-history-v1.json");
    assert.deepEqual(events.map(([event]) => event), ["open", "write", "sync", "close", "rename"]);
    assert.equal(events[0][1], tempPath);
    assert.deepEqual(events.at(-1), ["rename", tempPath, mainPath]);

    const payload = JSON.parse(await readFile(mainPath, "utf8"));
    assert.equal(payload.version, 1);
    assert.equal(payload.documents.doc_a.path, documentA.path);

    const reloaded = createChatStore({ baseDir, now: clock() });
    await reloaded.initialize();
    assert.equal((await reloaded.getSession(documentA, "persisted")).title, "persisted");
  });
});

test("backs up corrupt JSON and remains usable", async () => {
  await withTempDir(async (baseDir) => {
    await fsPromises.mkdir(baseDir, { recursive: true });
    await fsPromises.writeFile(path.join(baseDir, "chat-history-v1.json"), "{broken", "utf8");
    const store = createChatStore({
      baseDir,
      now: () => "2026-09-21T01:02:03.004Z",
    });
    await store.initialize();

    assert.deepEqual(await store.listSessions(documentA), []);
    assert.deepEqual(await readdir(baseDir), ["chat-history-v1.corrupt-2026-09-21T01-02-03-004Z.json"]);
    await store.createSession(documentA, session("after-recovery"));
    assert.equal((await store.getSession(documentA, "after-recovery")).id, "after-recovery");
  });
});

test("rejects a future schema without changing the file or stale temp", async () => {
  await withTempDir(async (baseDir) => {
    const mainPath = path.join(baseDir, "chat-history-v1.json");
    const tempPath = `${mainPath}.tmp`;
    const future = '{"version":2,"documents":{"future":{}}}';
    await fsPromises.mkdir(baseDir, { recursive: true });
    await fsPromises.writeFile(mainPath, future, "utf8");
    await fsPromises.writeFile(tempPath, "keep", "utf8");

    const store = createChatStore({ baseDir });
    await assert.rejects(store.initialize(), /unsupported chat history schema version 2/i);
    assert.equal(await readFile(mainPath, "utf8"), future);
    assert.equal(await readFile(tempPath, "utf8"), "keep");
  });
});

test("serializes concurrent mutations", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      store.createSession(documentA, session(`s${index}`))
    )));
    assert.equal((await store.listSessions(documentA)).length, 12);

    const reloaded = createChatStore({ baseDir });
    await reloaded.initialize();
    assert.equal((await reloaded.listSessions(documentA)).length, 12);
  });
});

test("supports append, update, rename, delete, and clear operations", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    await store.createSession(documentA, session("s1"));
    await store.appendMessage(documentA, "s1", message("m1", "user"));
    const updated = await store.updateMessage(documentA, "s1", "m1", {
      content: "updated",
      status: "stopped",
    });
    assert.equal(updated.messages[0].content, "updated");
    assert.equal(updated.messages[0].status, "stopped");

    await store.renameSession(documentA, "s1", "Renamed");
    assert.equal((await store.getSession(documentA, "s1")).title, "Renamed");
    await store.deleteSession(documentA, "s1");
    assert.equal(await store.getSession(documentA, "s1"), null);

    await store.createSession(documentA, session("a"));
    await store.createSession(documentB, session("b"));
    await store.clearDocument(documentA);
    assert.deepEqual(await store.listSessions(documentA), []);
    assert.equal((await store.listSessions(documentB)).length, 1);
    await store.clearAll();
    assert.deepEqual(await store.listSessions(documentB), []);
  });
});

test("retains 100 newest inactive sessions per document", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    for (let index = 0; index < 101; index += 1) {
      await store.createSession(documentA, session(`s${index}`));
    }
    const ids = (await store.listSessions(documentA)).map(({ id }) => id);
    assert.equal(ids.length, 100);
    assert.equal(ids.includes("s0"), false);
  });
});

test("prunes the oldest complete turn while protecting a streaming message", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    await store.createSession(documentA, session("long"));
    for (let index = 0; index < 100; index += 1) {
      await store.appendMessage(documentA, "long", message(`u${index}`, "user"));
      await store.appendMessage(documentA, "long", message(`a${index}`, "assistant"));
    }
    await store.appendMessage(documentA, "long", message("active", "assistant", "streaming"));

    const saved = await store.getSession(documentA, "long");
    assert.equal(saved.messages.length, 199);
    assert.equal(saved.messages.some(({ id }) => id === "u0" || id === "a0"), false);
    assert.equal(saved.messages.at(-1).id, "active");
  });
});

test("prunes the oldest finished message when no complete turn exists", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    await store.createSession(documentA, session("unanswered", {
      messages: Array.from({ length: 201 }, (_, index) => message(`u${index}`, "user")),
    }));

    const saved = await store.getSession(documentA, "unanswered");
    assert.equal(saved.messages.length, 200);
    assert.equal(saved.messages[0].id, "u1");
  });
});

test("keeps the newest active stream while pruning stale streaming placeholders", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    await store.createSession(documentA, session("active-only", {
      messages: Array.from({ length: 201 }, (_, index) => message(`s${index}`, "assistant", "streaming")),
    }));

    const saved = await store.getSession(documentA, "active-only");
    assert.equal(saved.messages.length, 200);
    assert.equal(saved.messages[0].id, "s1");
    assert.equal(saved.messages.at(-1).id, "s200");
  });
});

test("enforces an injectable global byte limit by pruning LRU inactive sessions", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock(), maxBytes: 1500 });
    await store.initialize();
    await store.createSession(documentA, session("old"));
    await store.appendMessage(documentA, "old", message("old-message", "user", "complete", "x".repeat(500)));
    await store.createSession(documentB, session("new"));
    await store.appendMessage(documentB, "new", message("new-message", "user", "complete", "y".repeat(500)));

    assert.equal(await store.getSession(documentA, "old"), null);
    assert.notEqual(await store.getSession(documentB, "new"), null);
    assert.ok(Buffer.byteLength(await readFile(path.join(baseDir, "chat-history-v1.json"), "utf8")) <= 1500);
  });
});

test("resolves only APPDATA-backed production storage", () => {
  assert.equal(
    getChatDataDirectory({ APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" }),
    path.join("C:\\Users\\Alice\\AppData\\Roaming", "typora-ai-edit"),
  );
  assert.throws(() => getChatDataDirectory({}), /APPDATA.*unavailable/i);
});
