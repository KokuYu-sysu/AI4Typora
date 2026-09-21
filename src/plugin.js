const { Plugin, PluginSettings, Notice } = window[Symbol.for("typora-plugin-core@v2")];

import { createAiRequest } from "./api.js";
import { createChatPanel } from "./chat-panel.js";
import { createChatService } from "./chat-service.js";
import { createChatStore } from "./chat-store.js";
import { DEFAULT_SETTINGS, mergeSettings, shortcutMatches } from "./config.js";
import { createDiffDialog } from "./diff-dialog.js";
import { getCurrentDocumentIdentity } from "./document-identity.js";
import { EditorSelectionController } from "./editor.js";
import { getChatDataDirectory, prepareImageInputForModel } from "./platform.js";
import { AiEditSettingTab } from "./settings-tab.js";
import { ensureStyles, removeStyles, showToast, openContextMenu, closeContextMenu, promptForText, closeAnyDialog } from "./ui.js";
import { protectMath, restoreMathPreview, restoreMath } from "./math-protection.js";

let unsavedRewriteSequence = 0;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// Keeps chat usable when the host cannot provide persistent storage.
function createVolatileChatStore() {
  const documents = new Map();
  const images = new Map();
  const sessionsFor = (identity, create = false) => {
    if (!documents.has(identity.key) && create) documents.set(identity.key, []);
    return documents.get(identity.key) || [];
  };
  const find = (identity, id) => sessionsFor(identity).find((session) => session.id === id);
  return {
    async initialize() {},
    async flush() {},
    async listSessions(identity) {
      return sessionsFor(identity).map(({ messages, ...session }) => ({ ...clone(session), messageCount: messages.length })).reverse();
    },
    async getSession(identity, id) { return clone(find(identity, id) || null); },
    async createSession(identity, input) {
      const session = { ...clone(input), messages: clone(input.messages || []) };
      sessionsFor(identity, true).push(session);
      return clone(session);
    },
    async appendMessage(identity, id, message) {
      const session = find(identity, id);
      if (!session) throw new Error("Chat session not found.");
      session.messages.push(clone(message));
      session.updatedAt = message.createdAt || new Date().toISOString();
      return clone(session);
    },
    async updateMessage(identity, id, messageId, patch) {
      const session = find(identity, id);
      const message = session?.messages.find((item) => item.id === messageId);
      if (!message) throw new Error("Chat message not found.");
      Object.assign(message, clone(patch));
      return clone(session);
    },
    async renameSession(identity, id, title) { const session = find(identity, id); if (session) session.title = title; },
    async deleteSession(identity, id) {
      const sessions = sessionsFor(identity);
      const index = sessions.findIndex((session) => session.id === id);
      if (index >= 0) sessions.splice(index, 1);
    },
    async clearDocument(identity) { documents.delete(identity.key); },
    async clearAll() { documents.clear(); images.clear(); },
    async saveImageAsset(source) {
      const assetId = `volatile_${images.size + 1}`;
      images.set(assetId, prepareImageInputForModel(source));
      return { assetId, originalSource: String(source), mimeType: "image/png", storedPath: "", fallbackUrl: "" };
    },
    async resolveImageAsset(image) {
      const value = images.get(image?.assetId);
      if (!value) throw new Error("Temporary image data is unavailable.");
      return value;
    },
    async releaseImageAsset(image) { images.delete(image?.assetId); },
  };
}

export function prepareContextRewrite(selectedText, promptTemplate, documentText) {
  const protectedSelection = protectMath(selectedText);
  return {
    userPrompt: String(promptTemplate)
      .replace(/\{selection\}/g, protectedSelection.protectedText)
      .replace(/\{document\}/g, String(documentText)),
    mathEntries: protectedSelection.entries,
  };
}

function snapshotValidationMessage(reason) {
  if (reason === "document-changed") {
    return "The active document changed. Replace is disabled.";
  }
  if (reason === "selection-changed") {
    return "The original selection changed. Replace is disabled.";
  }
  if (reason === "range-detached") {
    return "The original selection is no longer available. Replace is disabled.";
  }
  if (reason === "document-unsaved") {
    return "Please save the document before replacing the selection.";
  }
  return "The original selection could not be verified. Replace is disabled.";
}

