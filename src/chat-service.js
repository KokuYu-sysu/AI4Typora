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
  };
}

function imageSource(value) {
  if (typeof value === "string") return value;
  return value?.source || value?.originalSource || null;
}

function hasStoredAsset(value) {
  return value && typeof value === "object" && typeof value.assetId === "string";
}

export function createChatService({ store, createRequest, resolveSettings = () => ({}), now = () => new Date() } = {}) {
  if (!store || typeof createRequest !== "function") throw new Error("Chat service requires a store and request factory.");
  let state = initialState();
  let activeRequest = null;
  let generation = 0;
  let lastFailed = null;
  const listeners = new Set();

  const emit = () => listeners.forEach((listener) => listener(clone(state)));
  const set = (patch) => {
    state = { ...state, ...patch };
    emit();
  };
  const same = (requestGeneration, identity, id) => (
    generation === requestGeneration && state.documentIdentity?.key === identity?.key
    && state.activeSession?.id === id
  );
  const refreshSessions = async (identity = state.documentIdentity) => {
    const sessions = identity?.persistable ? await store.listSessions(identity) : [];
    if (state.documentIdentity?.key === identity?.key) set({ sessions });
    return sessions;
  };
  const releasePending = async () => {
    const image = state.pendingImage;
    if (hasStoredAsset(image)) await store.releaseImageAsset(image);
  };
  const abort = () => {
    generation += 1;
    const handle = activeRequest;
    activeRequest = null;
    handle?.abort?.();
    return handle;
  };

  async function openDraft(identity, options = {}) {
    abort();
    await releasePending();
    const documentIdentity = clone(identity);
    state = {
      ...initialState(),
      documentIdentity,
      pendingImage: clone(options.pendingImage ?? options.imageSource ?? null),
    };
    emit();
    await refreshSessions(documentIdentity);
  }

  async function openSession(identity, id) {
    abort();
    await releasePending();
    const documentIdentity = clone(identity);
    state = { ...initialState(), documentIdentity };
    emit();
    const [sessions, activeSession] = await Promise.all([
      documentIdentity?.persistable ? store.listSessions(documentIdentity) : [],
      documentIdentity?.persistable ? store.getSession(documentIdentity, id) : null,
    ]);
    if (state.documentIdentity?.key === documentIdentity?.key) {
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
    if (!text || state.requestStatus === "streaming") return;
    const identity = state.documentIdentity;
    if (!identity?.persistable) {
      set({ error: "Please save the Markdown document before starting a conversation." });
      return;
    }
    const requestGeneration = ++generation;
    const current = (id = "") => generation === requestGeneration
      && state.documentIdentity?.key === identity.key
      && (!id || state.activeSession?.id === id);
    let session = state.activeSession;
    let image = state.pendingImage;
    let savedImage = null;
    let imagePersisted = false;
    try {
      if (!session) {
        if (image) savedImage = hasStoredAsset(image) ? image : await store.saveImageAsset(imageSource(image));
        if (!current()) {
          if (savedImage) await store.releaseImageAsset(savedImage);
          return;
        }
        const createdAt = timestamp(now);
        session = await store.createSession(identity, {
          id: sessionId(), title: titleFor(text), mode: savedImage ? "image" : "text", createdAt, updatedAt: createdAt,
        });
        if (!current()) {
          if (savedImage) await store.releaseImageAsset(savedImage);
          return;
        }
        set({ activeSession: session, draftMode: false, pendingImage: null });
        image = savedImage;
      }
      let user = options.retryMessageId
        ? session.messages.find((message) => message.id === options.retryMessageId && message.role === "user")
        : null;
      const reusingUser = Boolean(user);
      if (!user) {
        user = {
          id: messageId(), role: "user", content: text, createdAt: timestamp(now), status: "complete",
          ...(image ? { image: clone(image) } : {}),
        };
      }
      const persisted = reusingUser
        ? session
        : await store.appendMessage(identity, session.id, user);
      imagePersisted = Boolean(user.image);
      if (!current(session.id)) return;
      session = persisted;
      set({ activeSession: session, pendingImage: null, error: null });
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
        set({ activeSession: session, requestStatus: "idle", error: error?.name === "AbortError" ? null : String(error?.message || "The request failed. Try again.") });
        return;
      }
      if (!same(requestGeneration, identity, session.id)) return;
      activeRequest = null;
      if (!assistant.content) assistant.content = String(returned || "");
      assistant.status = "complete";
      await persistAssistant(identity, session.id, assistant, requestGeneration);
      if (same(requestGeneration, identity, session.id)) set({ requestStatus: "idle", error: null });
    } catch (error) {
      if (savedImage && !imagePersisted) {
        await store.releaseImageAsset(savedImage).catch(() => {});
      }
      if (current(session?.id || "")) {
        lastFailed = { text, sessionId: session?.id || "", messageId: "" };
        set({ requestStatus: "idle", error: String(error?.message || "The request failed. Try again.") });
      }
    }
  }

  function stop() {
    const identity = state.documentIdentity;
    const session = state.activeSession;
    const assistant = session?.messages?.at(-1);
    abort();
    if (!identity?.persistable || !session || assistant?.role !== "assistant" || assistant.status !== "streaming") {
      set({ requestStatus: "idle" });
      return;
    }
    const stopped = { ...assistant, status: "stopped" };
    set({ activeSession: { ...session, messages: [...session.messages.slice(0, -1), stopped] }, requestStatus: "idle", error: null });
    void persistAssistant(identity, session.id, stopped).catch((error) => {
      if (state.documentIdentity?.key === identity.key && state.activeSession?.id === session.id) {
        set({ error: String(error?.message || "Unable to save the stopped response.") });
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
    send,
    retryLastFailed,
    stop,
    renameActive,
    deleteActive,
    dispose() { abort(); void releasePending(); listeners.clear(); state = initialState(); },
    getState: () => clone(state),
  };
}
