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
  key: `doc_${"a".repeat(32)}`,
  path: "c:\\notes\\a.md",
  label: "a.md",
};
const documentB = {
  persistable: true,
  key: `doc_${"b".repeat(32)}`,
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
  return { id, role, status, content, createdAt: "2026-09-21T00:00:00.000Z" };
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
    assert.equal(payload.documents[documentA.key].path, documentA.path);

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

test("backs up structurally invalid v1 data and rejects invalid store identifiers", async () => {
  await withTempDir(async (baseDir) => {
    const mainPath = path.join(baseDir, "chat-history-v1.json");
    await fsPromises.mkdir(baseDir, { recursive: true });
    await fsPromises.writeFile(mainPath, JSON.stringify({
      version: 1,
      documents: {
        [documentA.key]: {
          path: documentA.path,
          label: documentA.label,
          lastAccessedAt: "2026-09-21T00:00:00.000Z",
          sessions: [{
            id: 42,
            title: "bad",
            mode: "text",
            createdAt: "2026-09-21T00:00:00.000Z",
            updatedAt: "2026-09-21T00:00:00.000Z",
            messages: [],
          }],
        },
      },
    }), "utf8");

    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    assert.match((await readdir(baseDir))[0], /^chat-history-v1\.corrupt-/);
    assert.throws(
      () => store.createSession({ ...documentA, key: "__proto__" }, session("bad")),
      /saved Markdown document/i,
    );
    assert.throws(() => store.createSession(documentA, session("bad-id", { id: {} })), /non-empty string/i);
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

test("snapshots queued mutation arguments before callers can change them", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    const first = store.createSession(documentA, session("first"));
    const mutableIdentity = { ...documentA };
    const mutableInput = session("snapshot", { title: "before" });
    const queued = store.createSession(mutableIdentity, mutableInput);
    mutableIdentity.key = documentB.key;
    mutableInput.id = "changed";
    mutableInput.title = "after";
    await Promise.all([first, queued]);

    assert.equal((await store.getSession(documentA, "snapshot")).title, "before");
    assert.equal(await store.getSession(documentB, "changed"), null);
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

test("rejects capacity changes that cannot retain active or self-pruned sessions", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock() });
    await store.initialize();
    for (let index = 0; index < 100; index += 1) {
      await store.createSession(documentA, session(`stream-${index}`, {
        messages: [message(`active-${index}`, "assistant", "streaming")],
      }));
    }
    await assert.rejects(
      store.createSession(documentA, session("stream-100", {
        messages: [message("active-100", "assistant", "streaming")],
      })),
      /capacity exceeded/i,
    );
    assert.equal((await store.listSessions(documentA)).length, 100);

    const inactive = createChatStore({ baseDir: path.join(baseDir, "inactive"), now: clock() });
    await inactive.initialize();
    for (let index = 0; index < 100; index += 1) {
      await inactive.createSession(documentA, session(`future-${index}`, {
        createdAt: "2027-01-01T00:00:00.000Z",
        updatedAt: "2027-01-01T00:00:00.000Z",
      }));
    }
    await assert.rejects(
      inactive.createSession(documentA, session("self-pruned", {
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      })),
      /capacity exceeded/i,
    );
    assert.equal(await inactive.getSession(documentA, "self-pruned"), null);
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

test("rolls back an oversized active stream and keeps the write queue usable", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({ baseDir, now: clock(), maxBytes: 1500 });
    await store.initialize();
    await store.createSession(documentA, session("limited"));
    await assert.rejects(
      store.appendMessage(documentA, "limited", message("too-large", "assistant", "streaming", "x".repeat(3000))),
      /capacity exceeded/i,
    );
    await store.appendMessage(documentA, "limited", message("after-failure", "user"));
    assert.deepEqual(
      (await store.getSession(documentA, "limited")).messages.map(({ id }) => id),
      ["after-failure"],
    );
  });
});

test("resolves only APPDATA-backed production storage", () => {
  assert.equal(
    getChatDataDirectory({ APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" }),
    path.join("C:\\Users\\Alice\\AppData\\Roaming", "typora-ai-edit"),
  );
  assert.throws(() => getChatDataDirectory({}), /APPDATA.*unavailable/i);
});

function imageFetch(bytes, mimeType = "image/png") {
  return async () => ({
    ok: true,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? mimeType : null) },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  });
}

test("stores local, data, and HTTP images by content reference without base64 history", async () => {
  await withTempDir(async (baseDir) => {
    const localPath = path.join(baseDir, "figure.png");
    const bytes = Buffer.from([1, 2, 3, 4]);
    await fsPromises.writeFile(localPath, bytes);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();

    const local = await store.saveImageAsset(localPath);
    const data = await store.saveImageAsset(`data:image/png;base64,${bytes.toString("base64")}`);
    const remote = await store.saveImageAsset("https://example.test/figure.png");
    assert.equal(local.assetId, data.assetId);
    assert.equal(data.assetId, remote.assetId);
    assert.match(local.storedPath, /^chat-assets\\[a-f0-9]{64}\.png$/);
    assert.equal(local.byteSize, bytes.length);
    assert.equal(remote.fallbackUrl, "https://example.test/figure.png");
    assert.equal(data.originalSource, "");
    assert.equal(await store.resolveImageAsset(local), `data:image/png;base64,${bytes.toString("base64")}`);

    await store.createSession(documentA, session("image"));
    await store.appendMessage(documentA, "image", { ...message("image-message", "user"), image: data });
    const history = await readFile(path.join(baseDir, "chat-history-v1.json"), "utf8");
    assert.doesNotMatch(history, /base64,/i);
  });
});

test("rejects missing and non-image assets while HTTP snapshot failures retain a URL fallback", async () => {
  await withTempDir(async (baseDir) => {
    const store = createChatStore({
      baseDir,
      now: clock(),
      fetch: async () => { throw new Error("offline"); },
    });
    await store.initialize();
    await assert.rejects(store.saveImageAsset(path.join(baseDir, "missing.png")), /not found/i);
    const fallback = await store.saveImageAsset("https://example.test/fallback.jpg");
    assert.equal(fallback.assetId, "");
    assert.equal(fallback.fallbackUrl, "https://example.test/fallback.jpg");
    assert.equal(await store.resolveImageAsset(fallback), fallback.fallbackUrl);

    const textStore = createChatStore({
      baseDir: path.join(baseDir, "text"),
      now: clock(),
      fetch: imageFetch([1], "text/plain"),
    });
    await textStore.initialize();
    await assert.rejects(textStore.saveImageAsset("https://example.test/not-image"), /image/i);
  });
});

test("removes an image asset only after its final history reference is deleted", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([5, 6, 7]);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const image = await store.saveImageAsset("https://example.test/shared.png");
    const assetPath = path.join(baseDir, image.storedPath);
    await store.createSession(documentA, session("one"));
    await store.createSession(documentA, session("two"));
    await store.appendMessage(documentA, "one", { ...message("one-image", "user"), image });
    await store.appendMessage(documentA, "two", { ...message("two-image", "user"), image });

    await store.deleteSession(documentA, "one");
    assert.equal((await fsPromises.stat(assetPath)).isFile(), true);
    await store.deleteSession(documentA, "two");
    await assert.rejects(fsPromises.stat(assetPath), { code: "ENOENT" });

    const second = await store.saveImageAsset("https://example.test/second.png");
    const secondPath = path.join(baseDir, second.storedPath);
    await store.createSession(documentA, session("document-clear"));
    await store.appendMessage(documentA, "document-clear", { ...message("document-image", "user"), image: second });
    await store.clearDocument(documentA);
    await assert.rejects(fsPromises.stat(secondPath), { code: "ENOENT" });

    const third = await store.saveImageAsset("https://example.test/third.png");
    const thirdPath = path.join(baseDir, third.storedPath);
    await store.createSession(documentB, session("all-clear"));
    await store.appendMessage(documentB, "all-clear", { ...message("all-image", "user"), image: third });
    await store.clearAll();
    await assert.rejects(fsPromises.stat(thirdPath), { code: "ENOENT" });
  });
});