export async function runRewriteAttempt({
  input,
  settings,
  dialog,
  createRequest = createAiRequest,
  previousRequest = null,
  onRequest,
  isCurrent = () => true,
  validateReplacement = () => ({ ok: true }),
}) {
  previousRequest?.abort();
  dialog.beginGeneration();
  let rawOutput = "";
  let request;

  try {
    request = createRequest({
      systemPrompt: input.systemPrompt,
      messages: [{ role: "user", content: input.userPrompt }],
      settings,
      onChunk: (chunk) => {
        if (!isCurrent()) return;
        rawOutput += chunk;
        dialog.setStreamingText(restoreMathPreview(rawOutput, input.mathEntries));
      },
      onAttemptStart: ({ resetOutput }) => {
        if (!isCurrent() || !resetOutput) return;
        rawOutput = "";
        dialog.setStreamingText("");
      },
    });
    onRequest?.(request);
    const result = await request.promise;
    if (!isCurrent()) {
      return {
        status: "stopped",
        candidateText: restoreMathPreview(rawOutput, input.mathEntries),
        replaceAllowed: false,
      };
    }
    if (!String(result).trim()) {
      dialog.fail("The model returned an empty response.");
      return { status: "failed", candidateText: "", replaceAllowed: false };
    }

    const restored = input.mathEntries.length
      ? restoreMath(result, input.mathEntries)
      : { ok: true, text: result };
    const candidateText = restored.ok
      ? restored.text
      : restoreMathPreview(result, input.mathEntries);
    const validation = restored.ok ? validateReplacement() : { ok: false };
    const replaceAllowed = restored.ok && validation.ok;
    const validationMessage = restored.ok
      ? (validation.ok ? "" : snapshotValidationMessage(validation.reason))
      : restored.error;
    dialog.complete({ candidateText, replaceAllowed, validationMessage });
    return { status: "complete", candidateText, replaceAllowed };
  } catch (error) {
    if (!isCurrent() || error?.name === "AbortError") {
      return {
        status: "stopped",
        candidateText: restoreMathPreview(rawOutput, input.mathEntries),
        replaceAllowed: false,
      };
    }
    dialog.fail(error?.message || "The request failed.");
    return {
      status: "failed",
      candidateText: restoreMathPreview(rawOutput, input.mathEntries),
      replaceAllowed: false,
    };
  }
}

function matchesFixedShortcut(event, shortcut) {
  if (!event || !event.key) {
    return false;
  }

  return (
    String(event.key).toLowerCase() === String(shortcut.key || "").toLowerCase()
    && !!event.ctrlKey === !!shortcut.ctrlKey
    && !!event.shiftKey === !!shortcut.shiftKey
    && !!event.altKey === !!shortcut.altKey
    && !!event.metaKey === !!shortcut.metaKey
  );
}

