const { SettingTab, Notice } = window[Symbol.for("typora-plugin-core@v2")];

import {
  CHATGPT_MODEL_PRESETS,
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
import { translate } from "./i18n.js";

const CUSTOM_MODEL_VALUE = "__custom__";
const OAUTH_STATUS_KEYS = {
  "OAuth token file format is not supported.": "settings.oauthUnsupported",
  "No OAuth token found in the common Windows paths.": "settings.oauthMissing",
  "OAuth token expired and no refresh token was found. Please login again.": "settings.oauthExpired",
};

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

function createModelOptions(presets, selectedValue, customLabel) {
  const options = presets.map((preset) => {
    const selected = selectedValue === preset ? "selected" : "";
    return `<option value="${escapeHtml(preset)}" ${selected}>${escapeHtml(preset)}</option>`;
  });
  options.push(`<option value="${CUSTOM_MODEL_VALUE}" ${selectedValue === CUSTOM_MODEL_VALUE ? "selected" : ""}>${escapeHtml(customLabel)}</option>`);
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

export function applyProviderVisibility(container, provider) {
  container.querySelector("#ai-edit-chatgpt-settings").hidden = provider !== "chatgpt";
  container.querySelector("#ai-edit-compatible-settings").hidden = provider !== "openai_compat";
}

export function bindChatHistoryControls(container, plugin, {
  confirm = confirmAction,
  notify = (message) => new Notice(message),
} = {}) {
  const language = plugin.getSettings?.().uiLanguage || "en";
  const tr = (key, params) => translate(language, key, params);
  const current = container.querySelector("#ai-edit-clear-current-history");
  const all = container.querySelector("#ai-edit-clear-all-history");
  if (!current || !all) return;
  current.disabled = !plugin.getCurrentDocumentIdentity?.()?.persistable;

  current.addEventListener("click", async () => {
    const identity = plugin.getCurrentDocumentIdentity?.();
    if (!identity?.persistable) return;
    if (!await confirm({
      title: tr("history.currentTitle"),
      message: tr("history.currentMessage"),
      confirmText: tr("history.currentConfirm"),
      language,
    })) return;
    const currentIdentity = plugin.getCurrentDocumentIdentity?.();
    if (!currentIdentity?.persistable || currentIdentity.key !== identity.key) {
      notify(tr("history.fileChanged"));
      return;
    }
    try {
      await plugin.clearCurrentFileChatHistory(currentIdentity);
      notify(tr("history.currentCleared"));
    } catch (error) {
      notify(tr("history.currentFailed", { detail: error?.message || tr("settings.unknownError") }));
    }
  });

  all.addEventListener("click", async () => {
    if (!await confirm({
      title: tr("history.allTitle"),
      message: tr("history.allMessage"),
      confirmText: tr("history.allConfirm"),
      language,
    })) return;
    try {
      await plugin.clearAllChatHistory();
      notify(tr("history.allCleared"));
    } catch (error) {
      notify(tr("history.allFailed", { detail: error?.message || tr("settings.unknownError") }));
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
    const language = settings.uiLanguage || "en";
    const tr = (key, params) => escapeHtml(translate(language, key, params));
    const notice = (key, params) => new Notice(translate(language, key, params));
    const documentIdentity = this.plugin.getCurrentDocumentIdentity?.();
    const status = getOAuthStatus(settings);
    const chatgptModel = getModelUiState(settings.model, CHATGPT_MODEL_PRESETS);
    const container = this.containerEl || this.contentEl || this.tabContentEl;
    if (container.empty) {
      container.empty();
    } else {
      container.innerHTML = "";
    }

    container.innerHTML = `
      <h2>AI Edit</h2>
      <p class="ai-edit-setting-note">${tr("settings.shortcuts", { chat: formatShortcut(settings.shortcut) })}</p>
      <div class="ai-edit-setting-grid">
        <div>
          <label for="ai-edit-provider">${tr("settings.provider")}</label>
          <select id="ai-edit-provider">
            <option value="chatgpt" ${settings.provider === "chatgpt" ? "selected" : ""}>${tr("settings.chatgptLogin")}</option>
            <option value="openai_compat" ${settings.provider === "openai_compat" ? "selected" : ""}>${tr("settings.compatible")}</option>
          </select>
        </div>
        <div>
          <label for="ai-edit-ui-language">${tr("settings.language")}</label>
          <select id="ai-edit-ui-language">
            <option value="zh-CN" ${language === "zh-CN" ? "selected" : ""}>简体中文</option>
            <option value="en" ${language === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
        <div id="ai-edit-chatgpt-settings">
        <div>
          <label for="ai-edit-model-preset">${tr("settings.chatgptModel")}</label>
          <select id="ai-edit-model-preset">
            ${createModelOptions(CHATGPT_MODEL_PRESETS, chatgptModel.preset, tr("settings.custom"))}
          </select>
          <input id="ai-edit-model-custom" type="text" placeholder="${tr("settings.typeModel")}" value="${escapeHtml(chatgptModel.custom)}" style="margin-top: 6px; ${chatgptModel.preset === CUSTOM_MODEL_VALUE ? "" : "display: none;"}" />
        </div>
        <div>
          <label for="ai-edit-oauth-path">${tr("settings.tokenPath")}</label>
          <input id="ai-edit-oauth-path" type="text" value="${escapeHtml(settings.oauthTokenPath || "")}" />
          <label for="ai-edit-oauth-user-path" style="margin-top: 6px;">${tr("settings.userPath")}</label>
          <input id="ai-edit-oauth-user-path" type="text" value="${escapeHtml(settings.oauthUserInfoPath || "")}" />
          <div class="ai-edit-setting-note">${tr("settings.autoDetect")}</div>
          <div class="ai-edit-setting-note">${tr("settings.oauthFlow")}</div>
          <div class="ai-edit-setting-status ${status.ok ? "ok" : "bad"}">${status.ok ? tr("settings.connected", { path: status.sourcePath }) : tr(OAUTH_STATUS_KEYS[status.message] || "settings.oauthStatusUnknown", { detail: status.message })}</div>
          <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="ai-edit-btn secondary" id="ai-edit-oauth-login">${tr("settings.oauthLogin")}</button>
            <button class="ai-edit-btn secondary" id="ai-edit-oauth-download">${tr("settings.downloadUser")}</button>
            <button class="ai-edit-btn secondary" id="ai-edit-oauth-refresh">${tr("settings.refreshStatus")}</button>
          </div>
        </div>
        </div>
        <div>
          <label for="ai-edit-prompt-export-path">${tr("settings.promptPath")}</label>
          <input id="ai-edit-prompt-export-path" type="text" value="${escapeHtml(settings.promptExportPath || "")}" />
          <div class="ai-edit-setting-note">${tr("settings.promptNote")}</div>
          <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="ai-edit-btn secondary" id="ai-edit-export-prompts">${tr("settings.export")}</button>
            <button class="ai-edit-btn secondary" id="ai-edit-import-prompts">${tr("settings.import")}</button>
          </div>
        </div>
        <div id="ai-edit-compatible-settings">
        <div>
          <label for="ai-edit-compat-url">${tr("settings.compatUrl")}</label>
          <input id="ai-edit-compat-url" type="text" value="${escapeHtml(settings.openaiCompat.baseUrl || "")}" />
        </div>
        <div>
          <label for="ai-edit-compat-key">${tr("settings.compatKey")}</label>
          <input id="ai-edit-compat-key" type="password" value="${escapeHtml(settings.openaiCompat.apiKey || "")}" />
        </div>
        <div>
          <label for="ai-edit-compat-model">${tr("settings.compatModel")}</label>
          <input id="ai-edit-compat-model" type="text" placeholder="${tr("settings.exactModel")}" value="${escapeHtml(settings.openaiCompat.model || "")}" />
          <div class="ai-edit-setting-note">${tr("settings.modelNote")}</div>
        </div>
        <details id="ai-edit-compatible-advanced" class="ai-edit-setting-card">
          <summary>${tr("settings.advanced")}</summary>
          <div class="ai-edit-toggle-row">
            <div class="ai-edit-toggle-row-text">${tr("settings.enableFailover")}</div>
            <label class="ai-edit-toggle-control" for="ai-edit-compat-failover-enabled">
              <input id="ai-edit-compat-failover-enabled" type="checkbox" ${settings.openaiCompatFailoverEnabled ? "checked" : ""} />
              ${tr("settings.enabled")}
            </label>
          </div>
          <div style="margin-top: 8px;">
            <label for="ai-edit-compat-preferred-connection">${tr("settings.activeConnection")}</label>
            <select id="ai-edit-compat-preferred-connection">
              <option value="primary" ${settings.openaiCompatPreferredConnection === "primary" ? "selected" : ""}>${tr("settings.primary")}</option>
              <option value="backup_1" ${settings.openaiCompatPreferredConnection === "backup_1" ? "selected" : ""}>${tr("settings.backup1")}</option>
              <option value="backup_2" ${settings.openaiCompatPreferredConnection === "backup_2" ? "selected" : ""}>${tr("settings.backup2")}</option>
            </select>
            <div class="ai-edit-setting-card-note">${tr("settings.connectionNote")}</div>
          </div>
          <div class="ai-edit-setting-subgrid">
            <div>
              <label for="ai-edit-compat-backup1-url">${tr("settings.backup1Url")}</label>
              <input id="ai-edit-compat-backup1-url" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[0]?.baseUrl || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup1-key">${tr("settings.backup1Key")}</label>
              <input id="ai-edit-compat-backup1-key" type="password" value="${escapeHtml(settings.openaiCompatBackups?.[0]?.apiKey || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup1-model">${tr("settings.backup1Model")}</label>
              <input id="ai-edit-compat-backup1-model" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[0]?.model || "")}" placeholder="${tr("settings.optionalModel")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup2-url">${tr("settings.backup2Url")}</label>
              <input id="ai-edit-compat-backup2-url" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[1]?.baseUrl || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup2-key">${tr("settings.backup2Key")}</label>
              <input id="ai-edit-compat-backup2-key" type="password" value="${escapeHtml(settings.openaiCompatBackups?.[1]?.apiKey || "")}" />
            </div>
            <div>
              <label for="ai-edit-compat-backup2-model">${tr("settings.backup2Model")}</label>
              <input id="ai-edit-compat-backup2-model" type="text" value="${escapeHtml(settings.openaiCompatBackups?.[1]?.model || "")}" placeholder="${tr("settings.optionalModel")}" />
            </div>
          </div>
        </details>
        </div>
        <div>
          <label for="ai-edit-optimize-system">${tr("settings.optimizeSystem")}</label>
          <textarea id="ai-edit-optimize-system" rows="3">${escapeHtml(settings.prompts.optimize.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-optimize-user">${tr("settings.optimizeUser")}</label>
          <textarea id="ai-edit-optimize-user" rows="4">${escapeHtml(settings.prompts.optimize.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-context-system">${tr("settings.contextSystem")}</label>
          <textarea id="ai-edit-context-system" rows="3">${escapeHtml(settings.prompts.optimize_with_context.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-context-user">${tr("settings.contextUser")}</label>
          <textarea id="ai-edit-context-user" rows="4">${escapeHtml(settings.prompts.optimize_with_context.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-system">${tr("settings.qaSystem")}</label>
          <textarea id="ai-edit-qa-system" rows="3">${escapeHtml(settings.prompts.qa.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-user">${tr("settings.qaUser")}</label>
          <textarea id="ai-edit-qa-user" rows="2">${escapeHtml(settings.prompts.qa.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-context-system">${tr("settings.qaContextSystem")}</label>
          <textarea id="ai-edit-qa-context-system" rows="3">${escapeHtml(settings.prompts.qa_with_context.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-qa-context-user">${tr("settings.qaContextUser")}</label>
          <textarea id="ai-edit-qa-context-user" rows="4">${escapeHtml(settings.prompts.qa_with_context.user)}</textarea>
        </div>
        <div>
          <label for="ai-edit-image-qa-system">${tr("settings.imageQaSystem")}</label>
          <textarea id="ai-edit-image-qa-system" rows="3">${escapeHtml(settings.prompts.image_qa.system)}</textarea>
        </div>
        <div>
          <label for="ai-edit-image-qa-user">${tr("settings.imageQaUser")}</label>
          <textarea id="ai-edit-image-qa-user" rows="3">${escapeHtml(settings.prompts.image_qa.user)}</textarea>
        </div>
        <div class="ai-edit-setting-card">
          <div class="ai-edit-setting-card-title">${tr("settings.history")}</div>
          <div class="ai-edit-setting-card-note">${tr("settings.historyNote")}</div>
          <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="ai-edit-btn danger" id="ai-edit-clear-current-history" ${documentIdentity?.persistable ? "" : "disabled"}>${tr("settings.clearCurrent")}</button>
            <button class="ai-edit-btn danger" id="ai-edit-clear-all-history">${tr("settings.clearAll")}</button>
          </div>
        </div>
      </div>
      <div style="margin-top: 14px; display: flex; gap: 10px;">
        <button class="ai-edit-btn primary" id="ai-edit-save-settings">${tr("common.save")}</button>
      </div>
    `;

    applyProviderVisibility(container, settings.provider);
    container.querySelector("#ai-edit-provider").addEventListener("change", (event) => {
      applyProviderVisibility(container, event.target.value);
    });
    container.querySelector("#ai-edit-model-preset").addEventListener("change", () => {
      toggleCustomModelInput(container, "ai-edit-model-preset", "ai-edit-model-custom");
    });
    bindChatHistoryControls(container, this.plugin);

    container.querySelector("#ai-edit-oauth-login").addEventListener("click", async () => {
      const oauthTokenPath = container.querySelector("#ai-edit-oauth-path").value.trim();
      const oauthUserInfoPath = container.querySelector("#ai-edit-oauth-user-path").value.trim();
      this.plugin.saveSettings({
        oauthTokenPath,
        oauthUserInfoPath,
      });

      notice("settings.oauthStarting");
      try {
        const result = await loginOpenAiOauthInteractive(this.plugin.getSettings());
        this.plugin.saveSettings({
          oauthTokenPath: oauthTokenPath || result.tokenPath,
          oauthUserInfoPath,
        });
        this.render();
        notice("settings.oauthSuccess", { path: result.tokenPath });
      } catch (error) {
        notice("settings.oauthFailed", { detail: error?.message || translate(language, "settings.unknownError") });
      }
    });

    container.querySelector("#ai-edit-oauth-refresh").addEventListener("click", () => {
      this.render();
      notice("settings.oauthRefreshed");
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
        notice("settings.userSaved", { path: outputPath });
      } catch (error) {
        notice("settings.downloadFailed", { detail: error?.message || translate(language, "settings.unknownError") });
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
        notice("settings.exportSaved", { path: outputPath });
      } catch (error) {
        notice("settings.exportFailed", { detail: error?.message || translate(language, "settings.unknownError") });
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
        notice("settings.imported", { path: imported.inputPath });
      } catch (error) {
        notice("settings.importFailed", { detail: error?.message || translate(language, "settings.unknownError") });
      }
    });

    container.querySelector("#ai-edit-save-settings").addEventListener("click", () => {
      const provider = container.querySelector("#ai-edit-provider").value;
      const selectedLanguage = container.querySelector("#ai-edit-ui-language").value;
      const model = readModelValue(container, "ai-edit-model-preset", "ai-edit-model-custom");
      const compatModelValue = container.querySelector("#ai-edit-compat-model").value.trim();
      if (provider === "chatgpt" && !model) {
        notice("settings.modelRequired");
        return;
      }
      if (provider === "openai_compat" && !compatModelValue) {
        notice("settings.compatModelRequired");
        return;
      }

      this.plugin.saveSettings({
        provider,
        uiLanguage: selectedLanguage,
        model,
        oauthTokenPath: container.querySelector("#ai-edit-oauth-path").value.trim(),
        oauthUserInfoPath: container.querySelector("#ai-edit-oauth-user-path").value.trim(),
        promptExportPath: container.querySelector("#ai-edit-prompt-export-path").value.trim(),
        openaiCompat: {
          baseUrl: container.querySelector("#ai-edit-compat-url").value.trim(),
          apiKey: container.querySelector("#ai-edit-compat-key").value.trim(),
          model: compatModelValue,
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
      new Notice(translate(selectedLanguage, "settings.saved"));
    });
  }
}
