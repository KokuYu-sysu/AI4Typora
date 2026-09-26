import { translate } from "./i18n.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  try {
    const crypto = typeof window !== "undefined" && window.reqnode
      ? window.reqnode("crypto")
      : typeof process !== "undefined" && process.getBuiltinModule?.("crypto");
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  throw new Error("crypto.randomUUID is unavailable for chat sessions.");
}

function messageId() {
  return `message_${uuid()}`;
}

function sessionId() {
  return `session_${uuid()}`;
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Chat clock returned an invalid date.");
  return date.toISOString();
}

function titleFor(text) {
  const value = String(text || "").trim();
  if (!value) return "New chat";
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), ({ segment }) => segment)
      .slice(0, 40).join("");
  }
  return Array.from(value).slice(0, 40).join("");
}

function isReplayable(message) {
  return message && (message.role === "user" || message.role === "assistant")
    && (message.status === "complete" || message.status === "stopped");
}

/** Build a bounded provider transcript without mutating persisted messages. */
export function buildReplayMessages(messages, {
  maxCharacters = 60000,
  resolvedImageInput = null,
} = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const complete = source.filter(isReplayable);
  const imageIndex = complete.findIndex((message) => message.role === "user" && message.image);
  const chosen = new Set();
  let used = 0;
  if (imageIndex >= 0) {
    chosen.add(imageIndex);
    used += complete[imageIndex].content.length;
  }
  const turns = [];
  for (let index = 0; index < complete.length; index += 1) {
    if (complete[index].role !== "user") continue;
    const members = [index];
    for (let cursor = index + 1; cursor < complete.length && complete[cursor].role !== "user"; cursor += 1) {
      members.push(cursor);
    }
    turns.push(members);
  }
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const members = turns[turnIndex].filter((index) => !chosen.has(index));
    const size = members.reduce((total, index) => total + complete[index].content.length, 0);
    if (!members.length) continue;
    if (used + size <= maxCharacters || turnIndex === turns.length - 1) {
      members.forEach((index) => chosen.add(index));
      used += size;
    }
  }
  return complete.flatMap((message, index) => {
    if (!chosen.has(index)) return [];
    return [{
      role: message.role,
      content: message.content,
      ...(index === imageIndex && resolvedImageInput ? { imageInput: resolvedImageInput } : {}),
    }];
  });
}

function initialState() {
  return {
    documentIdentity: null,
    sessions: [],
    activeSession: null,
    draftMode: true,
    pendingImage: null,
    requestStatus: "idle",
    error: null,
    errorKey: null,
    errorDetail: null,
  };
}

function imageSource(value) {
  if (typeof value === "string") return value;
  return value?.source || value?.originalSource || null;
}

function hasStoredAsset(value) {
  return value && typeof value === "object" && typeof value.assetId === "string";
}