test("serializes image references before deleting a competing final reference", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([8, 9, 10]);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const image = await store.saveImageAsset("https://example.test/queued.png");
    await store.createSession(documentA, session("old-reference"));
    await store.createSession(documentA, session("new-reference"));
    await store.appendMessage(documentA, "old-reference", { ...message("old-image", "user"), image });

    const appended = store.appendMessage(documentA, "new-reference", { ...message("new-image", "user"), image });
    const deleted = store.deleteSession(documentA, "old-reference");
    await Promise.all([appended, deleted]);
    assert.equal(await store.resolveImageAsset(image), `data:image/png;base64,${bytes.toString("base64")}`);
  });
});

test("reports cleanup errors after persisting the history deletion", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([11, 12]);
    const guardedFs = {
      ...fsPromises,
      async unlink(filePath) {
        if (String(filePath).includes("chat-assets")) {
          const error = new Error("asset is locked");
          error.code = "EPERM";
          throw error;
        }
        return fsPromises.unlink(filePath);
      },
    };
    const store = createChatStore({ baseDir, fs: guardedFs, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const image = await store.saveImageAsset("https://example.test/locked.png");
    await store.createSession(documentA, session("locked"));
    await store.appendMessage(documentA, "locked", { ...message("locked-image", "user"), image });

    await assert.rejects(store.deleteSession(documentA, "locked"), /history was updated.*cleanup failed/i);
    assert.equal(await store.getSession(documentA, "locked"), null);
  });
});

