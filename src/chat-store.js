const STORE_VERSION = 1;
const STORE_FILENAME = "chat-history-v1.json";
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_SESSIONS_PER_DOCUMENT = 100;
const MAX_MESSAGES_PER_SESSION = 200;
const DOCUMENT_KEY_PATTERN = /^doc_[a-f0-9]{32}$/;

function getNodeModule(name) {
  try {
    if (typeof window !== "undefined" && window.reqnode) return window.reqnode(name);
  } catch (_) {}
  try {
    if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
      return process.getBuiltinModule(name);
    }
  } catch (_) {}
  try {
    if (typeof require === "function") return require(name);
  } catch (_) {}
  return null;
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasString(record, key) {
  return Object.hasOwn(record, key) && typeof record[key] === "string";
}

function hasId(record, key = "id") {
  return hasString(record, key) && record[key].trim().length > 0;
}

function hasTimestamp(record, key) {
  if (!hasString(record, key)) return false;
  const timestamp = new Date(record[key]);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === record[key];
}

function assertId(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function isStreaming(session) {
  return session.messages.some((message) => message.status === "streaming");
}

function compareOldest(left, right) {
  return String(left.updatedAt).localeCompare(String(right.updatedAt))
    || String(left.createdAt).localeCompare(String(right.createdAt));
}

function pruneMessages(session) {
  while (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    let turnEnd = -1;
    for (let index = 0; index < session.messages.length; index += 1) {
      const message = session.messages[index];
      if (message.status === "streaming") break;
      if (message.role === "assistant") {
        turnEnd = index;
        break;
      }
    }
    if (turnEnd >= 0) {
      session.messages.splice(0, turnEnd + 1);
      continue;
    }

    // A long, unanswered input sequence is not a complete turn, but it must
    // still observe the retention limit.
    const oldestFinishedMessage = session.messages.findIndex((message) => message.status !== "streaming");
    if (oldestFinishedMessage >= 0) {
      session.messages.splice(oldestFinishedMessage, 1);
      continue;
    }

    // The only remaining messages are stale streaming placeholders. Keep the
    // newest active one and discard the oldest placeholder to enforce the cap.
    session.messages.shift();
  }
}

function pruneDocumentSessions(document) {
  while (document.sessions.length > MAX_SESSIONS_PER_DOCUMENT) {
    const candidate = document.sessions
      .filter((session) => !isStreaming(session))
      .sort(compareOldest)[0];
    if (!candidate) break;
    document.sessions.splice(document.sessions.indexOf(candidate), 1);
  }
  return document.sessions.length <= MAX_SESSIONS_PER_DOCUMENT;
}

function serialized(database) {
  return `${JSON.stringify(database, null, 2)}\n`;
}

function pruneGlobal(database, maxBytes) {
  while (Buffer.byteLength(serialized(database), "utf8") > maxBytes) {
    const candidates = Object.entries(database.documents).flatMap(([documentKey, document]) => (
      document.sessions
        .filter((session) => !isStreaming(session))
        .map((session) => ({ documentKey, session }))
    ));
    candidates.sort((left, right) => compareOldest(left.session, right.session));
    const candidate = candidates[0];
    if (!candidate) break;
    const document = database.documents[candidate.documentKey];
    document.sessions.splice(document.sessions.indexOf(candidate.session), 1);
    if (document.sessions.length === 0) delete database.documents[candidate.documentKey];
  }
  return Buffer.byteLength(serialized(database), "utf8") <= maxBytes;
}

function assertDocumentIdentity(identity) {
  if (!isRecord(identity) || !identity.persistable
    || typeof identity.key !== "string" || !DOCUMENT_KEY_PATTERN.test(identity.key)
    || typeof identity.path !== "string" || !identity.path
    || typeof identity.label !== "string") {
    throw new Error("Chat history requires a saved Markdown document.");
  }
}

function assertRecord(value, label) {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function validateMessage(message) {
  if (!isRecord(message) || !hasId(message) || !hasString(message, "role")
    || !hasString(message, "content") || !hasTimestamp(message, "createdAt")
    || !hasString(message, "status")
    || (Object.hasOwn(message, "image") && !isRecord(message.image))) {
    throw new Error("Chat history contains an invalid message.");
  }
}

function validateSession(session) {
  if (!isRecord(session) || !hasId(session) || !hasString(session, "title")
    || !hasString(session, "mode") || !hasTimestamp(session, "createdAt")
    || !hasTimestamp(session, "updatedAt") || !Array.isArray(session.messages)) {
    throw new Error("Chat history contains an invalid session.");
  }
  session.messages.forEach(validateMessage);
}

function validateDatabase(value) {
  if (!isRecord(value) || !Object.hasOwn(value, "version") || value.version !== STORE_VERSION
    || !Object.hasOwn(value, "documents") || !isRecord(value.documents)) {
    throw new Error("Chat history schema v1 is invalid.");
  }
  for (const [key, document] of Object.entries(value.documents)) {
    if (!DOCUMENT_KEY_PATTERN.test(key) || !isRecord(document)
      || !hasString(document, "path") || !hasString(document, "label")
      || !hasTimestamp(document, "lastAccessedAt") || !Array.isArray(document.sessions)) {
      throw new Error("Chat history contains an invalid document.");
    }
    document.sessions.forEach(validateSession);
  }
}

function createId(prefix) {
  const crypto = getNodeModule("crypto");
  if (!crypto?.randomUUID) throw new Error("Node crypto module is unavailable for chat history.");
  return `${prefix}_${crypto.randomUUID()}`;
}

export function createChatStore(options = {}) {
  const fs = options.fs || getNodeModule("fs")?.promises;
  const path = options.path || getNodeModule("path");
  const baseDir = String(options.baseDir || "");
  const now = options.now || (() => new Date());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!fs || !path) throw new Error("Node filesystem access is unavailable for chat history.");
  if (!baseDir) throw new Error("A chat history base directory is required.");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("Chat history byte limit must be positive.");

  const mainPath = path.join(baseDir, STORE_FILENAME);
  const tempPath = `${mainPath}.tmp`;
  let database = { version: STORE_VERSION, documents: {} };
  let initializePromise = null;
  let initialized = false;
  let writeQueue = Promise.resolve();

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error("Chat history clock returned an invalid date.");
    return date.toISOString();
  }

  async function removeStaleTemp() {
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async function readDatabase() {
    let text;
    try {
      text = await fs.readFile(mainPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        await removeStaleTemp();
        return;
      }
      throw new Error(`Unable to read chat history: ${error.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = null;
    }

    if (!parsed || typeof parsed !== "object") {
      const suffix = timestamp().replace(/[:.]/g, "-");
      const corruptPath = path.join(baseDir, `chat-history-v1.corrupt-${suffix}.json`);
      await fs.rename(mainPath, corruptPath);
      await removeStaleTemp();
      return;
    }

    if (typeof parsed.version === "number" && parsed.version > STORE_VERSION) {
      throw new Error(`Unsupported chat history schema version ${String(parsed?.version)}.`);
    }
    try {
      validateDatabase(parsed);
    } catch (_) {
      const suffix = timestamp().replace(/[:.]/g, "-");
      const corruptPath = path.join(baseDir, `chat-history-v1.corrupt-${suffix}.json`);
      await fs.rename(mainPath, corruptPath);
      await removeStaleTemp();
      return;
    }
    database = parsed;
    await removeStaleTemp();
  }

  async function initialize() {
    if (!initializePromise) {
      initializePromise = readDatabase().then(() => {
        initialized = true;
      });
    }
    return initializePromise;
  }

  async function writeJsonAtomically(nextDatabase) {
    await fs.mkdir(baseDir, { recursive: true });
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(serialized(nextDatabase), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, mainPath);
  }

  function retain(nextDatabase) {
    for (const document of Object.values(nextDatabase.documents)) {
      for (const session of document.sessions) pruneMessages(session);
      if (!pruneDocumentSessions(document)) {
        throw new Error("Chat history capacity exceeded: active sessions cannot be pruned.");
      }
    }
    if (!pruneGlobal(nextDatabase, maxBytes)) {
      throw new Error("Chat history capacity exceeded: active content exceeds the storage limit.");
    }
  }

  async function ready() {
    if (!initialized) await initialize();
    await writeQueue;
  }

  function mutate(change, assertRetained) {
    const operation = writeQueue.then(async () => {
      if (!initialized) await initialize();
      const nextDatabase = copy(database);
      const result = change(nextDatabase);
      retain(nextDatabase);
      if (assertRetained && !assertRetained(nextDatabase, result)) {
        throw new Error("Chat history capacity exceeded: the changed session cannot be retained.");
      }
      await writeJsonAtomically(nextDatabase);
      database = nextDatabase;
      return copy(result);
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function documentFor(nextDatabase, identity, create = false) {
    assertDocumentIdentity(identity);
    let document = Object.hasOwn(nextDatabase.documents, identity.key)
      ? nextDatabase.documents[identity.key]
      : null;
    if (!document && create) {
      document = {
        path: identity.path,
        label: identity.label,
        lastAccessedAt: timestamp(),
        sessions: [],
      };
      nextDatabase.documents[identity.key] = document;
    }
    return document || null;
  }

  function findSession(nextDatabase, identity, sessionId) {
    const document = documentFor(nextDatabase, identity);
    return document?.sessions.find((session) => session.id === sessionId) || null;
  }

  function requireSession(nextDatabase, identity, sessionId) {
    const session = findSession(nextDatabase, identity, sessionId);
    if (!session) throw new Error(`Chat session not found: ${sessionId}`);
    return session;
  }

  function snapshot(value, label) {
    try {
      return copy(value);
    } catch (_) {
      throw new TypeError(`${label} must be JSON-compatible.`);
    }
  }

  function assertOptionalId(value, key, label) {
    if (Object.hasOwn(value, key)) assertId(value[key], label);
  }

  function assertOptionalTimestamp(value, key, label) {
    if (Object.hasOwn(value, key) && !hasTimestamp(value, key)) {
      throw new TypeError(`${label} must be an ISO timestamp.`);
    }
  }

  function assertOptionalString(value, key, label) {
    if (Object.hasOwn(value, key) && typeof value[key] !== "string") {
      throw new TypeError(`${label} must be a string.`);
    }
  }

  function sessionIsRetained(nextDatabase, identity, sessionId) {
    return Boolean(findSession(nextDatabase, identity, sessionId));
  }

  return {
    initialize,

    async listSessions(identity) {
      await ready();
      if (!identity?.persistable) return [];
      const safeIdentity = snapshot(identity, "Document identity");
      assertDocumentIdentity(safeIdentity);
      const document = Object.hasOwn(database.documents, safeIdentity.key)
        ? database.documents[safeIdentity.key]
        : null;
      if (!document) return [];
      return document.sessions
        .map(({ messages, ...session }) => ({ ...session, messageCount: messages.length }))
        .sort((left, right) => compareOldest(right, left))
        .map(copy);
    },

    async getSession(identity, sessionId) {
      await ready();
      if (!identity?.persistable) return null;
      const safeIdentity = snapshot(identity, "Document identity");
      const safeSessionId = snapshot(sessionId, "Chat session ID");
      assertDocumentIdentity(safeIdentity);
      assertId(safeSessionId, "Chat session ID");
      return copy(findSession(database, safeIdentity, safeSessionId));
    },

    createSession(identity, input) {
      const safeIdentity = snapshot(identity, "Document identity");
      const safeInput = snapshot(input, "Chat session");
      assertDocumentIdentity(safeIdentity);
      assertRecord(safeInput, "Chat session");
      assertOptionalId(safeInput, "id", "Chat session ID");
      assertOptionalString(safeInput, "title", "Chat session title");
      assertOptionalString(safeInput, "mode", "Chat session mode");
      assertOptionalTimestamp(safeInput, "createdAt", "Chat session createdAt");
      assertOptionalTimestamp(safeInput, "updatedAt", "Chat session updatedAt");
      if (Object.hasOwn(safeInput, "messages")) {
        if (!Array.isArray(safeInput.messages)) throw new TypeError("Chat session messages must be an array.");
        safeInput.messages.forEach(validateMessage);
      }
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, safeIdentity, true);
        const createdAt = safeInput.createdAt || timestamp();
        const value = {
          id: safeInput.id || createId("session"),
          title: safeInput.title || "New chat",
          mode: safeInput.mode || "text",
          createdAt,
          updatedAt: safeInput.updatedAt || createdAt,
          messages: Array.isArray(safeInput.messages) ? copy(safeInput.messages) : [],
        };
        if (document.sessions.some((session) => session.id === value.id)) {
          throw new Error(`Chat session already exists: ${value.id}`);
        }
        document.sessions.push(value);
        document.lastAccessedAt = value.updatedAt;
        return value;
      }, (nextDatabase, value) => sessionIsRetained(nextDatabase, safeIdentity, value.id));
    },

    appendMessage(identity, sessionId, input) {
      const safeIdentity = snapshot(identity, "Document identity");
      const safeSessionId = snapshot(sessionId, "Chat session ID");
      const safeInput = snapshot(input, "Chat message");
      assertDocumentIdentity(safeIdentity);
      assertId(safeSessionId, "Chat session ID");
      assertRecord(safeInput, "Chat message");
      assertOptionalId(safeInput, "id", "Chat message ID");
      assertOptionalString(safeInput, "role", "Chat message role");
      assertOptionalString(safeInput, "content", "Chat message content");
      assertOptionalString(safeInput, "status", "Chat message status");
      assertOptionalTimestamp(safeInput, "createdAt", "Chat message createdAt");
      if (Object.hasOwn(safeInput, "image") && !isRecord(safeInput.image)) {
        throw new TypeError("Chat message image must be an object.");
      }
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, safeIdentity);
        const session = requireSession(nextDatabase, safeIdentity, safeSessionId);
        const value = {
          id: safeInput.id || createId("message"),
          role: safeInput.role || "",
          content: safeInput.content || "",
          createdAt: safeInput.createdAt || timestamp(),
          status: safeInput.status || "complete",
          ...(Object.hasOwn(safeInput, "image") ? { image: copy(safeInput.image) } : {}),
        };
        if (!value.role) throw new Error("Chat message role is required.");
        if (session.messages.some((message) => message.id === value.id)) {
          throw new Error(`Chat message already exists: ${value.id}`);
        }
        session.messages.push(value);
        session.updatedAt = timestamp();
        document.lastAccessedAt = session.updatedAt;
        return session;
      }, (nextDatabase) => sessionIsRetained(nextDatabase, safeIdentity, safeSessionId));
    },

    updateMessage(identity, sessionId, messageId, patch) {
      const safeIdentity = snapshot(identity, "Document identity");
      const safeSessionId = snapshot(sessionId, "Chat session ID");
      const safeMessageId = snapshot(messageId, "Chat message ID");
      const safePatch = snapshot(patch, "Chat message patch");
      assertDocumentIdentity(safeIdentity);
      assertId(safeSessionId, "Chat session ID");
      assertId(safeMessageId, "Chat message ID");
      assertRecord(safePatch, "Chat message patch");
      assertOptionalString(safePatch, "content", "Chat message content");
      assertOptionalString(safePatch, "status", "Chat message status");
      if (Object.hasOwn(safePatch, "image") && !isRecord(safePatch.image)) {
        throw new TypeError("Chat message image must be an object.");
      }
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, safeIdentity);
        const session = requireSession(nextDatabase, safeIdentity, safeSessionId);
        const message = session.messages.find((candidate) => candidate.id === safeMessageId);
        if (!message) throw new Error(`Chat message not found: ${safeMessageId}`);
        for (const key of ["content", "status", "image"]) {
          if (Object.hasOwn(safePatch, key)) message[key] = copy(safePatch[key]);
        }
        session.updatedAt = timestamp();
        document.lastAccessedAt = session.updatedAt;
        return session;
      }, (nextDatabase) => sessionIsRetained(nextDatabase, safeIdentity, safeSessionId));
    },

    renameSession(identity, sessionId, title) {
      const safeIdentity = snapshot(identity, "Document identity");
      const safeSessionId = snapshot(sessionId, "Chat session ID");
      const safeTitle = snapshot(title, "Chat session title");
      assertDocumentIdentity(safeIdentity);
      assertId(safeSessionId, "Chat session ID");
      assertOptionalString({ title: safeTitle }, "title", "Chat session title");
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, safeIdentity);
        const session = requireSession(nextDatabase, safeIdentity, safeSessionId);
        session.title = safeTitle || "New chat";
        session.updatedAt = timestamp();
        document.lastAccessedAt = session.updatedAt;
      }, (nextDatabase) => sessionIsRetained(nextDatabase, safeIdentity, safeSessionId));
    },

    deleteSession(identity, sessionId) {
      const safeIdentity = snapshot(identity, "Document identity");
      const safeSessionId = snapshot(sessionId, "Chat session ID");
      assertDocumentIdentity(safeIdentity);
      assertId(safeSessionId, "Chat session ID");
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, safeIdentity);
        if (!document) return;
        const index = document.sessions.findIndex((session) => session.id === safeSessionId);
        if (index >= 0) document.sessions.splice(index, 1);
        document.lastAccessedAt = timestamp();
      });
    },

    clearDocument(identity) {
      const safeIdentity = snapshot(identity, "Document identity");
      assertDocumentIdentity(safeIdentity);
      return mutate((nextDatabase) => {
        delete nextDatabase.documents[safeIdentity.key];
      });
    },

    clearAll() {
      return mutate((nextDatabase) => {
        nextDatabase.documents = {};
      });
    },
  };
}