export function createChatService({ store, createRequest, resolveSettings = () => ({}), getLanguage = () => "en", now = () => new Date() } = {}) {
  if (!store || typeof createRequest !== "function") throw new Error("Chat service requires a store and request factory.");
  let state = initialState();
  let activeRequest = null;
  let generation = 0;
  let navigation = 0;
  let lastFailed = null;
  const activeSubmissions = new Set();
  const listeners = new Set();
  const tr = (key) => translate(getLanguage(), key);

  const emit = () => listeners.forEach((listener) => listener(clone(state)));
  const set = (patch) => {
    state = {
      ...state,
      ...patch,
      ...(Object.prototype.hasOwnProperty.call(patch, "error") && !Object.prototype.hasOwnProperty.call(patch, "errorKey") ? { errorKey: null } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "error") && !Object.prototype.hasOwnProperty.call(patch, "errorDetail") ? { errorDetail: null } : {}),
    };
    emit();
  };
  const same = (requestGeneration, identity, id) => (
    generation === requestGeneration && state.documentIdentity?.key === identity?.key
    && state.activeSession?.id === id
  );
  const refreshSessions = async (identity = state.documentIdentity, navigationGeneration = navigation) => {
    const sessions = identity?.persistable ? await store.listSessions(identity) : [];
    if (navigation === navigationGeneration && state.documentIdentity?.key === identity?.key) set({ sessions });
    return sessions;
  };
  const releasePending = async (image = state.pendingImage) => {
    if (hasStoredAsset(image) && ![...activeSubmissions].some((submission) => submission.image === image)) await store.releaseImageAsset(image);
  };
  async function removePendingImage() {
    if (!state.pendingImage || [...activeSubmissions].some((submission) => submission.image === state.pendingImage && submission.navigation === navigation)) return;
    const image = state.pendingImage;
    set({ pendingImage: null });
    await releasePending(image);
  }
  const abort = () => {
    generation += 1;
    const handle = activeRequest;
    activeRequest = null;
    handle?.abort?.();
    return handle;
  };

  async function openDraft(identity, options = {}) {
    const navigationGeneration = ++navigation;
    abort();
    const pendingImage = state.pendingImage;
    if (pendingImage) set({ pendingImage: null });
    await releasePending(pendingImage);
    if (navigation !== navigationGeneration) return;
    const documentIdentity = clone(identity);
    state = {
      ...initialState(),
      documentIdentity,
      pendingImage: clone(options.pendingImage ?? options.imageSource ?? null),
    };
    emit();
    const sessions = documentIdentity?.persistable ? await store.listSessions(documentIdentity) : [];
    if (navigation === navigationGeneration) set({ sessions });
  }

  async function openSession(identity, id) {
    const navigationGeneration = ++navigation;
    abort();
    const pendingImage = state.pendingImage;
    if (pendingImage) set({ pendingImage: null });
    await releasePending(pendingImage);
    if (navigation !== navigationGeneration) return;
    const documentIdentity = clone(identity);
    state = { ...initialState(), documentIdentity };
    emit();
    const [sessions, activeSession] = await Promise.all([
      documentIdentity?.persistable ? store.listSessions(documentIdentity) : [],
      documentIdentity?.persistable ? store.getSession(documentIdentity, id) : null,
    ]);
    if (navigation === navigationGeneration && state.documentIdentity?.key === documentIdentity?.key) {
      set({ sessions, activeSession, draftMode: !activeSession });
    }
  }

  async function persistAssistant(identity, id, assistant, requestGeneration = null) {
    const saved = await store.appendMessage(identity, id, assistant);
    const isCurrent = () => (requestGeneration == null || same(requestGeneration, identity, id))
      && state.documentIdentity?.key === identity.key && state.activeSession?.id === id;
    if (!isCurrent()) return;
    set({ activeSession: saved });
    const sessions = await store.listSessions(identity);
    if (isCurrent()) set({ sessions });
  }

  async function send(rawText, options = {}) {
    const text = String(rawText || "").trim();
    if (!text || state.requestStatus === "sending" || state.requestStatus === "streaming" || [...activeSubmissions].some((submission) => submission.navigation === navigation && submission.generation === generation)) return;
    const identity = state.documentIdentity;
    if (!identity?.persistable) {
      set({ error: tr("chat.saveDocument"), errorKey: "chat.saveDocument" });
      return;
    }
    const requestGeneration = ++generation;
    const navigationGeneration = navigation;
    const current = (id = "") => generation === requestGeneration
      && navigation === navigationGeneration
      && state.documentIdentity?.key === identity.key
      && (!id || state.activeSession?.id === id);
    let session = state.activeSession;
    const image = state.pendingImage;
    const submission = { image, navigation: navigationGeneration, generation: requestGeneration };
    activeSubmissions.add(submission);
    set({ requestStatus: "sending" });
    let savedImage = null;
    let imagePersisted = false;
    let appendFailed = false;
    try {
      if (image) savedImage = hasStoredAsset(image) ? image : await store.saveImageAsset(imageSource(image));
      if (!current()) {
        if (savedImage && savedImage !== image) await store.releaseImageAsset(savedImage);
        return;
      }
      if (!session) {
        const createdAt = timestamp(now);
        session = await store.createSession(identity, {
          id: sessionId(), title: titleFor(text), mode: savedImage ? "image" : "text", createdAt, updatedAt: createdAt,
        });
        if (!current()) {
          if (savedImage && savedImage !== image) await store.releaseImageAsset(savedImage);
          return;
        }
        set({ activeSession: session, draftMode: false });
      }
      let user = options.retryMessageId
        ? session.messages.find((message) => message.id === options.retryMessageId && message.role === "user")
        : null;
      const reusingUser = Boolean(user);
      if (!user) {
        user = {
          id: messageId(), role: "user", content: text, createdAt: timestamp(now), status: "complete",
          ...(savedImage ? { image: clone(savedImage) } : {}),
        };
      }
      let persisted;
      try {
        persisted = reusingUser ? session : await store.appendMessage(identity, session.id, user);
      } catch (error) {
        appendFailed = true;
        if (error.historyPersisted) {
          persisted = await store.getSession(identity, session.id);
          if (!persisted?.messages.some((message) => message.id === user.id)) throw error;
        } else {
          if (hasStoredAsset(image) && current(session.id)) {
            const source = imageSource(image);
            set({ pendingImage: source ? { source } : null });
            if (!source) {
              const reattachError = new Error(error?.message || "");
              reattachError.errorKey = "chat.reattachImage";
              throw reattachError;
            }
          }
          throw error;
        }
      }
      imagePersisted = Boolean(persisted.messages.find((message) => message.id === user.id)?.image);
      if (!current(session.id)) return;
      session = persisted;
      set({ activeSession: session, pendingImage: imagePersisted ? null : state.pendingImage, error: null });
      const sessions = await store.listSessions(identity);
      if (!current(session.id)) return;
      set({ sessions });

      const firstImage = session.messages.find((message) => message.role === "user" && message.image)?.image;
      let resolvedImageInput = null;
      if (firstImage) resolvedImageInput = await store.resolveImageAsset(firstImage);
      if (!current(session.id)) return;
      const assistant = { id: messageId(), role: "assistant", content: "", createdAt: timestamp(now), status: "streaming" };
      const streamingSession = { ...session, messages: [...session.messages, assistant] };
      set({ activeSession: streamingSession, requestStatus: "streaming", error: null });
      const settings = await resolveSettings();
      if (!current(session.id)) return;
      const prompt = savedImage || firstImage ? settings?.prompts?.image_qa?.system : settings?.prompts?.qa?.system;
      const request = createRequest({
        systemPrompt: prompt || "You are a senior linguistics expert and editor.",
        messages: buildReplayMessages(session.messages, { resolvedImageInput }),
        settings,
        onAttemptStart: ({ resetOutput }) => {
          if (resetOutput && same(requestGeneration, identity, session.id)) {
            assistant.content = "";
            set({ activeSession: { ...session, messages: [...session.messages, { ...assistant }] } });
          }
        },
        onChunk: (chunk) => {
          if (!same(requestGeneration, identity, session.id)) return;
          assistant.content += String(chunk || "");
          set({ activeSession: { ...session, messages: [...session.messages, { ...assistant }] } });
        },
      });
      if (!current(session.id)) {
        request.abort?.();
        return;
      }
      activeRequest = request;
      let returned;
      try {
        returned = await request.promise;
      } catch (error) {
        if (!same(requestGeneration, identity, session.id)) return;
        activeRequest = null;
        lastFailed = { text, sessionId: session.id, messageId: user.id };
        set({
          activeSession: session,
          requestStatus: "idle",
          error: error?.name === "AbortError" || error?.uiKey ? null : String(error?.message || tr("chat.requestFailed")),
          errorKey: error?.name === "AbortError" ? null : error?.uiKey || (error?.message ? null : "chat.requestFailed"),
        });
        return;
      }
      if (!same(requestGeneration, identity, session.id)) return;
      activeRequest = null;
      if (!assistant.content) assistant.content = String(returned || "");
      assistant.status = "complete";
      await persistAssistant(identity, session.id, assistant, requestGeneration);
      if (same(requestGeneration, identity, session.id)) set({ requestStatus: "idle", error: null });
    } catch (error) {
      if (savedImage && savedImage !== image && !imagePersisted && !appendFailed) {
        await store.releaseImageAsset(savedImage).catch(() => {});
      }
      if (current(session?.id || "")) {
        lastFailed = { text, sessionId: session?.id || "", messageId: "" };
        set({ requestStatus: "idle", error: error?.errorKey ? null : String(error?.message || tr("chat.requestFailed")), errorKey: error?.errorKey || (error?.message ? null : "chat.requestFailed"), errorDetail: error?.errorKey ? error.message || null : null });
      }
    } finally {
      if (image && hasStoredAsset(image) && navigation !== navigationGeneration && !imagePersisted && !appendFailed) {
        await store.releaseImageAsset(image).catch(() => {});
      }
      activeSubmissions.delete(submission);
    }
  }

  function stop() {
    const identity = state.documentIdentity;
    const session = state.activeSession;
    const assistant = session?.messages?.at(-1);
    abort();
    if (!identity?.persistable || !session || assistant?.role !== "assistant" || assistant.status !== "streaming") {
      set({ requestStatus: "idle" });
      return Promise.resolve();
    }
    const stopped = { ...assistant, status: "stopped" };
    set({ activeSession: { ...session, messages: [...session.messages.slice(0, -1), stopped] }, requestStatus: "idle", error: null });
    return persistAssistant(identity, session.id, stopped).catch((error) => {
      if (state.documentIdentity?.key === identity.key && state.activeSession?.id === session.id) {
        set({ error: String(error?.message || tr("chat.saveStopped")), errorKey: error?.message ? null : "chat.saveStopped" });
      }
    });
  }

  async function retryLastFailed() {
    if (!lastFailed || state.requestStatus === "streaming") return;
    await send(lastFailed.text, { retryMessageId: lastFailed.sessionId === state.activeSession?.id ? lastFailed.messageId : "" });
  }

  async function renameActive(title) {
    const identity = state.documentIdentity;
    const session = state.activeSession;
    if (!identity?.persistable || !session) return;
    await store.renameSession(identity, session.id, String(title || "").trim() || "New chat");
    const activeSession = await store.getSession(identity, session.id);
    if (state.documentIdentity?.key === identity.key && state.activeSession?.id === session.id) set({ activeSession });
    await refreshSessions(identity);
  }

  async function deleteActive() {
    const identity = state.documentIdentity;
    const session = state.activeSession;
    stop();
    if (!identity?.persistable || !session) return;
    await store.deleteSession(identity, session.id);
    if (state.documentIdentity?.key === identity.key) {
      set({ activeSession: null, draftMode: true, error: null });
      await refreshSessions(identity);
    }
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    openDraft,
    openSession,
    removePendingImage,
    send,
    retryLastFailed,
    stop,
    renameActive,
    deleteActive,
    dispose() {
      const pendingImage = state.pendingImage;
      navigation += 1;
      abort();
      listeners.clear();
      state = initialState();
      return releasePending(pendingImage);
    },
    getState: () => clone(state),
  };
}
