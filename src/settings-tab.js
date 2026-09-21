const { SettingTab, Notice } = window[Symbol.for("typora-plugin-core@v2")];

import {
  CHATGPT_MODEL_PRESETS,
  OPENAI_COMPAT_MODEL_PRESETS,
  formatShortcut,
} from "./config.js";
import {
  downloadOAuthUserInfo,
  exportPromptSettingsToFile,
  getOAuthStatus,
  importPromptSettingsFromFile,
  loginOpenAiOauthInteractive,
} from "./platform.js";
import { confirmAction } from "./ui.js";

const CUSTOM_MODEL_VALUE = "__custom__";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getModelUiState(value, presets) {
  const normalized = String(value || "").trim();
  if (normalized && presets.includes(normalized)) {
    return { preset: normalized, custom: "" };
  }
  return {
    preset: CUSTOM_MODEL_VALUE,
    custom: normalized,
  };
}

function createModelOptions(presets, selectedValue) {
  const options = presets.map((preset) => {
    const selected = selectedValue === preset ? "selected" : "";
    return `<option value="${escapeHtml(preset)}" ${selected}>${escapeHtml(preset)}</option>`;
  });
  options.push(`<option value="${CUSTOM_MODEL_VALUE}" ${selectedValue === CUSTOM_MODEL_VALUE ? "selected" : ""}>Custom...</option>`);
  return options.join("");
}

function toggleCustomModelInput(container, selectId, inputId) {
  const select = container.querySelector(`#${selectId}`);
  const input = container.querySelector(`#${inputId}`);
  if (!select || !input) {
    return;
  }
  input.style.display = select.value === CUSTOM_MODEL_VALUE ? "block" : "none";
}

function readModelValue(container, selectId, inputId) {
  const presetValue = container.querySelector(`#${selectId}`)?.value || "";
  if (presetValue === CUSTOM_MODEL_VALUE) {
    return container.querySelector(`#${inputId}`)?.value.trim() || "";
  }
  return presetValue.trim();
}

export function bindChatHistoryControls(container, plugin, {
  confirm = confirmAction,
  notify = (message) => new Notice(message),
} = {}) {
  const current = container.querySelector("#ai-edit-clear-current-history");
  const all = container.querySelector("#ai-edit-clear-all-history");
  if (!current || !all) return;
  current.disabled = !plugin.getCurrentDocumentIdentity?.()?.persistable;

  current.addEventListener("click", async () => {
    const identity = plugin.getCurrentDocumentIdentity?.();
    if (!identity?.persistable) return;
    if (!await confirm({
      title: "Clear current file history?",
      message: "This permanently deletes all AI conversations for the current file.",
      confirmText: "Clear history",
    })) return;
    try {
      await plugin.clearCurrentFileChatHistory(identity);
      notify("Current file chat history cleared.");
    } catch (error) {
      notify(`Could not clear current file history: ${error?.message || "Unknown error"}`);
    }
  });

  all.addEventListener("click", async () => {
    if (!await confirm({
      title: "Clear all chat history?",
      message: "This permanently deletes AI conversations for every file.",
      confirmText: "Clear all history",
    })) return;
    try {
      await plugin.clearAllChatHistory();
      notify("All chat history cleared.");
    } catch (error) {
      notify(`Could not clear all chat history: ${error?.message || "Unknown error"}`);
    }
  });
}

export class AiEditSettingTab extends SettingTab {
  constructor(plugin) {
    super();
    this.plugin = plugin;
  }

  get name() {
    return "AI Edit";
  }

  onload() {
    this.render();
  }

