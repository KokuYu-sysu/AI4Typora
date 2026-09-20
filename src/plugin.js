const { Plugin, PluginSettings, Notice } = window[Symbol.for("typora-plugin-core@v2")];

import { abortCurrentRequest, createAiRequest } from "./api.js";
import { DEFAULT_SETTINGS, mergeSettings, shortcutMatches } from "./config.js";
import { EditorSelectionController } from "./editor.js";
import { prepareImageInputForModel } from "./platform.js";
import { AiEditSettingTab } from "./settings-tab.js";
import { ensureStyles, removeStyles, showToast, openContextMenu, closeContextMenu, promptForText, createStreamDialog, closeAnyDialog } from "./ui.js";
import { protectMath, restoreMathPreview, restoreMath } from "./math-protection.js";

export function prepareContextRewrite(selectedText, promptTemplate, documentText) {
  const protectedSelection = protectMath(selectedText);
  return {
    userPrompt: String(promptTemplate)
      .replace(/\{selection\}/g, protectedSelection.protectedText)
      .replace(/\{document\}/g, String(documentText)),
    mathEntries: protectedSelection.entries,
  };
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

    let activeRequest = null;
    let rawOutput = "";
    let generating = true;
    let stopped = false;
    let closed = false;

    const stream = createStreamDialog({
      title: withContext ? "AI Optimize With Context" : "AI Optimize Selection",
      waitingText: "Waiting for AI response...",
      onStop: () => {
        if (!generating || stopped) {
          return;
        }
        stopped = true;
        activeRequest?.abort();
      },
      onClose: () => {
        closed = true;
        if (generating) {
          activeRequest?.abort();
        }
      },
    });

    try {
      const request = createAiRequest({
        systemPrompt: promptConfig.system,
        messages: [{ role: "user", content: userPrompt }],
        settings,
        onChunk: (chunk) => {
          if (closed || stopped) {
            return;
          }
          rawOutput += chunk;
          stream.setValue(
            withContext
              ? restoreMathPreview(rawOutput, contextRewrite.mathEntries)
              : rawOutput,
          );
        },
        onAttemptStart: ({ resetOutput }) => {
          if (!closed && !stopped && resetOutput) {
            rawOutput = "";
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
      if (closed || stopped) {
        return;
      }
      if (!result.trim()) {
        stream.showError("The model returned an empty response.");
        return;
      }

      let replacement = result;
      if (withContext) {
        const restored = restoreMath(result, contextRewrite.mathEntries);
        stream.setValue(restoreMathPreview(result, contextRewrite.mathEntries));
        if (!restored.ok) {
          stream.showCompleted({
            confirmText: "Replace",
            replaceAllowed: false,
            validationMessage: restored.error,
          });
          return;
        }
        replacement = restored.text;
      }

      stream.showCompleted({
        confirmText: "Replace",
        onConfirm: () => {
          const ok = this.editorSelection.restoreAndReplace(replacement);
          stream.close();
          showToast(ok ? "Selection replaced." : "Replace failed.", ok ? "success" : "error");
        },
      });
    } catch (error) {
      generating = false;
      activeRequest = null;
      if (closed) {
        return;
      }
      if (error && error.name === "AbortError") {
        stream.showCompleted({
          confirmText: "Replace",
          replaceAllowed: false,
          validationMessage: stopped
            ? "Request stopped. Partial response was not applied."
            : "Request cancelled. Partial response was not applied.",
        });
      } else {
        stream.showError(error?.message || "The request failed.");
      }
    }
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
      if (closed || stopped) {
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
      if (closed || stopped) {
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