test("retention pruning removes an asset when it removes the final reference", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([13, 14]);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const image = await store.saveImageAsset("https://example.test/pruned.png");
    const assetPath = path.join(baseDir, image.storedPath);
    await store.createSession(documentA, session("oldest"));
    await store.appendMessage(documentA, "oldest", { ...message("pruned-image", "user"), image });
    for (let index = 0; index < 100; index += 1) {
      await store.createSession(documentA, session(`retained-${index}`));
    }
    assert.equal(await store.getSession(documentA, "oldest"), null);
    await assert.rejects(fsPromises.stat(assetPath), { code: "ENOENT" });
  });
});

test("a saved pending image lease survives deletion of its last prior reference", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([15, 16]);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const oldImage = await store.saveImageAsset("https://example.test/race.png");
    await store.createSession(documentA, session("race-old"));
    await store.appendMessage(documentA, "race-old", { ...message("race-old-image", "user"), image: oldImage });
    const pendingImage = await store.saveImageAsset("https://example.test/race.png");
    await store.createSession(documentA, session("race-new"));

    await store.deleteSession(documentA, "race-old");
    await store.appendMessage(documentA, "race-new", { ...message("race-new-image", "user"), image: pendingImage });
    assert.equal(await store.resolveImageAsset(pendingImage), `data:image/png;base64,${bytes.toString("base64")}`);
  });
});

test("failed image appends release their lease and remove abandoned assets", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([19, 20]);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const image = await store.saveImageAsset("https://example.test/failed.png");
    const assetPath = path.join(baseDir, image.storedPath);
    await assert.rejects(
      store.appendMessage(documentA, "missing-session", { ...message("failed-image", "user"), image }),
      /session not found/i,
    );
    await assert.rejects(fsPromises.stat(assetPath), { code: "ENOENT" });
  });
});

test("releaseImageAsset removes an abandoned pending asset and initialization sweeps old orphans", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([21, 22]);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const image = await store.saveImageAsset("https://example.test/release.png");
    const assetPath = path.join(baseDir, image.storedPath);
    await store.releaseImageAsset(image.assetId);
    await assert.rejects(fsPromises.stat(assetPath), { code: "ENOENT" });

    const orphan = path.join(baseDir, "chat-assets", `${"f".repeat(64)}.png`);
    await fsPromises.writeFile(orphan, bytes);
    const reloaded = createChatStore({ baseDir, now: clock() });
    await reloaded.initialize();
    await assert.rejects(fsPromises.stat(orphan), { code: "ENOENT" });
  });
});

test("storage capacity counts unique assets and prunes inactive sessions before rejecting pending assets", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.alloc(600, 23);
    const store = createChatStore({ baseDir, now: clock(), maxBytes: 2400, fetch: imageFetch(bytes) });
    await store.initialize();
    await store.createSession(documentA, session("old-capacity"));
    await store.appendMessage(documentA, "old-capacity", message("old-capacity-message", "user", "complete", "x".repeat(1400)));

    const shared = await store.saveImageAsset("https://example.test/capacity.png");
    assert.equal(await store.getSession(documentA, "old-capacity"), null);
    await store.createSession(documentA, session("asset-capacity"));
    await store.appendMessage(documentA, "asset-capacity", { ...message("asset-capacity-message", "user"), image: shared });
    await assert.doesNotReject(store.saveImageAsset("https://example.test/capacity.png"));

    const tooSmall = createChatStore({
      baseDir: path.join(baseDir, "too-small"),
      now: clock(),
      maxBytes: 500,
      fetch: imageFetch(bytes),
    });
    await tooSmall.initialize();
    await assert.rejects(tooSmall.saveImageAsset("https://example.test/too-large.png"), /capacity exceeded/i);
    assert.deepEqual(await readdir(path.join(baseDir, "too-small", "chat-assets")).catch(() => []), []);
  });
});

