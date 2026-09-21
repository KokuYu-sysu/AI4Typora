const STORE_VERSION = 1;
const STORE_FILENAME = "chat-history-v1.json";
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_SESSIONS_PER_DOCUMENT = 100;
const MAX_MESSAGES_PER_SESSION = 200;
const DOCUMENT_KEY_PATTERN = /^doc_[a-f0-9]{32}$/;
const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_DIRECTORY = "chat-assets";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/avif": "avif",
};

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

function isImageMimeType(value) {
  return typeof value === "string" && /^image\/[a-z0-9.+-]+$/i.test(value);
}

function imageMimeTypeFromSource(source) {
  const value = String(source || "").replace(/[?#].*$/, "").toLowerCase();
  const extension = value.slice(value.lastIndexOf("."));
  return Object.entries(IMAGE_EXTENSIONS).find(([, candidate]) => extension === `.${candidate}`)?.[0]
    || (extension === ".jpeg" ? "image/jpeg" : "image/png");
}

function extensionForImage(mimeType, source) {
  return IMAGE_EXTENSIONS[String(mimeType || "").toLowerCase()]
    || IMAGE_EXTENSIONS[imageMimeTypeFromSource(source)]
    || "img";
}

function decodeFileUrl(source) {
  try {
    const url = new URL(source);
    let value = decodeURIComponent(url.pathname || "");
    if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    return value.replace(/\//g, "\\");
  } catch (_) {
    return "";
  }
}

function parseDataImage(source) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(source);
  if (!match || !isImageMimeType(match[1])) throw new Error("Image data URL must use an image MIME type.");
  try {
    if (match[2] && match[3].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) {
      throw new Error("Image exceeds the 20 MB size limit.");
    }
    if (!match[2] && match[3].length > MAX_IMAGE_BYTES * 3) {
      throw new Error("Image exceeds the 20 MB size limit.");
    }
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 20 MB size limit.");
    return {
      bytes,
      mimeType: match[1].toLowerCase(),
    };
  } catch (error) {
    if (/exceeds the 20 MB/i.test(error?.message || "")) throw error;
    throw new Error("Image data URL is invalid.");
  }
}

function isHttpSource(source) {
  return /^https?:\/\//i.test(source);
}

function assetMetadataIsSafe(image) {
  if (!isRecord(image)) return false;
  for (const key of ["assetId", "originalSource", "mimeType", "storedPath", "fallbackUrl"]) {
    if (!hasString(image, key)) return false;
  }
  return isImageMimeType(image.mimeType)
    && (image.assetId === "" || ASSET_ID_PATTERN.test(image.assetId))
    && !/^data:/i.test(image.originalSource)
    && (image.fallbackUrl === "" || isHttpSource(image.fallbackUrl))
    && (!Object.hasOwn(image, "byteSize") || (
      Number.isInteger(image.byteSize) && image.byteSize >= 0 && image.byteSize <= MAX_IMAGE_BYTES
    ));
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

function pruneGlobal(database, maxBytes, measureBytes) {
  while (measureBytes(database) > maxBytes) {
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
  return measureBytes(database) <= maxBytes;
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
    || (Object.hasOwn(message, "image") && !assetMetadataIsSafe(message.image))) {
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
  const fetchImage = options.fetch || globalThis.fetch;
  const crypto = options.crypto || getNodeModule("crypto");
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const baseDir = String(options.baseDir || "");
  const now = options.now || (() => new Date());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!fs || !path) throw new Error("Node filesystem access is unavailable for chat history.");
  if (!baseDir) throw new Error("A chat history base directory is required.");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("Chat history byte limit must be positive.");
  if (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs <= 0) throw new Error("Image fetch timeout must be positive.");

  const mainPath = path.join(baseDir, STORE_FILENAME);
  const tempPath = `${mainPath}.tmp`;
  const assetsPath = path.resolve(baseDir, ASSET_DIRECTORY);
  let database = { version: STORE_VERSION, documents: {} };
  let initializePromise = null;
  let initialized = false;
  let writeQueue = Promise.resolve();
  const pendingAssetLeases = new Map();
  const assetSizes = new Map();
  const assetMetadataById = new Map();

  function comparablePath(value) {
    const normalized = String(value).replace(/[\\/]+$/, "");
    return typeof process !== "undefined" && process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  }

  async function ensureSafeAssetsDirectory(create = false) {
    if (create) await fs.mkdir(assetsPath, { recursive: true });
    let info;
    try {
      info = await fs.lstat(assetsPath);
    } catch (error) {
      if (error?.code === "ENOENT" && !create) return false;
      throw error;
    }
    if (info.isSymbolicLink?.()) throw new Error("Chat asset directory must not be a symbolic link.");
    const actualBase = comparablePath(await fs.realpath(baseDir));
    const actualAssets = comparablePath(await fs.realpath(assetsPath));
    if (!actualAssets.startsWith(`${actualBase}${path.sep}`)) {
      throw new Error("Chat asset directory must remain inside the chat data directory.");
    }
    return true;
  }

  async function lstatAssetFile(target) {
    const root = comparablePath(assetsPath);
    const candidate = comparablePath(path.resolve(target));
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      throw new Error("Chat asset file must remain inside the chat asset directory.");
    }
    if (!await ensureSafeAssetsDirectory()) return null;
    try {
      const info = await fs.lstat(target);
      if (info.isSymbolicLink?.()) throw new Error("Chat asset file must not be a symbolic link.");
      return info;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function unlinkSafeAsset(target) {
    if (!await lstatAssetFile(target)) return false;
    await ensureSafeAssetsDirectory();
    if (!await lstatAssetFile(target)) return false;
    // ponytail: Node has no relative directory-handle unlink; double-check here, use handle-based APIs if the threat model expands.
    await fs.unlink(target);
    return true;
  }

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error("Chat history clock returned an invalid date.");
    return date.toISOString();
  }

  function retainAssetLease(image) {
    if (image?.assetId) {
      pendingAssetLeases.set(image.assetId, (pendingAssetLeases.get(image.assetId) || 0) + 1);
    }
  }

  function consumeAssetLease(image) {
    const count = image?.assetId ? pendingAssetLeases.get(image.assetId) : 0;
    if (count > 1) pendingAssetLeases.set(image.assetId, count - 1);
    if (count === 1) pendingAssetLeases.delete(image.assetId);
  }

  function cacheAsset(image) {
    if (!image?.assetId) return;
    assetMetadataById.set(image.assetId, image);
    if (Number.isInteger(image.byteSize)) assetSizes.set(image.assetId, image.byteSize);
  }

  function storageBytes(value) {
    const assetIds = new Set([...referencedAssets(value).keys(), ...pendingAssetLeases.keys()]);
    let total = Buffer.byteLength(serialized(value), "utf8");
    for (const assetId of assetIds) total += assetSizes.get(assetId) || 0;
    return total;
  }

  function assetPathFor(image) {
    if (!assetMetadataIsSafe(image) || !image.assetId) return null;
    const filename = String(image.storedPath || "").replace(/\\/g, "/").split("/").pop();
    if (!new RegExp(`^${image.assetId}\\.[a-z0-9]{1,10}$`, "i").test(filename || "")) return null;
    const target = path.resolve(assetsPath, filename);
    const root = String(assetsPath).replace(/[\\/]+$/, "").toLowerCase();
    const normalizedTarget = String(target).toLowerCase();
    return normalizedTarget.startsWith(`${root}${path.sep.toLowerCase()}`) ? target : null;
  }

  function assetMetadata({ source, bytes, mimeType, assetId }) {
    const extension = extensionForImage(mimeType, source);
    return {
      assetId: assetId || "",
      originalSource: /^data:|^blob:/i.test(source) ? "" : source,
      mimeType,
      storedPath: assetId ? path.join(ASSET_DIRECTORY, `${assetId}.${extension}`) : "",
      fallbackUrl: isHttpSource(source) ? source : "",
      ...(assetId ? { byteSize: bytes?.byteLength || 0 } : {}),
    };
  }

  function assertImageSize(size) {
    if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 20 MB size limit.");
  }

  async function readFetchBody(response, controller) {
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
      controller.abort();
      throw new Error("Image exceeds the 20 MB size limit.");
    }
    const reader = response.body?.getReader?.();
    if (!reader) {
      const bytes = Buffer.from(await response.arrayBuffer());
      assertImageSize(bytes.byteLength);
      return bytes;
    }
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new Error("Image exceeds the 20 MB size limit.");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock?.();
    }
  }

  async function readImageSource(source) {
    if (source.startsWith("data:")) return parseDataImage(source);
    const localPath = source.startsWith("file:") ? decodeFileUrl(source) : source;
    if (!source.startsWith("blob:") && !isHttpSource(source)) {
      if (!localPath) throw new Error("Image file URL is invalid.");
      try {
        assertImageSize((await fs.stat(localPath)).size);
        const bytes = Buffer.from(await fs.readFile(localPath));
        assertImageSize(bytes.byteLength);
        return { bytes, mimeType: imageMimeTypeFromSource(localPath) };
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error(`Image file not found: ${source}`);
        throw error;
      }
    }
    if (typeof fetchImage !== "function" || typeof AbortController === "undefined") {
      throw new Error("Image fetching is unavailable.");
    }
    const controller = new AbortController();
    const timeoutError = new Error(`Image download timed out after ${fetchTimeoutMs} ms.`);
    timeoutError.code = "IMAGE_FETCH_TIMEOUT";
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, fetchTimeoutMs);
    });
    const request = (async () => {
      const response = await fetchImage(source, { signal: controller.signal });
      if (!response?.ok) throw new Error(`Image download failed${response?.status ? ` (${response.status})` : ""}.`);
      const mimeType = String(response.headers?.get?.("content-type") || imageMimeTypeFromSource(source))
        .split(";", 1)[0].trim().toLowerCase();
      if (!isImageMimeType(mimeType)) throw new Error("Image source did not return an image MIME type.");
      return { bytes: await readFetchBody(response, controller), mimeType };
    })();
    request.catch(() => {});
    try {
      return await Promise.race([request, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  function referencedAssets(value) {
    const assets = new Map();
    for (const document of Object.values(value.documents)) {
      for (const session of document.sessions) {
        for (const message of session.messages) {
          if (assetMetadataIsSafe(message.image) && message.image.assetId) {
            assets.set(message.image.assetId, message.image);
          }
        }
      }
    }
    return assets;
  }

  async function removeAssetIfUnused(assetId, image) {
    if (pendingAssetLeases.get(assetId) || referencedAssets(database).has(assetId)) return;
    const target = assetPathFor(image || assetMetadataById.get(assetId));
    if (!target) return;
    if (!await lstatAssetFile(target)) {
      assetSizes.delete(assetId);
      assetMetadataById.delete(assetId);
      return;
    }
    try {
      await unlinkSafeAsset(target);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Chat history was updated, but image asset cleanup failed: ${error?.message || error}`);
      }
    }
    assetSizes.delete(assetId);
    assetMetadataById.delete(assetId);
  }

  async function removeLostAssets(before, after) {
    await Promise.all([...before].map(([assetId, image]) => (
      after.has(assetId) ? null : removeAssetIfUnused(assetId, image)
    )));
  }

  function releaseAssetLease(image) {
    if (!image?.assetId || !pendingAssetLeases.get(image.assetId)) return Promise.resolve();
    const operation = writeQueue.then(async () => {
      if (!initialized) await initialize();
      if (!pendingAssetLeases.get(image.assetId)) return;
      consumeAssetLease(image);
      await removeAssetIfUnused(image.assetId, image);
    });
    writeQueue = operation.catch(() => {});
    return operation;
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

  async function loadLiveAssetSizes() {
    if (!await ensureSafeAssetsDirectory()) return;
    for (const [assetId, image] of referencedAssets(database)) {
      cacheAsset(image);
      const target = assetPathFor(image);
      if (!target) continue;
      try {
        if (!await lstatAssetFile(target)) continue;
        assetSizes.set(assetId, (await fs.stat(target)).size);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  async function removeStartupOrphans() {
    if (!await ensureSafeAssetsDirectory()) return;
    let filenames;
    try {
      filenames = await fs.readdir(assetsPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const live = referencedAssets(database);
    await Promise.all(filenames.map(async (filename) => {
      const match = /^([a-f0-9]{64})\.[a-z0-9]{1,10}$/i.exec(filename);
      if (!match || live.has(match[1].toLowerCase())) return;
      const image = {
        assetId: match[1].toLowerCase(),
        originalSource: "",
        mimeType: imageMimeTypeFromSource(filename),
        storedPath: path.join(ASSET_DIRECTORY, filename),
        fallbackUrl: "",
        byteSize: 0,
      };
      const target = assetPathFor(image);
      if (!target) return;
      try {
        if (!await lstatAssetFile(target)) return;
        await unlinkSafeAsset(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }));
  }

  async function enforceInitialRetention() {
    const nextDatabase = copy(database);
    const beforeAssets = referencedAssets(database);
    retain(nextDatabase);
    if (serialized(nextDatabase) === serialized(database)) return;
    await writeJsonAtomically(nextDatabase);
    database = nextDatabase;
    try {
      await removeLostAssets(beforeAssets, referencedAssets(nextDatabase));
    } catch (error) {
      error.historyPersisted = true;
      throw error;
    }
  }

  async function initialize() {
    if (!initializePromise) {
      initializePromise = readDatabase().then(async () => {
        await loadLiveAssetSizes();
        await removeStartupOrphans();
        await enforceInitialRetention();
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
    if (!pruneGlobal(nextDatabase, maxBytes, storageBytes)) {
      throw new Error("Chat history capacity exceeded: active content exceeds the storage limit.");
    }
  }

  async function ready() {
    if (!initialized) await initialize();
    await writeQueue;
  }

  function mutate(change, assertRetained, onPersisted) {
    const operation = writeQueue.then(async () => {
      if (!initialized) await initialize();
      const nextDatabase = copy(database);
      const beforeAssets = referencedAssets(database);
      const result = change(nextDatabase);
      retain(nextDatabase);
      if (assertRetained && !assertRetained(nextDatabase, result)) {
        throw new Error("Chat history capacity exceeded: the changed session cannot be retained.");
      }
      for (const image of referencedAssets(nextDatabase).values()) cacheAsset(image);
      await writeJsonAtomically(nextDatabase);
      database = nextDatabase;
      try {
        onPersisted?.();
        await removeLostAssets(beforeAssets, referencedAssets(nextDatabase));
      } catch (error) {
        error.historyPersisted = true;
        throw error;
      }
      return copy(result);
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function reserveAssetLeaseInQueue(image) {
    const nextDatabase = copy(database);
    const beforeAssets = referencedAssets(database);
    const priorSize = assetSizes.get(image.assetId);
    const priorMetadata = assetMetadataById.get(image.assetId);
    const priorLease = pendingAssetLeases.get(image.assetId) || 0;
    let persisted = false;
    cacheAsset(image);
    retainAssetLease(image);
    try {
      retain(nextDatabase);
      if (serialized(nextDatabase) !== serialized(database)) {
        await writeJsonAtomically(nextDatabase);
        database = nextDatabase;
        persisted = true;
        await removeLostAssets(beforeAssets, referencedAssets(nextDatabase));
      }
    } catch (error) {
      if (!persisted) {
        if (priorSize === undefined) assetSizes.delete(image.assetId);
        else assetSizes.set(image.assetId, priorSize);
        if (priorMetadata === undefined) assetMetadataById.delete(image.assetId);
        else assetMetadataById.set(image.assetId, priorMetadata);
        if (priorLease) pendingAssetLeases.set(image.assetId, priorLease);
        else pendingAssetLeases.delete(image.assetId);
      } else {
        error.historyPersisted = true;
      }
      throw error;
    }
  }

  async function writeAssetAtomicallyIfMissing(target, bytes) {
    await ensureSafeAssetsDirectory(true);
    if (await lstatAssetFile(target)) return false;
    const suffix = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temp = `${target}.${suffix}.tmp`;
    try {
      await ensureSafeAssetsDirectory(true);
      if (await lstatAssetFile(temp)) throw new Error("Chat asset temporary file already exists.");
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await ensureSafeAssetsDirectory(true);
      if (await lstatAssetFile(target)) {
        await unlinkSafeAsset(temp);
        return false;
      }
      await fs.rename(temp, target);
      return true;
    } catch (error) {
      try {
        await unlinkSafeAsset(temp);
      } catch (_) {}
      throw error;
    }
  }

  function writeAndReserveAsset(image, bytes, target) {
    const operation = writeQueue.then(async () => {
      if (!initialized) await initialize();
      let created = false;
      try {
        created = await writeAssetAtomicallyIfMissing(target, bytes);
        await reserveAssetLeaseInQueue(image);
      } catch (error) {
        if (created && !error.historyPersisted
          && !pendingAssetLeases.get(image.assetId) && !referencedAssets(database).has(image.assetId)) {
          try {
            await unlinkSafeAsset(target);
          } catch (cleanupError) {
            if (cleanupError?.code !== "ENOENT") {
              throw new Error(`Image storage failed and rollback cleanup failed: ${cleanupError?.message || cleanupError}`);
            }
          }
        }
        throw error;
      }
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
    flush: ready,

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
      if (Object.hasOwn(safeInput, "image") && !assetMetadataIsSafe(safeInput.image)) {
        throw new TypeError("Chat message image must be persisted image metadata.");
      }
      const persisted = mutate((nextDatabase) => {
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
      }, (nextDatabase) => sessionIsRetained(nextDatabase, safeIdentity, safeSessionId), () => {
        consumeAssetLease(safeInput.image);
      });
      return persisted.catch(async (error) => {
        if (!error.historyPersisted) await releaseAssetLease(safeInput.image);
        throw error;
      });
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
      if (Object.hasOwn(safePatch, "image") && !assetMetadataIsSafe(safePatch.image)) {
        throw new TypeError("Chat message image must be persisted image metadata.");
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

    async saveImageAsset(source) {
      await ready();
      const safeSource = String(source || "").trim();
      if (!safeSource) throw new Error("Image source is empty.");
      let image;
      try {
        image = await readImageSource(safeSource);
      } catch (error) {
        if (isHttpSource(safeSource) && !/MIME type/i.test(error?.message || "")) {
          return assetMetadata({ source: safeSource, mimeType: imageMimeTypeFromSource(safeSource) });
        }
        throw error;
      }
      if (!isImageMimeType(image.mimeType)) throw new Error("Image MIME type is not supported.");
      if (image.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 20 MB size limit.");
      if (!crypto?.createHash) throw new Error("Node crypto module is unavailable for image storage.");
      const assetId = crypto.createHash("sha256").update(image.bytes).digest("hex");
      await ensureSafeAssetsDirectory(true);
      const existing = (await fs.readdir(assetsPath)).find((filename) => (
        new RegExp(`^${assetId}\\.[a-z0-9]{1,10}$`, "i").test(filename)
      ));
      const metadata = assetMetadata({
        source: safeSource,
        mimeType: existing ? imageMimeTypeFromSource(existing) : image.mimeType,
        assetId,
        bytes: image.bytes,
      });
      const target = assetPathFor(metadata);
      if (!target) throw new Error("Image asset path is invalid.");
      await writeAndReserveAsset(metadata, image.bytes, target);
      return metadata;
    },

    releaseImageAsset(asset) {
      const image = typeof asset === "string"
        ? assetMetadataById.get(asset)
        : snapshot(asset, "Image asset metadata");
      if (!image) return Promise.resolve();
      if (!assetMetadataIsSafe(image)) throw new TypeError("Image asset metadata is invalid.");
      return releaseAssetLease(image);
    },

    async resolveImageAsset(imageMeta) {
      await ready();
      const image = snapshot(imageMeta, "Image asset metadata");
      if (!assetMetadataIsSafe(image)) throw new TypeError("Image asset metadata is invalid.");
      const target = assetPathFor(image);
      if (target) {
        const info = await lstatAssetFile(target);
        if (info) {
          assertImageSize(info.size);
          let bytes;
          try {
            bytes = await fs.readFile(target);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          if (bytes) {
          assertImageSize(bytes.byteLength);
          await lstatAssetFile(target);
          return `data:${image.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
          }
        }
      }
      if (image.fallbackUrl) return image.fallbackUrl;
      throw new Error("Stored image asset is unavailable.");
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
