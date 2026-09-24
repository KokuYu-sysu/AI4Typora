# Shortcut hint placement and UI language selection

Date: 2026-09-24

## Goal

Move the persistent AI Edit shortcut hint to the lower-right of Typora, place “AI Edit” and the conversation shortcut on separate lines, and let users choose Simplified Chinese or English for the whole AI Edit plugin interface.

## Current behavior

The hint is styled at the upper-right and its first row combines the plugin name with the conversation shortcut. The setting tab, chat panel, dialogs, notices, menus, and plugin-owned error messages contain mixed hard-coded English and Chinese. Default prompt locale currently follows the browser/OS language; existing settings can contain user-customized prompts. There is no saved UI-language setting.

## Behavior

- The hint sits at the lower-right, above Typora's bottom status bar, with a viewport-safe maximum width. Its rows are “AI Edit”, the configured conversation shortcut (default Ctrl+E) plus its action, Ctrl+R, and Ctrl+Shift+R. Each row is distinct. The × remains reachable and dismissal lasts until plugin reload. Changing language or saving settings does not resurrect a dismissed hint.
- The chat panel remains higher in stacking order than the hint. While the panel occupies the right side, it may cover the hint rather than allowing the hint to block the composer; closing the panel exposes the hint again if it was not dismissed.
- Settings include a two-option UI Language selector: 简体中文 and English. If the setting is absent, initialize from the current language detection (Chinese browser/OS locale chooses Simplified Chinese; otherwise English). Once saved, the explicit choice persists. An invalid stored value falls back safely to the detected default.
- Saving a language change immediately updates the settings view and any open chat panel and visible hint. Existing unsent composer text, active session, history, streaming request, selection, and current document are not reset. Dialogs newly opened afterward use the selected language; an already-open dialog is not forcibly closed or rebuilt.
- Localize plugin-owned static interface text across the setting tab, shortcut hint, chat panel, context menu, optimize/Diff dialogs, buttons, labels, placeholders, toasts, confirmation dialogs, and plugin-owned errors. Use a central keyed bilingual catalog and a small lookup/formatting interface rather than scattered language ternaries. Brand names, key chords, model IDs, paths, user text, saved history titles, model responses, and raw provider/system error details are data, not translated.
- UI language does not change AI output language. Do not overwrite, migrate, or automatically translate any saved custom system/user prompts. The existing prompt editor continues to display saved prompt text unchanged. New default prompts retain their existing locale behavior and Typora formatting instructions.

## Architecture

Add a focused localization module that normalizes the persisted language and returns translated plugin-owned strings, including parameterized labels. Add one setting field to DEFAULT_SETTINGS/mergeSettings and plugin getSettings/saveSettings. Inject a language getter/localizer into UI surfaces that render text; update open surfaces in place on successful Save. The setting tab continues to own its draft controls and saves all existing fields without losing hidden-provider values.

Do not introduce a global mutable language singleton or hard reload the plugin. Preserve the existing non-modal chat and dialog lifecycle. Technical errors may include untranslated raw details after a localized explanatory prefix so users can still diagnose the source failure.

## Verification

Run only focused automated tests for locale normalization and persistence, language selector rendering and save behavior, hint placement/rows/dismissal, and chat-panel relabeling without losing draft/session state. Reuse relevant existing tests for provider settings, dialog flows, and chat interactions where they directly cover touched code. Then back up and synchronize only changed runtime files into the installed Typora plugin, verify hashes, launch/reload Typora, and check the hint position, language selection, and conversation panel in the live UI. Do not send a real model request or alter existing documents during the smoke check.