  render() {
    const settings = this.plugin.getSettings();
    const documentIdentity = this.plugin.getCurrentDocumentIdentity?.();
    const status = getOAuthStatus(settings);
    const chatgptModel = getModelUiState(settings.model, CHATGPT_MODEL_PRESETS);
    const compatModel = getModelUiState(settings.openaiCompat.model, OPENAI_COMPAT_MODEL_PRESETS);
    const container = this.containerEl || this.contentEl || this.tabContentEl;
    if (container.empty) {
      container.empty();
    } else {
      container.innerHTML = "";
    }

    container.innerHTML = `
      <h2>AI Edit</h2>
      <p class="ai-edit-setting-note">Shortcuts: Q&amp;A ${escapeHtml(formatShortcut(settings.shortcut))}, Optimize Selection Ctrl+R, Optimize With Context Ctrl+Shift+R, Result Confirm Ctrl+Enter, Result Copy+Close Ctrl+C.</p>
      <div class="ai-edit-setting-grid">
        <div>
          <label for="ai-edit-provider">Provider</label>
          <select id="ai-edit-provider">
            <option value="chatgpt" ${settings.provider === "chatgpt" ? "selected" : ""}>ChatGPT OAuth Login</option>
            <option value="openai_compat" ${settings.provider === "openai_compat" ? "selected" : ""}>OpenAI Compatible</option>
          </select>
        </div>
        <div>
          <label for="ai-edit-model-preset">ChatGPT Model</label>
          <select id="ai-edit-model-preset">
            ${createModelOptions(CHATGPT_MODEL_PRESETS, chatgptModel.preset)}
          </select>
          <input id="ai-edit-model-custom" type="text" placeholder="Type model id" value="${escapeHtml(chatgptModel.custom)}" style="margin-top: 6px; ${chatgptModel.preset === CUSTOM_MODEL_VALUE ? "" : "display: none;"}" />
        </div>
        <div>
          <label for="ai-edit-oauth-path">OAuth Token File Path</label>
          <input id="ai-edit-oauth-path" type="text" value="${escapeHtml(settings.oauthTokenPath || "")}" />
          <label for="ai-edit-oauth-user-path" style="margin-top: 6px;">OAuth User Info Path</label>
          <input id="ai-edit-oauth-user-path" type="text" value="${escapeHtml(settings.oauthUserInfoPath || "")}" />
          <div class="ai-edit-setting-note">Auto-detect order: %APPDATA%/oauth-cli-kit/auth/codex.json, %LOCALAPPDATA%/oauth-cli-kit/auth/codex.json, %USERPROFILE%/.codex/auth.json</div>
          <div class="ai-edit-setting-note">OAuth Login runs an OpenAI PKCE flow (oauth-cli-kit compatible).</div>
          <div class="ai-edit-setting-status ${status.ok ? "ok" : "bad"}">${escapeHtml(status.ok ? `Connected (${status.sourcePath})` : status.message)}</div>
          <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="ai-edit-btn secondary" id="ai-edit-oauth-login">OAuth Login</button>
            <button class="ai-edit-btn secondary" id="ai-edit-oauth-download">Download User Info</button>
            <button class="ai-edit-btn secondary" id="ai-edit-oauth-refresh">Refresh OAuth Status</button>
          </div>
        </div>
        <div>
          <label for="ai-edit-prompt-export-path">Setting JSON File with Prompts Path</label>
          <input id="ai-edit-prompt-export-path" type="text" value="${escapeHtml(settings.promptExportPath || "")}" />
          <div class="ai-edit-setting-note">Export or import Prompts JSON.</div>
          <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="ai-edit-btn secondary" id="ai-edit-export-prompts">Output Setting</button>
            <button class="ai-edit-btn secondary" id="ai-edit-import-prompts">Import Setting</button>
          </div>
        </div>
        <div>
          <label for="ai-edit-compat-url">OpenAI Compatible Base URL</label>
          <input id="ai-edit-compat-url" type="text" value="${escapeHtml(settings.openaiCompat.baseUrl || "")}" />
        </div>
        <div>
          <label for="ai-edit-compat-key">OpenAI Compatible API Key</label>
          <input id="ai-edit-compat-key" type="password" value="${escapeHtml(settings.openaiCompat.apiKey || "")}" />
        </div>
        <div>
          <label for="ai-edit-compat-model-preset">OpenAI Compatible Model</label>
          <select id="ai-edit-compat-model-preset">
            ${createModelOptions(OPENAI_COMPAT_MODEL_PRESETS, compatModel.preset)}
          </select>
          <input id="ai-edit-compat-model-custom" type="text" placeholder="Type model id" value="${escapeHtml(compatModel.custom)}" style="margin-top: 6px; ${compatModel.preset === CUSTOM_MODEL_VALUE ? "" : "display: none;"}" />
        </div>
        <div class="ai-edit-setting-card">
          <div class="ai-edit-setting-card-title">OpenAI Compatible Failover</div>
          <div class="ai-edit-toggle-row">
            <div class="ai-edit-toggle-row-text">Enable automatic fallback to backup API connections</div>
            <label class="ai-edit-toggle-control" for="ai-edit-compat-failover-enabled">
              <input id="ai-edit-compat-failover-enabled" type="checkbox" ${settings.openaiCompatFailoverEnabled ? "checked" : ""} />
              Enabled
            </label>
          </div>
          <div style="margin-top: 8px;">
            <label for="ai-edit-compat-preferred-connection">Active OpenAI-Compatible Connection</label>
            <select id="ai-edit-compat-preferred-connection">
              <option value="primary" ${settings.openaiCompatPreferredConnection === "primary" ? "selected" : ""}>Primary API</option>
              <option value="backup_1" ${settings.openaiCompatPreferredConnection === "backup_1" ? "selected" : ""}>Backup API 1</option>
              <option value="backup_2" ${settings.openaiCompatPreferredConnection === "backup_2" ? "selected" : ""}>Backup API 2</option>
            </select>
            <div class="ai-edit-setting-card-note">Set this to Backup API 1/2 to directly use other AI models during normal use.</div>
          </div>
          <div class="ai-edit-setting-subgrid">
            <div>
              <label for="ai-edit-compat-backup1-url">Backup API 1 Base URL</label>
              <input id="ai-edit-compat-backup1-url" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[0]?.baseUrl || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup1-key">Backup API 1 API Key</label>
              <input id="ai-edit-compat-backup1-key" type="password" value="${escapeHtml(settings.openaiCompatBackups?.[0]?.apiKey || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup1-model">Backup API 1 Model</label>
              <input id="ai-edit-compat-backup1-model" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[0]?.model || "")}" placeholder="Optional, fallback to ChatGPT model when empty" />
            </div>
            <div>
              <label for="ai-edit-compat-backup2-url">Backup API 2 Base URL</label>
              <input id="ai-edit-compat-backup2-url" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[1]?.baseUrl || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup2-key">Backup API 2 API Key</label>
              <input id="ai-edit-compat-backup2-key" type="password" value="${escapeHtml(settings.openaiCompatBackups?.[1]?.apiKey || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup2-model">Backup API 2 Model</label>
              <input id="ai-edit-compat-backup2-model" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[1]?.model || "")}" placeholder="Optional, fallback to ChatGPT model when empty" />
            </div>
          </div>
        </div>
        <div>
          <label for="ai-edit-optimize-system">Optimize System Prompt</label>
          <textarea id="ai-edit-optimize-system" rows="3">${escapeHtml(settings.prompts.optimize.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-optimize-user">Optimize User Prompt</label>
          <textarea id="ai-edit-optimize-user" rows="4">${escapeHtml(settings.prompts.optimize.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-context-system">Context Optimize System Prompt</label>
          <textarea id="ai-edit-context-system" rows="3">${escapeHtml(settings.prompts.optimize_with_context.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-context-user">Context Optimize User Prompt</label>
          <textarea id="ai-edit-context-user" rows="4">${escapeHtml(settings.prompts.optimize_with_context.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-system">Q&amp;A System Prompt</label>
          <textarea id="ai-edit-qa-system" rows="3">${escapeHtml(settings.prompts.qa.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-user">Q&amp;A User Prompt</label>
          <textarea id="ai-edit-qa-user" rows="2">${escapeHtml(settings.prompts.qa.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-context-system">Q&amp;A With Context System Prompt</label>
          <textarea id="ai-edit-qa-context-system" rows="3">${escapeHtml(settings.prompts.qa_with_context.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-context-user">Q&amp;A With Context User Prompt</label>
          <textarea id="ai-edit-qa-context-user" rows="4">${escapeHtml(settings.prompts.qa_with_context.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-image-qa-system">Image Q&amp;A System Prompt</label>
          <textarea id="ai-edit-image-qa-system" rows="3">${escapeHtml(settings.prompts.image_qa.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-image-qa-user">Image Q&amp;A User Prompt</label>
          <textarea id="ai-edit-image-qa-user" rows="3">${escapeHtml(settings.prompts.image_qa.user)}</textarea>
        </div>
        <div class="ai-edit-setting-card">
          <div class="ai-edit-setting-card-title">Chat History</div>
          <div class="ai-edit-setting-card-note">Clearing history is permanent and does not change your AI settings.</div>
          <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="ai-edit-btn danger" id="ai-edit-clear-current-history" ${documentIdentity?.persistable ? "" : "disabled"}>Clear Current File History</button>
            <button class="ai-edit-btn danger" id="ai-edit-clear-all-history">Clear All Chat History</button>
          </div>
        </div>
      </div>
      <div style="margin-top: 14px; display: flex; gap: 10px;">
        <button class="ai-edit-btn primary" id="ai-edit-save-settings">Save</button>
      </div>
    `;

    container.querySelector("#ai-edit-model-preset").addEventListener("change", () => {
      toggleCustomModelInput(container, "ai-edit-model-preset", "ai-edit-model-custom");
    });
    container.querySelector("#ai-edit-compat-model-preset").addEventListener("change", () => {
      toggleCustomModelInput(container, "ai-edit-compat-model-preset", "ai-edit-compat-model-custom");
    });
    bindChatHistoryControls(container, this.plugin);

    container.querySelector("#ai-edit-oauth-login").addEventListener("click", async () => {
      const oauthTokenPath = container.querySelector("#ai-edit-oauth-path").value.trim();
      const oauthUserInfoPath = container.querySelector("#ai-edit-oauth-user-path").value.trim();
      this.plugin.saveSettings({
        oauthTokenPath,
        oauthUserInfoPath,
      });

      new Notice("Starting OpenAI OAuth login in browser...");
      try {
        const result = await loginOpenAiOauthInteractive(this.plugin.getSettings());
        this.plugin.saveSettings({
          oauthTokenPath: oauthTokenPath || result.tokenPath,
          oauthUserInfoPath,
        });
        this.render();
        new Notice(`OAuth login successful. Token saved to: ${result.tokenPath}`);
      } catch (error) {
        new Notice(`OAuth login failed: ${error?.message || "Unknown error"}`);
      }
    });

    container.querySelector("#ai-edit-oauth-refresh").addEventListener("click", () => {
      this.render();
      new Notice("OAuth status refreshed.");
    });

    container.querySelector("#ai-edit-oauth-download").addEventListener("click", async () => {
      const oauthTokenPath = container.querySelector("#ai-edit-oauth-path").value.trim();
      const oauthUserInfoPath = container.querySelector("#ai-edit-oauth-user-path").value.trim();

      this.plugin.saveSettings({
        oauthTokenPath,
        oauthUserInfoPath,
      });

      try {
        const outputPath = await downloadOAuthUserInfo(this.plugin.getSettings());
        this.plugin.saveSettings({
          oauthTokenPath,
          oauthUserInfoPath,
        });
        this.render();
        new Notice(`OAuth user info saved: ${outputPath}`);
      } catch (error) {
        new Notice(`Download failed: ${error?.message || "Unknown error"}`);
      }
    });

    container.querySelector("#ai-edit-export-prompts").addEventListener("click", () => {
      const promptExportPath = container.querySelector("#ai-edit-prompt-export-path").value.trim();
      this.plugin.saveSettings({
        promptExportPath,
      });

      try {
        const latestSettings = this.plugin.getSettings();
        const outputPath = exportPromptSettingsToFile(latestSettings);
        this.plugin.saveSettings({
          promptExportPath: promptExportPath || outputPath,
        });
        this.render();
        new Notice(`Output setting file saved: ${outputPath}`);
      } catch (error) {
        new Notice(`Output setting failed: ${error?.message || "Unknown error"}`);
      }
    });

    container.querySelector("#ai-edit-import-prompts").addEventListener("click", () => {
      const promptExportPath = container.querySelector("#ai-edit-prompt-export-path").value.trim();
      this.plugin.saveSettings({
        promptExportPath,
      });

      try {
        const imported = importPromptSettingsFromFile(this.plugin.getSettings());
        this.plugin.saveSettings({
          promptExportPath: promptExportPath || imported.inputPath,
          prompts: imported.prompts,
        });
        this.render();
        new Notice(`Imported prompts from: ${imported.inputPath}`);
      } catch (error) {
        new Notice(`Import setting failed: ${error?.message || "Unknown error"}`);
      }
    });

    container.querySelector("#ai-edit-save-settings").addEventListener("click", () => {
      const provider = container.querySelector("#ai-edit-provider").value;
      const model = readModelValue(container, "ai-edit-model-preset", "ai-edit-model-custom");
      const compatModelValue = readModelValue(container, "ai-edit-compat-model-preset", "ai-edit-compat-model-custom");
      if (provider === "chatgpt" && !model) {
        new Notice("ChatGPT model cannot be empty.");
        return;
      }
      if (provider === "openai_compat" && !compatModelValue) {
        new Notice("OpenAI compatible model cannot be empty.");
        return;
      }

      this.plugin.saveSettings({
        provider,
        model: model || settings.model || CHATGPT_MODEL_PRESETS[0],
        oauthTokenPath: container.querySelector("#ai-edit-oauth-path").value.trim(),
        oauthUserInfoPath: container.querySelector("#ai-edit-oauth-user-path").value.trim(),
        promptExportPath: container.querySelector("#ai-edit-prompt-export-path").value.trim(),
        openaiCompat: {
          baseUrl: container.querySelector("#ai-edit-compat-url").value.trim(),
          apiKey: container.querySelector("#ai-edit-compat-key").value.trim(),
          model: compatModelValue || settings.openaiCompat.model || OPENAI_COMPAT_MODEL_PRESETS[0],
        },
        openaiCompatFailoverEnabled: !!container.querySelector("#ai-edit-compat-failover-enabled").checked,
        openaiCompatPreferredConnection: container.querySelector("#ai-edit-compat-preferred-connection").value,
        openaiCompatBackups: [
          {
            name: "Backup 1",
            baseUrl: container.querySelector("#ai-edit-compat-backup1-url").value.trim(),
            apiKey: container.querySelector("#ai-edit-compat-backup1-key").value.trim(),
            model: container.querySelector("#ai-edit-compat-backup1-model").value.trim(),
          },
          {
            name: "Backup 2",
            baseUrl: container.querySelector("#ai-edit-compat-backup2-url").value.trim(),
            apiKey: container.querySelector("#ai-edit-compat-backup2-key").value.trim(),
            model: container.querySelector("#ai-edit-compat-backup2-model").value.trim(),
          },
        ],
        prompts: {
          optimize: {
            system: container.querySelector("#ai-edit-optimize-system").value,
            user: container.querySelector("#ai-edit-optimize-user").value,
          },
          optimize_with_context: {
            system: container.querySelector("#ai-edit-context-system").value,
            user: container.querySelector("#ai-edit-context-user").value,
          },
          qa: {
            system: container.querySelector("#ai-edit-qa-system").value,
            user: container.querySelector("#ai-edit-qa-user").value,
          },
          qa_with_context: {
            system: container.querySelector("#ai-edit-qa-context-system").value,
            user: container.querySelector("#ai-edit-qa-context-user").value,
          },
          image_qa: {
            system: container.querySelector("#ai-edit-image-qa-system").value,
            user: container.querySelector("#ai-edit-image-qa-user").value,
          },
        },
      });
      this.render();
      new Notice("AI Edit settings saved.");
    });
  }
}
