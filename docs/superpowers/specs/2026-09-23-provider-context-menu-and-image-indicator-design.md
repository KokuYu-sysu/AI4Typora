# Provider settings, context menu, shortcut hint, and image status

Date: 2026-09-23

## Goal and scope

Make the existing Typora AI Edit UI clearer without changing its conversation, optimization, or Diff workflows. The requested changes are:

1. When OpenAI Compatible is selected, its primary connection uses freely editable Base URL, API Key, and exact Model ID fields. ChatGPT-only model and OAuth controls are hidden. Existing compatible backup/failover configuration remains available under a collapsed Advanced section.
2. Right-clicking selected text uses Typora's native context menu. The plugin no longer intercepts that selection to offer Optimize or Q&A. Existing keyboard shortcuts remain the way to launch those actions. Right-clicking an image still offers the plugin's AI image-question entry.
3. The dismissible shortcut hint in the upper-right stays visible during the plugin session until its × is clicked, and shows one shortcut per line.
4. Starting image Q&A visibly marks the image as pending in the conversation composer. After the user sends the question, the corresponding user message visibly indicates that an image was included.

The reported absence of Replace in the Diff dialog needs no change: the user confirmed it appears after saving the document. Do not loosen the existing saved-document and selection validation for Replace.

## Current behavior and cause

- `src/settings-tab.js` renders the ChatGPT model/OAuth controls and OpenAI Compatible controls simultaneously. The compatible primary model is already a text input and is sent as entered, but unrelated controls obscure which settings apply. The backup fields are also always visible.
- `src/plugin.js` captures `contextmenu` for editor text selection, prevents Typora's native menu, and substitutes plugin actions. Its separate image branch offers AI Ask About Image and must be kept.
- `src/ui.js` puts all shortcut descriptions into one text span. CSS wrapping does not guarantee one shortcut per line.
- `src/chat-service.js` stores an image in `pendingImage` when an image draft opens and persists it on the first sent user message. `src/chat-panel.js` currently renders neither `pendingImage` nor a persisted message's `image` property.

## UI behavior

### Provider-aware settings

The provider selector determines which provider-specific group is displayed immediately, without requiring Save:

| Provider | Visible provider-specific controls |
| --- | --- |
| ChatGPT OAuth Login | ChatGPT model preset/custom field, OAuth paths/status/actions |
| OpenAI Compatible | Primary Base URL, API Key, Model ID text fields; collapsed Advanced compatible connections section |

The OpenAI Compatible Model ID is always a free-text input, with no preset list, autocomplete constraint, or alias conversion. Its entered ID remains the value sent to the API. The primary three-field group is the only *basic provider configuration* visible for OpenAI Compatible. Shared prompt editing, prompt import/export, chat-history controls, and Save remain available for either provider.

Advanced contains the existing failover toggle, active connection selection, and two backup connections (each with editable Base URL, API Key, and Model ID). It starts collapsed whenever settings are opened. Opening or closing it must not change values. The existing backup schema and provider behavior stay intact; this is only a presentation change. Do not remove previously saved backup values or the ChatGPT configuration when switching providers. Save must retain fields hidden by the current provider, including values edited in the same settings view before switching provider. Existing compatible values are loaded into their inputs when that provider is shown. Validation applies to the selected provider's required model field only.

### Native text right-click and image right-click

The context-menu handler leaves ordinary editor text selection alone: no `preventDefault`, no plugin menu, and no Optimize/Q&A entries. Typora therefore determines its own context menu. `Ctrl+R`, `Ctrl+Shift+R`, and the Q&A shortcut continue to work on selections as before. The image-specific right-click path remains, including AI Ask About Image and the way to open Typora's menu. It must not be affected by the text-selection condition.

### Shortcut hint

Render each existing shortcut hint as its own row, rather than relying on automatic wrapping. Keep the upper-right floating placement and × close control. Dismissal removes the hint for the current plugin load; restarting/reloading the plugin can show it again. The plugin removes it on unload as it currently does. Preserve the existing shortcut labels/keys; this change does not redefine shortcuts.

### Image attachment status in conversation

When an image right-click opens an image-question draft, the composer shows a compact, accessible indicator such as `Image attached · pending send` with a remove ×. The indicator is shown only while `pendingImage` exists. It does not show a raw path, data URL, or image payload. The user may remove the pending image before sending; that action clears the service's pending state and releases any stored temporary image asset through the existing asset lifecycle. Removing it leaves the conversation composer open and does not create a session.

Sending a nonempty question persists the user message with the image according to the existing chat service flow. Once the message actually contains a persisted `image` reference, its card shows a small `Image attached` marker. At that point the pending indicator disappears. A draft without a sent question still creates no session ID. The marker must reflect message data, not an assumption based on image mode, so a failed save cannot falsely appear sent. If saving fails before the image is attached to a user message, show the existing error and keep or restore the pending indicator where the asset is still available; if recovery is impossible, make the failure clear instead of claiming the image was sent. Navigating to another session or document, starting a new draft, or closing the service continues to clear/release unsubmitted image assets.

The indicator is status-only: no image preview, thumbnail generation, automatic message send, or change to image processing is required. Existing assistant streaming, follow-up questions, history, and Insert actions stay unchanged.

## Implementation boundaries

- Keep changes local to `src/settings-tab.js`, `src/plugin.js`, `src/ui.js`, `src/chat-panel.js`, `src/chat-service.js`, and directly related styles/tests. Reuse existing state and message shapes; add only a focused service method for removing a pending image if needed.
- No configuration migration or API protocol change. Existing settings and saved conversations remain readable.
- Do not alter Diff Replace availability, unsaved-document checks, or text-selection snapshot logic.
- Keep UI state transitions explicit and event listeners scoped to the settings/panel lifecycle so repeated open/close does not duplicate behavior.

## Acceptance checks

Use focused automated tests and a short Typora smoke check, avoiding a broad test sweep:

1. Switching providers hides the other provider's controls without losing primary/backup/ChatGPT values; selecting OpenAI Compatible shows three editable primary fields and collapsed Advanced backups. Save keeps exact compatible Model ID and existing backup configuration.
2. Selected text right-click reaches Typora's native menu while image right-click still exposes AI Ask About Image. Keyboard Optimize/Q&A paths remain reachable.
3. Shortcut hint has separate visible rows, stays until ×, and unload cleanup works.
4. Image draft shows a pending indicator before any session is created; remove clears it; send changes it to a marker on the persisted user message. Text-only drafts/messages have neither marker. Failure and navigation do not mislabel or leak pending assets.
5. The existing Diff Replace rule for saved documents is unchanged.