test("asset write and reserve failures leave existing history and assets unchanged", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.alloc(800, 24);
    const failingFs = {
      ...fsPromises,
      async writeFile(filePath, ...args) {
        if (String(filePath).includes("chat-assets")) throw new Error("disk full");
        return fsPromises.writeFile(filePath, ...args);
      },
    };
    const writeFailStore = createChatStore({ baseDir, fs: failingFs, now: clock(), fetch: imageFetch(bytes) });
    await writeFailStore.initialize();
    await writeFailStore.createSession(documentA, session("write-safe"));
    await assert.rejects(writeFailStore.saveImageAsset("https://example.test/write-fail.png"), /disk full/i);
    assert.notEqual(await writeFailStore.getSession(documentA, "write-safe"), null);
    assert.deepEqual(await readdir(path.join(baseDir, "chat-assets")).catch(() => []), []);

    const reserveDir = path.join(baseDir, "reserve-fail");
    const reserveFailStore = createChatStore({ baseDir: reserveDir, now: clock(), maxBytes: 700, fetch: imageFetch(bytes) });
    await reserveFailStore.initialize();
    await reserveFailStore.createSession(documentA, session("reserve-safe"));
    await assert.rejects(reserveFailStore.saveImageAsset("https://example.test/reserve-fail.png"), /capacity exceeded/i);
    assert.notEqual(await reserveFailStore.getSession(documentA, "reserve-safe"), null);
    assert.deepEqual(await readdir(path.join(reserveDir, "chat-assets")).catch(() => []), []);
  });
});

test("initialization enforces an over-limit history by pruning its oldest inactive session", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.alloc(300, 25);
    const writer = createChatStore({ baseDir, now: clock(), maxBytes: 10000, fetch: imageFetch(bytes) });
    await writer.initialize();
    const image = await writer.saveImageAsset("https://example.test/startup.png");
    await writer.createSession(documentA, session("startup-old"));
    await writer.appendMessage(documentA, "startup-old", { ...message("startup-image", "user"), image });
    await writer.createSession(documentA, session("startup-new"));
    await writer.appendMessage(documentA, "startup-new", message("startup-new-message", "user", "complete", "new"));
    const jsonSize = Buffer.byteLength(await readFile(path.join(baseDir, "chat-history-v1.json"), "utf8"));

    const reloaded = createChatStore({ baseDir, now: clock(), maxBytes: jsonSize - 100 });
    await reloaded.initialize();
    assert.equal(await reloaded.getSession(documentA, "startup-old"), null);
    assert.notEqual(await reloaded.getSession(documentA, "startup-new"), null);
    await assert.rejects(fsPromises.stat(path.join(baseDir, image.storedPath)), { code: "ENOENT" });
  });
});

test("bounds remote image reads and turns timed-out HTTP snapshots into fallbacks", async () => {
  await withTempDir(async (baseDir) => {
    let aborted = false;
    const never = async (_source, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    });
    const timeoutStore = createChatStore({ baseDir, now: clock(), fetch: never, fetchTimeoutMs: 5 });
    await timeoutStore.initialize();
    const fallback = await timeoutStore.saveImageAsset("https://example.test/timeout.png");
    assert.equal(fallback.fallbackUrl, "https://example.test/timeout.png");
    assert.equal(aborted, true);
    await assert.rejects(timeoutStore.saveImageAsset("blob:timeout"), /timed out/i);

    const ignoredFetch = createChatStore({
      baseDir: path.join(baseDir, "ignored-fetch"),
      now: clock(),
      fetch: async () => new Promise(() => {}),
      fetchTimeoutMs: 5,
    });
    await ignoredFetch.initialize();
    assert.equal((await ignoredFetch.saveImageAsset("https://example.test/ignored-fetch.png")).fallbackUrl, "https://example.test/ignored-fetch.png");

    const ignoredBody = createChatStore({
      baseDir: path.join(baseDir, "ignored-body"),
      now: clock(),
      fetch: async () => ({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Promise(() => {}),
      }),
      fetchTimeoutMs: 5,
    });
    await ignoredBody.initialize();
    assert.equal((await ignoredBody.saveImageAsset("https://example.test/ignored-body.png")).fallbackUrl, "https://example.test/ignored-body.png");

    const ignoredReader = createChatStore({
      baseDir: path.join(baseDir, "ignored-reader"),
      now: clock(),
      fetch: async () => ({
        ok: true,
        headers: { get: () => "image/png" },
        body: { getReader: () => ({ read: async () => new Promise(() => {}), cancel: async () => {}, releaseLock: () => {} }) },
      }),
      fetchTimeoutMs: 5,
    });
    await ignoredReader.initialize();
    assert.equal((await ignoredReader.saveImageAsset("https://example.test/ignored-reader.png")).fallbackUrl, "https://example.test/ignored-reader.png");

    const tooLarge = createChatStore({
      baseDir: path.join(baseDir, "too-large"),
      now: clock(),
      fetch: async () => ({
        ok: true,
        headers: { get: (name) => (name === "content-length" ? String(20 * 1024 * 1024 + 1) : "image/png") },
        arrayBuffer: async () => { throw new Error("must not read body"); },
      }),
    });
    await tooLarge.initialize();
    await assert.rejects(tooLarge.saveImageAsset("blob:too-large"), /20 MB/i);
  });
});

