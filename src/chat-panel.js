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
export function createChatPanel({ service, getDocumentIdentity, onInsertAssistant, onCopy } = {}) {
  if (!service || typeof getDocumentIdentity !== "function") throw new Error("Chat panel requires a chat service and document identity lookup.");
  let root = null;
  let unsubscribe = null;
  let pollTimer = null;
  let disposeResize = null;
  let endResize = null;
  let identityKey = "";
  let railCollapsed = false;

  const currentIdentity = () => getDocumentIdentity();
  const isOpen = () => Boolean(root?.parentNode);
  const showError = (error) => {
    const message = root?.querySelector?.(".ai-edit-chat-error");
    if (message) message.textContent = String(error?.message || error || "The chat action failed.");
  };
  const safely = (work) => Promise.resolve().then(work).catch(showError);

  async function ensureDocument() {
    const identity = currentIdentity();
    if (identity?.key === identityKey) return identity;
    service.stop();
    identityKey = identity?.key || "";
    await service.openDraft(identity);
    return null;
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
    error.textContent = state.error || "";
  }

  function messageById(id) {
    return service.getState().activeSession?.messages?.find((message) => message.id === id) || null;
  }

  async function handleAction(action) {
    const name = action.dataset.action;
    if (name === "close") return close();
    if (name === "rail") { railCollapsed = !railCollapsed; render(); return; }
    if (name === "stop") return service.stop();
    if (!await ensureDocument()) return;
    const identity = currentIdentity();
    if (name === "send") {
      const input = root.querySelector(".ai-edit-chat-input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      return service.send(text);
    }
    if (name === "new") return service.openDraft(identity);
    if (name === "select") return service.openSession(identity, action.dataset.sessionId);
    if (name === "rename") {
      if (action.dataset.sessionId !== service.getState().activeSession?.id) await service.openSession(identity, action.dataset.sessionId);
      const active = service.getState().activeSession;
      const title = globalThis.window?.prompt?.("Rename conversation", active?.title || "") ?? "";
      if (title.trim()) return service.renameActive(title);
      return;
    }
    if (name === "delete") {
      if (action.dataset.sessionId !== service.getState().activeSession?.id) await service.openSession(identity, action.dataset.sessionId);
      return service.deleteActive();
    }
    const message = messageById(action.dataset.messageId);
    if (!message?.content) return;
    if (name === "copy") return onCopy ? onCopy(message.content) : globalThis.navigator?.clipboard?.writeText(message.content);
    if (name === "insert") return onInsertAssistant?.(message.content);
  }

  function onClick(event) {
    const action = findAction(event.target);
    if (action) void safely(() => handleAction(action));
  }

  function onKeyDown(event) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    const input = root.querySelector(".ai-edit-chat-input");
    if (!input.value.trim()) return;
    const text = input.value;
    input.value = "";
    void safely(async () => { if (await ensureDocument()) await service.send(text); });
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
    if (isOpen()) return refreshDocument();
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
    const header = element("header", "ai-edit-chat-header", "AI conversation"); addButton(header, "rail", "History"); addButton(header, "close", "×").className = "ai-edit-dialog-close";
    main.appendChild(header); main.appendChild(element("div", "ai-edit-chat-error")); main.appendChild(element("div", "ai-edit-chat-messages"));
    const composer = element("div", "ai-edit-chat-composer");
    const input = element("textarea", "ai-edit-chat-input"); input.placeholder = "Ask a follow-up… (Ctrl+Enter to send)";
    composer.appendChild(input); addButton(composer, "stop", "Stop").className = "ai-edit-btn danger"; addButton(composer, "send", "Send").className = "ai-edit-btn primary";
    main.appendChild(composer); root.appendChild(resize); root.appendChild(rail); root.appendChild(main); document.body.appendChild(root);
    root.addEventListener("click", onClick); input.addEventListener("keydown", onKeyDown);
    disposeResize = startResize(resize);
    unsubscribe = service.subscribe(render);
    identityKey = currentIdentity()?.key || "";
    await service.openDraft(currentIdentity(), options);
    render();
    pollTimer = window.setInterval(() => { void safely(refreshDocument); }, 500);
  }

  function close() {
    if (!root) return;
    window.clearInterval(pollTimer); pollTimer = null;
    unsubscribe?.(); unsubscribe = null;
    disposeResize?.(); disposeResize = null;
    root.removeEventListener("click", onClick);
    root.querySelector(".ai-edit-chat-input")?.removeEventListener("keydown", onKeyDown);
    root.remove(); root = null;
  }

  return { open, close, isOpen, refreshDocument };
}
