const { Plugin, PluginSettings, Notice } = window[Symbol.for("typora-plugin-core@v2")];

import { abortCurrentRequest, createAiRequest } from "./api.js";
import { DEFAULT_SETTINGS, mergeSettings, shortcutMatches } from "./config.js";
import { createDiffDialog } from "./diff-dialog.js";
import { getCurrentDocumentIdentity } from "./document-identity.js";
import { EditorSelectionController } from "./editor.js";
import { prepareImageInputForModel } from "./platform.js";
import { AiEditSettingTab } from "./settings-tab.js";
import { ensureStyles, removeStyles, showToast, openContextMenu, closeContextMenu, promptForText, createStreamDialog, closeAnyDialog } from "./ui.js";
import { protectMath, restoreMathPreview, restoreMath } from "./math-protection.js";

let unsavedRewriteSequence = 0;

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
    document.addEventListener("contextmenu", this.handleContextMenu, true);
    document.addEventListener("keydown", this.handleKeyDown, true);
    new Notice("AI Edit loaded. Shortcuts: Ctrl+E (Q&A), Ctrl+R (optimize), Ctrl+Shift+R (optimize with context).");
  }

  onunload() {
    document.removeEventListener("contextmenu", this.handleContextMenu, true);
    document.removeEventListener("keydown", this.handleKeyDown, true);
    abortCurrentRequest();
    closeContextMenu();
    closeAnyDialog();
    removeStyles();
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

  scheduleRestoreCaret() {
    window.setTimeout(() => {
      this.editorSelection.restoreInsertionCaret();
    }, 40);
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

  async copyResponseAndAutoPaste(stream, value) {
    const content = String(value || "").trim();
    if (!content) {
      stream.close("confirm");
      showToast("Nothing to copy.", "error");
      return;
    }

    const copied = await this.copyTextToClipboard(content);
    stream.close("confirm");
    window.setTimeout(async () => {
      const pasted = await this.editorSelection.autoPasteResponse(content);
      if (pasted) {
        showToast("Copied and auto-pasted at cursor.", "success");
        return;
      }

      showToast(
        copied ? "Copied. Auto paste blocked, please press Ctrl+V." : "Copy failed. Please copy manually.",
        copied ? "info" : "error",
      );
    }, 60);
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
    const question = await promptForText({
      title: "AI Q&A",
      label: "Enter your question",
      placeholder: "For example: suggest a stronger transition sentence for the current section.",
      confirmText: "Start",
    });
    if (!question) {
      return;
    }

    const includeContext = await promptForText({
      title: "AI Q&A",
      label: "Type YES to include the full document as context, or leave blank to answer without it.",
      placeholder: "YES",
      confirmText: "Continue",
    });
    if (includeContext === null) {
      return;
    }

    const settings = this.getSettings();
    const withContext = String(includeContext || "").trim().toLowerCase() === "yes";
    const promptKey = withContext ? "qa_with_context" : "qa";
    const promptConfig = settings.prompts[promptKey];
    const userPrompt = promptConfig.user
      .replace(/\{question\}/g, question)
      .replace(/\{document\}/g, withContext ? this.editorSelection.getDocumentText() : "");

    let activeRequest = null;
    let generating = true;
    let stopped = false;
    let stoppedCompleted = false;
    let closed = false;

    const stream = createStreamDialog({
      title: "AI Q&A",
      waitingText: "Waiting for AI response...",
      onStop: () => {
        if (!generating || stopped) {
          return;
        }
        stopped = true;
        activeRequest?.abort();
      },
      onClose: (meta) => {
        closed = true;
        if (generating) {
          activeRequest?.abort();
        }
        if (meta?.reason !== "confirm") {
          this.scheduleRestoreCaret();
        }
      },
    });

    function showStoppedCompletion() {
      if (stoppedCompleted) {
        return;
      }
      stoppedCompleted = true;
      stream.showCompleted({
        replaceAllowed: false,
        validationMessage: "Request stopped. Partial response is available to copy.",
      });
    }

    try {
      const request = createAiRequest({
        systemPrompt: promptConfig.system,
        messages: [{ role: "user", content: userPrompt }],
        settings,
        onChunk: (chunk) => {
          if (!closed && !stopped) {
            stream.append(chunk);
          }
        },
        onAttemptStart: ({ resetOutput }) => {
          if (!closed && !stopped && resetOutput) {
            stream.setValue("");
          }
        },
      });
      activeRequest = request;
      const result = await request.promise;
      if (activeRequest === request) {
        activeRequest = null;
      }
      generating = false;
      if (closed) {
        return;
      }
      if (stopped) {
        showStoppedCompletion();
        return;
      }
      if (!result.trim()) {
        stream.showError("The model returned an empty response.");
        return;
      }
      stream.showCompleted({
        confirmText: "Copy & Auto Paste",
        onConfirm: async (value) => {
          await this.copyResponseAndAutoPaste(stream, value);
        },
      });
    } catch (error) {
      activeRequest = null;
      generating = false;
      if (closed) {
        return;
      }
      if (error && error.name === "AbortError") {
        if (stopped) {
          showStoppedCompletion();
          return;
        }
        stream.showCompleted({
          confirmText: "Copy & Auto Paste",
          onConfirm: async (value) => {
            await this.copyResponseAndAutoPaste(stream, value);
          },
        });
      } else {
        stream.showError(error?.message || "The request failed.");
      }
    }
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

    const question = await promptForText({
      title: "AI Image Q&A",
      label: "Ask a question about this image",
      placeholder: "For example: explain the key findings shown in this figure.",
      confirmText: "Start",
    });
    if (!question) {
      return;
    }

    let imageInput;
    try {
      imageInput = prepareImageInputForModel(imageSource);
    } catch (error) {
      showToast(error?.message || "Image preprocessing failed.", "error");
      return;
    }

    const settings = this.getSettings();
    const promptConfig = settings.prompts.image_qa || {
      system: "You are an image interpretation assistant.",
      user: "Answer based on the image.\n\nQuestion: {question}",
    };
    const userPrompt = promptConfig.user.replace(/\{question\}/g, question);

    let activeRequest = null;
    let generating = true;
    let stopped = false;
    let stoppedCompleted = false;
    let closed = false;

    const stream = createStreamDialog({
      title: "AI Image Q&A",
      waitingText: "Waiting for AI response...",
      onStop: () => {
        if (!generating || stopped) {
          return;
        }
        stopped = true;
        activeRequest?.abort();
      },
      onClose: (meta) => {
        closed = true;
        if (generating) {
          activeRequest?.abort();
        }
        if (meta?.reason !== "confirm") {
          this.scheduleRestoreCaret();
        }
      },
    });

    function showStoppedCompletion() {
      if (stoppedCompleted) {
        return;
      }
      stoppedCompleted = true;
      stream.showCompleted({
        replaceAllowed: false,
        validationMessage: "Request stopped. Partial response is available to copy.",
      });
    }

    try {
      const request = createAiRequest({
        systemPrompt: promptConfig.system,
        messages: [{ role: "user", content: userPrompt, imageInput }],
        settings,
        onChunk: (chunk) => {
          if (!closed && !stopped) {
            stream.append(chunk);
          }
        },
        onAttemptStart: ({ resetOutput }) => {
          if (!closed && !stopped && resetOutput) {
            stream.setValue("");
          }
        },
      });
      activeRequest = request;
      const result = await request.promise;
      if (activeRequest === request) {
        activeRequest = null;
      }
      generating = false;
      if (closed) {
        return;
      }
      if (stopped) {
        showStoppedCompletion();
        return;
      }
      if (!result.trim()) {
        stream.showError("The model returned an empty response.");
        return;
      }
      stream.showCompleted({
        confirmText: "Copy & Auto Paste",
        onConfirm: async (value) => {
          await this.copyResponseAndAutoPaste(stream, value);
        },
      });
    } catch (error) {
      activeRequest = null;
      generating = false;
      if (closed) {
        return;
      }
      if (error && error.name === "AbortError") {
        if (stopped) {
          showStoppedCompletion();
          return;
        }
        stream.showCompleted({
          confirmText: "Copy & Auto Paste",
          onConfirm: async (value) => {
            await this.copyResponseAndAutoPaste(stream, value);
          },
        });
      } else {
        stream.showError(error?.message || "The request failed.");
      }
    }
  }
}