export default class AiEditPlugin extends Plugin {
  constructor() {
    super(...arguments);
    this.editorSelection = new EditorSelectionController();
    this.chatRuntime = {
      createStore: createChatStore,
      createService: createChatService,
      createPanel: createChatPanel,
      createRequest: createAiRequest,
      getDataDirectory: getChatDataDirectory,
      getDocumentIdentity: getCurrentDocumentIdentity,
    };
    this.chatStore = null;
    this.chatService = null;
    this.chatPanel = null;
    this.bypassNextContextMenu = false;
    this.handleContextMenu = this.handleContextMenu.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  async onload() {
    this.registerSettings(
      new PluginSettings(this.app, this.manifest, { version: 1 }),
    );
    this.settings.setDefault(DEFAULT_SETTINGS);
    this.registerSettingTab(new AiEditSettingTab(this));
    ensureStyles();
    let warning = "";
    try {
      this.chatStore = this.chatRuntime.createStore({ baseDir: this.chatRuntime.getDataDirectory() });
      await this.chatStore.initialize();
    } catch (error) {
      warning = `Chat history is unavailable and will not persist: ${error?.message || error}`;
      this.chatStore = createVolatileChatStore();
      await this.chatStore.initialize();
      showToast(warning, "error");
    }
    this.chatService = this.chatRuntime.createService({
      store: this.chatStore,
      resolveSettings: () => this.getSettings(),
      createRequest: (request) => this.chatRuntime.createRequest({
        ...request,
        settings: request.settings || this.getSettings(),
      }),
    });
    this.chatPanel = this.chatRuntime.createPanel({
      service: this.chatService,
      getDocumentIdentity: () => this.chatRuntime.getDocumentIdentity(),
      warning,
      onCopy: async (text) => {
        const copied = await this.copyTextToClipboard(text);
        showToast(copied ? "Copied to clipboard." : "Copy failed. Please copy manually.", copied ? "success" : "error");
        return copied;
      },
      onInsertAssistant: (text) => {
        const result = this.editorSelection.insertMarkdownAtLastCaret(text);
        if (result.ok) {
          showToast("Inserted at the last editor caret.", "success");
        } else {
          const reasons = {
            "document-unsaved": "Save the document before inserting.",
            "document-changed": "The document changed. Place the caret again and retry.",
            "no-caret": "Place the caret in the editor and retry.",
            "no-valid-caret": "The saved caret is no longer available. Place it again and retry.",
          };
          showToast(reasons[result.reason] || "Could not insert the response. Place the caret and retry.", "error");
        }
        return result;
      },
    });
    this.editorSelection.startCaretTracking(() => this.chatRuntime.getDocumentIdentity());
    document.addEventListener("contextmenu", this.handleContextMenu, true);
    document.addEventListener("keydown", this.handleKeyDown, true);
    new Notice("AI Edit loaded. Shortcuts: Ctrl+E (Q&A), Ctrl+R (optimize), Ctrl+Shift+R (optimize with context).");
  }

  onunload() {
    document.removeEventListener("contextmenu", this.handleContextMenu, true);
    document.removeEventListener("keydown", this.handleKeyDown, true);
    this.chatService?.stop();
    this.chatPanel?.close();
    this.editorSelection.stopCaretTracking();
    closeContextMenu();
    closeAnyDialog();
    removeStyles();
    const disposing = this.chatService?.dispose?.();
    return Promise.resolve(disposing)
      .then(() => this.chatStore?.flush?.())
      .catch(() => {});
  }

  getCurrentDocumentIdentity() {
    return this.chatRuntime.getDocumentIdentity();
  }

  async resetOpenChatPanel() {
    if (this.chatPanel?.isOpen?.()) {
      await this.chatPanel.open({ mode: "text" });
    }
  }

  async clearCurrentFileChatHistory(identity = this.getCurrentDocumentIdentity()) {
    if (!identity?.persistable) {
      throw new Error("Save the Markdown document before clearing its chat history.");
    }
    await this.chatService?.stop?.();
    await this.chatStore?.clearDocument(identity);
    await this.resetOpenChatPanel();
  }

  async clearAllChatHistory() {
    await this.chatService?.stop?.();
    await this.chatStore?.clearAll();
    await this.resetOpenChatPanel();
  }

  getSettings() {
    return mergeSettings({
      provider: this.settings.get("provider"),
      model: this.settings.get("model"),
      oauthTokenPath: this.settings.get("oauthTokenPath"),
      oauthUserInfoPath: this.settings.get("oauthUserInfoPath"),
      promptExportPath: this.settings.get("promptExportPath"),
      openaiCompatFailoverEnabled: this.settings.get("openaiCompatFailoverEnabled"),
      openaiCompatPreferredConnection: this.settings.get("openaiCompatPreferredConnection"),
      openaiCompatBackups: this.settings.get("openaiCompatBackups"),
      openaiCompat: this.settings.get("openaiCompat"),
      shortcut: this.settings.get("shortcut"),
      prompts: this.settings.get("prompts"),
    });
  }

  saveSettings(patch) {
    const next = mergeSettings({ ...this.getSettings(), ...patch });
    this.settings.set("provider", next.provider);
    this.settings.set("model", next.model);
    this.settings.set("oauthTokenPath", next.oauthTokenPath);
    this.settings.set("oauthUserInfoPath", next.oauthUserInfoPath);
    this.settings.set("promptExportPath", next.promptExportPath);
    this.settings.set("openaiCompatFailoverEnabled", next.openaiCompatFailoverEnabled);
    this.settings.set("openaiCompatPreferredConnection", next.openaiCompatPreferredConnection);
    this.settings.set("openaiCompatBackups", next.openaiCompatBackups);
    this.settings.set("openaiCompat", next.openaiCompat);
    this.settings.set("shortcut", next.shortcut);
    this.settings.set("prompts", next.prompts);
  }

  handleContextMenu(event) {
    if (this.bypassNextContextMenu) {
      this.bypassNextContextMenu = false;
      return;
    }

    if (!this.editorSelection.isEditorTarget(event.target)) {
      return;
    }

    const imageElement = this.editorSelection.getImageElementFromTarget(event.target);
    if (imageElement) {
      const nativeMenuEvent = {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: !!event.ctrlKey,
        shiftKey: !!event.shiftKey,
        altKey: !!event.altKey,
        metaKey: !!event.metaKey,
      };
      this.editorSelection.captureInsertionTargetFromNode(imageElement);
      event.preventDefault();
      event.stopImmediatePropagation();
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            label: "AI Ask About Image",
            description: "Ask questions about this image and auto-paste the copied answer at cursor.",
            value: "image_qa",
          },
          {
            label: "Open Typora Menu",
            description: "Show Typora's original context menu for this image.",
            value: "native_menu",
          },
        ],
        onSelect: (value) => {
          if (value === "image_qa") {
            this.openImageQaFlow(imageElement);
          }
          if (value === "native_menu") {
            this.openNativeContextMenu(nativeMenuEvent, imageElement);
          }
        },
      });
      return;
    }

    const selection = this.editorSelection.getSelectedText().trim();
    if (!selection) {
      return;
    }

    this.editorSelection.captureSelection();
    event.preventDefault();
    event.stopImmediatePropagation();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: "AI Optimize (Selection Only)",
          description: "Only improve the selected text itself.",
          value: "optimize",
        },
        {
          label: "AI Optimize (Use Full Document Context)",
          description: "Improve selection with full-document consistency.",
          value: "optimize_with_context",
        },
        {
          label: "AI Q&A",
          description: "Ask a writing question and auto-paste the copied answer at cursor.",
          value: "qa",
        },
      ],
      onSelect: (value) => {
        if (value === "optimize") {
          this.openOptimizeFlow(false);
        }
        if (value === "optimize_with_context") {
          this.openOptimizeFlow(true);
        }
        if (value === "qa") {
          this.editorSelection.captureInsertionTarget();
          this.openQaFlow();
        }
      },
    });
  }

  handleKeyDown(event) {
    if (!this.editorSelection.isEditorTarget(event.target)) {
      return;
    }
    const settings = this.getSettings();

    if (shortcutMatches(event, settings.shortcut)) {
      event.preventDefault();
      event.stopPropagation();
      this.editorSelection.captureInsertionTarget();
      this.openQaFlow();
      return;
    }

    if (matchesFixedShortcut(event, { key: "r", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })) {
      event.preventDefault();
      event.stopPropagation();
      this.editorSelection.captureSelection();
      this.openOptimizeFlow(false);
      return;
    }

    if (matchesFixedShortcut(event, { key: "r", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })) {
      event.preventDefault();
      event.stopPropagation();
      this.editorSelection.captureSelection();
      this.openOptimizeFlow(true);
    }
  }

  openNativeContextMenu(eventInfo, targetNode) {
    if (!eventInfo || !Number.isFinite(eventInfo.clientX) || !Number.isFinite(eventInfo.clientY)) {
      return;
    }
    const fallbackTarget = document.elementFromPoint(eventInfo.clientX, eventInfo.clientY);
    const target = targetNode || fallbackTarget;
    if (!target) {
      return;
    }

    this.bypassNextContextMenu = true;
    const nativeEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      buttons: 2,
      clientX: eventInfo.clientX,
      clientY: eventInfo.clientY,
      screenX: eventInfo.screenX,
      screenY: eventInfo.screenY,
      ctrlKey: !!eventInfo.ctrlKey,
      shiftKey: !!eventInfo.shiftKey,
      altKey: !!eventInfo.altKey,
      metaKey: !!eventInfo.metaKey,
    });
    target.dispatchEvent(nativeEvent);
    window.setTimeout(() => {
      this.bypassNextContextMenu = false;
    }, 0);
  }

  copyTextFallback(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "readonly");
      area.style.position = "fixed";
      area.style.left = "-10000px";
      area.style.top = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  async copyTextToClipboard(text) {
    const content = String(text || "");
    if (!content.trim()) {
      return false;
    }

    try {
      if (window.reqnode) {
        const electron = window.reqnode("electron");
        if (electron && electron.clipboard && typeof electron.clipboard.writeText === "function") {
          electron.clipboard.writeText(content);
          return true;
        }
      }
    } catch (_) {}

    try {
      if (typeof require === "function") {
        const electron = require("electron");
        if (electron && electron.clipboard && typeof electron.clipboard.writeText === "function") {
          electron.clipboard.writeText(content);
          return true;
        }
      }
    } catch (_) {}

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(content);
        return true;
      }
    } catch (_) {}
    return this.copyTextFallback(content);
  }

  async openOptimizeFlow(withContext) {
    const selectedText = this.editorSelection.getSavedText() || this.editorSelection.getSelectedText();
    if (!selectedText.trim()) {
      showToast("Please select text first.", "error");
      return;
    }

    const identity = getCurrentDocumentIdentity();
    const documentId = identity.persistable
      ? identity.key
      : `unsaved-rewrite-${++unsavedRewriteSequence}`;
    const snapshot = this.editorSelection.captureSelectionSnapshot(documentId);
    if (!snapshot || snapshot.text !== selectedText) {
      showToast("The selected text could not be captured safely. Please select it again.", "error");
      return;
    }

    const settings = this.getSettings();
    const promptKey = withContext ? "optimize_with_context" : "optimize";
    const promptConfig = settings.prompts[promptKey];
    const documentText = withContext ? this.editorSelection.getDocumentText() : "";

    const extraPrompt = await promptForText({
      title: withContext ? "AI Optimize With Context" : "AI Optimize Selection",
      label: "Additional instructions (optional)",
      placeholder: "For example: make the tone more formal; shorten it to 120 words.",
      confirmText: "Start",
    });
    if (extraPrompt === null) {
      return;
    }

    const contextRewrite = withContext
      ? prepareContextRewrite(selectedText, promptConfig.user, documentText)
      : { userPrompt: promptConfig.user.replace(/\{selection\}/g, selectedText), mathEntries: [] };
    let userPrompt = contextRewrite.userPrompt;

    if (extraPrompt) {
      userPrompt = `${extraPrompt}\n\n${userPrompt}`;
    }

    const input = Object.freeze({
      documentId,
      snapshot,
      selectedText,
      documentText,
      extraPrompt,
      promptKey,
      systemPrompt: String(promptConfig.system),
      userPrompt,
      documentPersistable: identity.persistable,
      mathEntries: Object.freeze(contextRewrite.mathEntries.map((entry) => Object.freeze({ ...entry }))),
    });
    let activeRequest = null;
    let generation = 0;
    let closed = false;

    let dialog;
    const validateTarget = () => {
      const currentIdentity = getCurrentDocumentIdentity();
      if (!input.documentPersistable || !currentIdentity.persistable) {
        return { ok: false, reason: "document-unsaved" };
      }
      return this.editorSelection.validateSelectionSnapshot(input.snapshot, currentIdentity.key);
    };
    const attempt = () => {
      const attemptGeneration = ++generation;
      const previousRequest = activeRequest;
      return runRewriteAttempt({
        input,
        settings,
        dialog,
        previousRequest,
        onRequest: (request) => {
          if (closed || generation !== attemptGeneration) {
            request.abort();
            return;
          }
          activeRequest = request;
        },
        isCurrent: () => !closed && generation === attemptGeneration,
        validateReplacement: validateTarget,
      }).finally(() => {
        if (generation === attemptGeneration) activeRequest = null;
      });
    };

    dialog = createDiffDialog({
      title: withContext ? "AI Optimize With Context" : "AI Optimize Selection",
      originalText: selectedText,
      diffOptions: {
        atomicValues: input.mathEntries.map((entry) => entry.source),
      },
      onStop: () => {
        generation += 1;
        activeRequest?.abort();
        activeRequest = null;
      },
      onRegenerate: () => {
        void attempt();
      },
      onReplace: (candidateText) => {
        const validation = validateTarget();
        const result = validation.ok
          ? this.editorSelection.replaceSelectionSnapshot(
            input.snapshot,
            candidateText,
            getCurrentDocumentIdentity().key,
          )
          : validation;
        if (!result.ok) {
          dialog.complete({
            candidateText,
            replaceAllowed: false,
            validationMessage: snapshotValidationMessage(result.reason),
          });
          return;
        }
        dialog.close("replace");
        showToast("Selection replaced.", "success");
      },
      onClose: () => {
        closed = true;
        generation += 1;
        activeRequest?.abort();
        activeRequest = null;
      },
    });
    return attempt();
  }

  async openQaFlow() {
    return this.chatPanel?.open({ mode: "text" });
  }

  async openImageQaFlow(imageElement) {
    const imageSource = String(
      imageElement?.currentSrc
      || imageElement?.src
      || imageElement?.getAttribute?.("src")
      || ""
    ).trim();
    if (!imageSource) {
      showToast("Cannot read image source from the selected image.", "error");
      return;
    }
    return this.chatPanel?.open({ mode: "image", pendingImage: { source: imageSource } });
  }
}
