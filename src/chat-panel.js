import { ensureStyles } from "./ui.js";

const MIN_WIDTH = 360;
const MAX_WIDTH = 720;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function findAction(target) {
  return target?.closest?.("[data-action]") || null;
}

/** A deliberately plain-text, non-modal view of one ChatService. */
export function createChatPanel({ service, getDocumentIdentity, onInsertAssistant, onCopy, warning = "" } = {}) {
  if (!service || typeof getDocumentIdentity !== "function") throw new Error("Chat panel requires a chat service and document identity lookup.");
  let root = null;
  let unsubscribe = null;
  let pollTimer = null;
  let disposeResize = null;
  let endResize = null;
  let refreshPromise = null;
  let refreshTargetKey = "";
  let refreshGeneration = 0;
  let railCollapsed = false;

  const currentIdentity = () => getDocumentIdentity();
  const isOpen = () => Boolean(root?.parentNode);
  const showError = (error) => {
    const message = root?.querySelector?.(".ai-edit-chat-error");
    if (message) message.textContent = String(error?.message || error || "The chat action failed.");
  };
  const safely = (work) => Promise.resolve().then(work).catch(showError);

  function matchesDocument(identity) {
    return isOpen() && identity?.key === currentIdentity()?.key
      && identity?.key === service.getState().documentIdentity?.key;
  }

  function beginDraft(identity, options) {
    const targetKey = identity?.key || "";
    if (refreshPromise && refreshTargetKey === targetKey) return refreshPromise;
    const generation = ++refreshGeneration;
    refreshTargetKey = targetKey;
    if (service.getState().documentIdentity?.key) service.stop();
    refreshPromise = Promise.resolve().then(() => service.openDraft(identity, options)).then(() => (
      generation === refreshGeneration && matchesDocument(identity) ? identity : null
    )).finally(() => {
      if (generation === refreshGeneration) {
        refreshPromise = null;
        refreshTargetKey = "";
      }
    });
    return refreshPromise;
  }

  async function ensureDocument() {
    while (isOpen()) {
      const identity = currentIdentity();
      if (refreshPromise) {
        await refreshPromise;
        continue;
      }
      if (matchesDocument(identity)) return identity;
      await beginDraft(identity);
    }
    return null;
  }

  async function forCurrentDocument(work) {
    const identity = await ensureDocument();
    if (!identity || !matchesDocument(identity)) return null;
    return work(identity);
  }

  function addButton(parent, action, label, extra = {}) {
    const button = element("button", "ai-edit-btn secondary", label);
    button.type = "button";
    button.dataset.action = action;
    Object.entries(extra).forEach(([key, value]) => { button.dataset[key] = String(value); });
    parent.appendChild(button);
    return button;
  }

  function render(state = service.getState()) {
    if (!isOpen()) return;
    const rail = root.querySelector(".ai-edit-chat-rail");
    const sessions = root.querySelector(".ai-edit-chat-sessions");
    const messages = root.querySelector(".ai-edit-chat-messages");
    const input = root.querySelector(".ai-edit-chat-input");
    const error = root.querySelector(".ai-edit-chat-error");
    rail.classList?.toggle?.("collapsed", railCollapsed);
    sessions.replaceChildren();
    for (const session of state.sessions || []) {
      const row = element("div", `ai-edit-chat-session${session.id === state.activeSession?.id ? " active" : ""}`);
      row.dataset.sessionId = session.id;
      const title = element("button", "ai-edit-chat-session-title", session.title || "New chat");
      title.type = "button";
      title.dataset.action = "select";
      title.dataset.sessionId = session.id;
      row.appendChild(title);
      const controls = element("span", "ai-edit-chat-session-actions");
      addButton(controls, "rename", "Rename", { sessionId: session.id });
      addButton(controls, "delete", "Delete", { sessionId: session.id });
      row.appendChild(controls);
      sessions.appendChild(row);
    }
    messages.replaceChildren();
    for (const message of state.activeSession?.messages || []) {
      const card = element("article", `ai-edit-chat-message ${message.role} ${message.status || "complete"}`);
      card.dataset.messageId = message.id;
      card.appendChild(element("div", "ai-edit-chat-role", message.role === "assistant" ? "AI" : "You"));
      card.appendChild(element("pre", "ai-edit-chat-content", message.content || (message.status === "streaming" ? "Thinking…" : "")));
      if (message.role === "assistant" && (message.status === "complete" || message.status === "stopped")) {
        const actions = element("div", "ai-edit-chat-message-actions");
        addButton(actions, "copy", "Copy", { messageId: message.id });
        addButton(actions, "insert", "Insert", { messageId: message.id });
        card.appendChild(actions);
      }
      messages.appendChild(card);
    }
    const streaming = state.requestStatus === "streaming";
    input.disabled = streaming;
    root.querySelector("[data-action='send']").disabled = streaming;
    root.querySelector("[data-action='stop']").hidden = !streaming;
    error.textContent = [warning, state.error].filter(Boolean).join(" ");
  }

  function messageById(id) {
    return service.getState().activeSession?.messages?.find((message) => message.id === id) || null;
  }

  async function handleAction(action) {
    const name = action.dataset.action;
    if (name === "close") return close();
    if (name === "rail") { railCollapsed = !railCollapsed; render(); return; }
    if (name === "stop") return service.stop();
    if (name === "send") {
      const input = root.querySelector(".ai-edit-chat-input");
      return forCurrentDocument(async () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        await service.send(text);
      });
    }
    if (name === "new") return forCurrentDocument((identity) => beginDraft(identity));
    if (name === "select") return forCurrentDocument((identity) => service.openSession(identity, action.dataset.sessionId));
    if (name === "rename") {
      return forCurrentDocument(async (identity) => {
        if (action.dataset.sessionId !== service.getState().activeSession?.id) await service.openSession(identity, action.dataset.sessionId);
        if (!matchesDocument(identity)) return;
        const active = service.getState().activeSession;
        const title = globalThis.window?.prompt?.("Rename conversation", active?.title || "") ?? "";
        if (title.trim()) await service.renameActive(title);
      });
    }
    if (name === "delete") {
      return forCurrentDocument(async (identity) => {
        if (action.dataset.sessionId !== service.getState().activeSession?.id) await service.openSession(identity, action.dataset.sessionId);
        if (matchesDocument(identity)) await service.deleteActive();
      });
    }
    return forCurrentDocument(async () => {
      const message = messageById(action.dataset.messageId);
      if (!message?.content) return;
      if (name === "copy") return onCopy ? onCopy(message.content) : globalThis.navigator?.clipboard?.writeText(message.content);
      if (name === "insert") return onInsertAssistant?.(message.content);
    });
  }

  function onClick(event) {
    const action = findAction(event.target);
    if (action) void safely(() => handleAction(action));
  }

  function onKeyDown(event) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    void safely(() => handleAction({ dataset: { action: "send" } }));
  }

  function startResize(handle) {
    const onDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = root.getBoundingClientRect().width;
      const move = (moveEvent) => { root.style.width = `${Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - moveEvent.clientX))}px`; };
      const up = () => { document.removeEventListener("mousemove", move, true); document.removeEventListener("mouseup", up, true); };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
      endResize = up;
    };
    handle.addEventListener("mousedown", onDown);
    return () => { endResize?.(); endResize = null; handle.removeEventListener("mousedown", onDown); };
  }

  async function refreshDocument() {
    if (!isOpen()) return;
    await ensureDocument();
  }

  async function open(options = {}) {
    if (isOpen()) return beginDraft(currentIdentity(), options);
    ensureStyles();
    root = element("aside", "ai-edit-chat-panel");
    root.setAttribute("role", "complementary");
    root.setAttribute("aria-label", "AI conversation");
    const resize = element("div", "ai-edit-chat-resize");
    const rail = element("nav", "ai-edit-chat-rail");
    const railHeader = element("div", "ai-edit-chat-rail-header");
    addButton(railHeader, "new", "New"); addButton(railHeader, "rail", "Hide");
    rail.appendChild(railHeader); rail.appendChild(element("div", "ai-edit-chat-sessions"));
    const main = element("section", "ai-edit-chat-main");
    const header = element("header", "ai-edit-chat-header", "AI conversation"); addButton(header, "rail", "History");
    const closeButton = addButton(header, "close", "×"); closeButton.className = "ai-edit-dialog-close"; closeButton.setAttribute("aria-label", "Close conversation");
    main.appendChild(header); main.appendChild(element("div", "ai-edit-chat-error")); main.appendChild(element("div", "ai-edit-chat-messages"));
    const composer = element("div", "ai-edit-chat-composer");
    const input = element("textarea", "ai-edit-chat-input"); input.placeholder = "Ask a follow-up… (Ctrl+Enter to send)"; input.setAttribute("aria-label", "Conversation message");
    composer.appendChild(input); addButton(composer, "stop", "Stop").className = "ai-edit-btn danger"; addButton(composer, "send", "Send").className = "ai-edit-btn primary";
    main.appendChild(composer); root.appendChild(resize); root.appendChild(rail); root.appendChild(main); document.body.appendChild(root);
    root.addEventListener("click", onClick); input.addEventListener("keydown", onKeyDown);
    disposeResize = startResize(resize);
    unsubscribe = service.subscribe(render);
    const opening = beginDraft(currentIdentity(), options);
    const openingGeneration = refreshGeneration;
    await opening;
    if (!isOpen() || openingGeneration !== refreshGeneration) return;
    render();
    pollTimer = window.setInterval(() => { void safely(refreshDocument); }, 500);
  }

  function close() {
    if (!root) return;
    refreshGeneration += 1;
    refreshPromise = null;
    refreshTargetKey = "";
    window.clearInterval(pollTimer); pollTimer = null;
    unsubscribe?.(); unsubscribe = null;
    disposeResize?.(); disposeResize = null;
    root.removeEventListener("click", onClick);
    root.querySelector(".ai-edit-chat-input")?.removeEventListener("keydown", onKeyDown);
    root.remove(); root = null;
  }

  return { open, close, isOpen, refreshDocument };
}