test("refuses symbolic-link asset roots and files", async () => {
  await withTempDir(async (baseDir) => {
    const assets = path.join(baseDir, "chat-assets");
    await fsPromises.mkdir(assets, { recursive: true });
    const linkedRootFs = {
      ...fsPromises,
      async lstat(filePath) {
        if (path.resolve(filePath) === path.resolve(assets)) return { isSymbolicLink: () => true };
        return fsPromises.lstat(filePath);
      },
    };
    await assert.rejects(createChatStore({ baseDir, fs: linkedRootFs, now: clock() }).initialize(), /symbolic link/i);

    const bytes = Buffer.from([26]);
    const writer = createChatStore({ baseDir: path.join(baseDir, "file"), now: clock(), fetch: imageFetch(bytes) });
    await writer.initialize();
    const image = await writer.saveImageAsset("https://example.test/link-file.png");
    await writer.createSession(documentA, session("linked-file"));
    await writer.appendMessage(documentA, "linked-file", { ...message("linked-file-image", "user"), image });
    const linkedFileFs = {
      ...fsPromises,
      async lstat(filePath) {
        if (path.resolve(filePath) === path.resolve(path.join(baseDir, "file", image.storedPath))) {
          return { isSymbolicLink: () => true, size: bytes.length };
        }
        return fsPromises.lstat(filePath);
      },
    };
    await assert.rejects(
      createChatStore({ baseDir: path.join(baseDir, "file"), fs: linkedFileFs, now: clock() }).initialize(),
      /asset file.*symbolic link/i,
    );
  });
});

test("rechecks the asset directory immediately before destructive cleanup", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([27]);
    const writer = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await writer.initialize();
    const image = await writer.saveImageAsset("https://example.test/flip.png");
    const assetPath = path.join(baseDir, image.storedPath);
    await writer.createSession(documentA, session("flip"));
    await writer.appendMessage(documentA, "flip", { ...message("flip-image", "user"), image });

    let flip = false;
    let rootChecks = 0;
    const guardedFs = {
      ...fsPromises,
      async lstat(filePath) {
        if (path.resolve(filePath) === path.resolve(baseDir, "chat-assets")) {
          rootChecks += 1;
          if (flip && rootChecks >= 2) return { isSymbolicLink: () => true };
        }
        return fsPromises.lstat(filePath);
      },
    };
    const guarded = createChatStore({ baseDir, fs: guardedFs, now: clock() });
    await guarded.initialize();
    flip = true;
    rootChecks = 0;
    await assert.rejects(guarded.deleteSession(documentA, "flip"), /symbolic link/i);
    assert.equal((await fsPromises.stat(assetPath)).isFile(), true);
  });
});

test("each duplicate save keeps an independent pending image lease", async () => {
  await withTempDir(async (baseDir) => {
    const bytes = Buffer.from([17, 18]);
    const store = createChatStore({ baseDir, now: clock(), fetch: imageFetch(bytes) });
    await store.initialize();
    const original = await store.saveImageAsset("https://example.test/lease.png");
    await store.createSession(documentA, session("lease-old"));
    await store.appendMessage(documentA, "lease-old", { ...message("lease-old-image", "user"), image: original });
    const firstPending = await store.saveImageAsset("https://example.test/lease.png");
    const secondPending = await store.saveImageAsset("https://example.test/lease.png");
    await store.createSession(documentA, session("lease-new"));

    await store.deleteSession(documentA, "lease-old");
    await store.appendMessage(documentA, "lease-new", { ...message("lease-new-image", "user"), image: firstPending });
    await store.deleteSession(documentA, "lease-new");
    assert.equal(await store.resolveImageAsset(secondPending), `data:image/png;base64,${bytes.toString("base64")}`);
  });
});
