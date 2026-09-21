const STORE_VERSION = 1;
const STORE_FILENAME = "chat-history-v1.json";
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_SESSIONS_PER_DOCUMENT = 100;
const MAX_MESSAGES_PER_SESSION = 200;

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
    // still observe the retention limit. Never remove an active stream.
    const oldestFinishedMessage = session.messages.findIndex((message) => message.status !== "streaming");
    if (oldestFinishedMessage < 0) break;
    session.messages.splice(oldestFinishedMessage, 1);
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
}

function assertDocumentIdentity(identity) {
  if (!identity?.persistable || !identity.key || !identity.path) {
    throw new Error("Chat history requires a saved Markdown document.");
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
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
      const suffix = timestamp().replace(/[:.]/g, "-");
      const corruptPath = path.join(baseDir, `chat-history-v1.corrupt-${suffix}.json`);
      await fs.rename(mainPath, corruptPath);
      await removeStaleTemp();
      return;
    }

    if (parsed?.version !== STORE_VERSION) {
      throw new Error(`Unsupported chat history schema version ${String(parsed?.version)}.`);
    }
    if (!parsed.documents || typeof parsed.documents !== "object" || Array.isArray(parsed.documents)) {
      throw new Error("Chat history schema v1 is invalid.");
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
      pruneDocumentSessions(document);
    }
    pruneGlobal(nextDatabase, maxBytes);
  }

  async function ready() {
    if (!initialized) await initialize();
    await writeQueue;
  }

  function mutate(change) {
    const operation = writeQueue.then(async () => {
      if (!initialized) await initialize();
      const nextDatabase = copy(database);
      const result = change(nextDatabase);
      retain(nextDatabase);
      await writeJsonAtomically(nextDatabase);
      database = nextDatabase;
      return copy(result);
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function documentFor(nextDatabase, identity, create = false) {
    assertDocumentIdentity(identity);
    let document = nextDatabase.documents[identity.key];
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

  return {
    initialize,

    async listSessions(identity) {
      await ready();
      if (!identity?.persistable) return [];
      const document = database.documents[identity.key];
      if (!document) return [];
      return document.sessions
        .map(({ messages, ...session }) => ({ ...session, messageCount: messages.length }))
        .sort((left, right) => compareOldest(right, left))
        .map(copy);
    },

    async getSession(identity, sessionId) {
      await ready();
      if (!identity?.persistable) return null;
      return copy(findSession(database, identity, sessionId));
    },

    createSession(identity, input) {
      assertRecord(input, "Chat session");
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, identity, true);
        const createdAt = input.createdAt || timestamp();
        const value = {
          id: input.id || createId("session"),
          title: String(input.title || "New chat"),
          mode: String(input.mode || "text"),
          createdAt,
          updatedAt: input.updatedAt || createdAt,
          messages: Array.isArray(input.messages) ? copy(input.messages) : [],
        };
        if (document.sessions.some((session) => session.id === value.id)) {
          throw new Error(`Chat session already exists: ${value.id}`);
        }
        document.sessions.push(value);
        document.lastAccessedAt = value.updatedAt;
        return value;
      });
    },

    appendMessage(identity, sessionId, input) {
      assertRecord(input, "Chat message");
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, identity);
        const session = requireSession(nextDatabase, identity, sessionId);
        const value = {
          id: input.id || createId("message"),
          role: String(input.role || ""),
          content: String(input.content || ""),
          createdAt: input.createdAt || timestamp(),
          status: String(input.status || "complete"),
          ...(input.image ? { image: copy(input.image) } : {}),
        };
        if (!value.role) throw new Error("Chat message role is required.");
        if (session.messages.some((message) => message.id === value.id)) {
          throw new Error(`Chat message already exists: ${value.id}`);
        }
        session.messages.push(value);
        session.updatedAt = timestamp();
        document.lastAccessedAt = session.updatedAt;
        return session;
      });
    },

    updateMessage(identity, sessionId, messageId, patch) {
      assertRecord(patch, "Chat message patch");
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, identity);
        const session = requireSession(nextDatabase, identity, sessionId);
        const message = session.messages.find((candidate) => candidate.id === messageId);
        if (!message) throw new Error(`Chat message not found: ${messageId}`);
        for (const key of ["content", "status", "image"]) {
          if (Object.hasOwn(patch, key)) message[key] = copy(patch[key]);
        }
        session.updatedAt = timestamp();
        document.lastAccessedAt = session.updatedAt;
        return session;
      });
    },

    renameSession(identity, sessionId, title) {
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, identity);
        const session = requireSession(nextDatabase, identity, sessionId);
        session.title = String(title || "New chat");
        session.updatedAt = timestamp();
        document.lastAccessedAt = session.updatedAt;
      });
    },

    deleteSession(identity, sessionId) {
      return mutate((nextDatabase) => {
        const document = documentFor(nextDatabase, identity);
        if (!document) return;
        const index = document.sessions.findIndex((session) => session.id === sessionId);
        if (index >= 0) document.sessions.splice(index, 1);
        document.lastAccessedAt = timestamp();
      });
    },

    clearDocument(identity) {
      return mutate((nextDatabase) => {
        assertDocumentIdentity(identity);
        delete nextDatabase.documents[identity.key];
      });
    },

    clearAll() {
      return mutate((nextDatabase) => {
        nextDatabase.documents = {};
      });
    },
  };
}
