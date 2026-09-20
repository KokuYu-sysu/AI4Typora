# Maintainable AI Edit Upgrade Design

**Date:** 2026-09-20

**Status:** Approved

## Objective

Upgrade the Windows Typora AI Edit plugin with reliable streaming output, linguist-editor default prompts, deterministic Markdown math preservation, a safe local-rewrite Diff workflow, and persistent multi-session text/image conversations scoped to the current Markdown file.

The implementation must remain maintainable: responsibilities are split into small ES modules, core transformations are pure and independently tested, UI modules do not own persistence or provider logic, and only the editor controller may modify the Typora document.

## Constraints

- Keep the existing JavaScript ES-module runtime and no-build distribution model.
- Do not migrate the project to TypeScript in this release.
- Do not require Python at runtime.
- Do not require `node_modules` to be shipped with the plugin.
- Preserve and integrate the existing uncommitted work in `src/editor.js`, `src/plugin.js`, `src/ui.js`, and the three untracked editor tests.
- Continue supporting ChatGPT OAuth and OpenAI-compatible providers.
- Continue targeting Windows and Node.js 22 or newer.

## Architecture

Existing modules retain narrow roles:

- `src/plugin.js`: command registration and high-level flow orchestration.
- `src/api.js`: provider request translation, streaming transport, and SSE parsing.
- `src/editor.js`: selection snapshots, safe replacement, caret tracking, and Markdown insertion.
- `src/ui.js`: generic menus, prompts, notices, and small dialog primitives.

New modules establish explicit boundaries:

- `src/math-protection.js`: scan, protect, validate, and restore Markdown/LaTeX formulas.
- `src/text-diff.js`: produce Unicode-aware line/word/character Diff operations.
- `src/diff-dialog.js`: render rewrite progress and completed Diff actions.
- `src/document-identity.js`: resolve and normalize the current Markdown file identity.
- `src/chat-store.js`: versioned atomic JSON persistence and image asset lifecycle.
- `src/chat-service.js`: lazy session creation, message replay, context trimming, retries, and regeneration.
- `src/chat-panel.js`: non-modal right-side conversation UI and session navigation.

UI modules call services. Services call provider and persistence modules. Only `EditorSelectionController` changes Typora content.

## Streaming and Provider Requests

The provider boundary uses a normalized message array rather than separate system/user string arguments. A message can contain plain text and, for user messages, an optional prepared image.

Each call owns its own `AbortController`; there is no process-global request controller. The returned request handle exposes a promise and `abort()` so a Diff dialog or chat session can cancel only its own work.

Both SSE parsers must support fragmented UTF-8 input, CRLF and LF framing, a final event without a trailing blank line, `[DONE]`, and provider error events. A failed OpenAI-compatible attempt may fail over. If the failed attempt emitted content, the UI resets that attempt before rendering the backup response so outputs are never concatenated.

Stopping preserves the visible partial response with a `stopped` state, but a stopped local rewrite cannot replace document text.

## Default Prompt Identity

Chinese and English defaults identify the model as a senior linguistics expert and professional editor with strong knowledge of grammar, semantics, pragmatics, register, terminology consistency, and cross-language expression.

Mode-specific prompts add their own rules:

- Rewrite modes return only the revised passage and preserve meaning.
- Context rewrite additionally preserves protected math placeholders exactly.
- Text chat answers the question while retaining multi-turn context.
- Image chat bases claims on the image and states uncertainty.

Existing customized prompts remain unchanged during upgrade. New defaults apply only to new installations and explicit reset-to-default actions.

## Formula Preservation

Context-aware local rewriting protects formulas deterministically rather than trusting the prompt alone.

Supported forms are `$$...$$`, `$...$`, `\(...\)`, and `\[...\]`. The scanner ignores escaped dollar signs and formulas inside inline code or fenced code blocks. It keeps each formula's exact delimiters, whitespace, line endings, and body.

Before sending the selected passage, formulas are replaced with ordered sentinels such as `⟪AI_EDIT_MATH_0⟫`. After streaming completes, every sentinel must occur exactly once and in its original order. Only then are exact original formulas restored. Missing, duplicated, reordered, or mutated sentinels mark the result invalid: it remains viewable, but replacement is disabled and regeneration is offered.

The full document is read-only context and is never rewritten directly. Formula validation applies to the selected passage that can be replaced.

## Local Rewrite Diff

Diff is implemented in JavaScript with no Python dependency. It first compares lines and then refines changed lines with word tokens. `Intl.Segmenter` is used when present; a Unicode character fallback is used otherwise. Formula sentinels and restored formulas are indivisible tokens.

The Diff dialog shows deletions with red strike-through styling, insertions with green highlighting, and collapsible unchanged context. It streams plain candidate text during generation and switches to Diff view only after a complete, formula-valid response.

Actions are:

- **Replace:** allowed only for a complete, valid response and an unchanged target.
- **Regenerate:** reuses the captured selection, full-document context, and additional instruction while replacing the old candidate.
- **Stop:** aborts the current request and preserves its visible partial output without enabling replacement.
- **Close:** discards the candidate and leaves the document unchanged.

The selection snapshot records the normalized current-file identity and selected text. Immediately before replacement, the editor controller verifies the same file is active, the saved range is connected, and the range still contains the original text. A failed check disables replacement rather than writing at another location.

## Conversation Sessions

The conversation interface is a resizable, non-modal panel fixed to the right side of Typora. It contains a collapsible session-history rail and the active message thread.

Opening the panel always starts on an unpersisted blank draft. It neither restores the most recent conversation nor allocates a session ID. The first submitted user message creates the session with `crypto.randomUUID()` and saves it. Selecting an old session explicitly loads and continues it. Closing and reopening again starts with a blank draft.

The first question supplies an automatic title of at most 40 visible characters. Users may rename or delete sessions. Every completed or stopped assistant message has Copy and Insert actions. Insert writes Markdown at the last valid editor caret and does not close the panel.

The panel rechecks the current document identity before sending, inserting, selecting a session, or receiving a stream event. A file change aborts the old request, resets the active view to a blank draft, and loads the new file's history list.

## Image Follow-ups

An image question creates a normal conversation whose first user message carries an image reference. Later text questions replay the original image plus recent conversation messages because both supported provider calls are stateless.

Local images and data URLs are copied into the chat asset directory. HTTP images are snapshotted when possible and otherwise retain their original URL. JSON stores asset metadata rather than embedded Base64. Missing assets do not hide existing text history, but the panel reports that the image can no longer be resubmitted.

## Persistence

Data is stored under:

```text
%APPDATA%\typora-ai-edit\
├── chat-history-v1.json
└── chat-assets\
```

The history file contains a schema version and document records keyed by a hash of the normalized absolute Markdown path. It never stores API keys, OAuth tokens, or full document content.

Writes use a temporary file in the same directory followed by atomic rename. If parsing fails, the damaged file is renamed with a timestamp and a new empty database is created. The store retains at most 100 sessions per document and 200 messages per session. At 100 MB global usage it removes least-recently-used inactive sessions and reports pruning to the UI.

Unsaved documents may use in-memory conversations but are not persisted. Once saved, the next newly submitted message belongs to the saved file's new or explicitly chosen session.

Deleting a session removes an image asset only when no remaining session references it. Settings actions allow deletion of the current file's history or all history, both after confirmation.

## Context Replay

The complete conversation remains visible and persisted. A single model request replays at most approximately 60,000 text characters. It always retains the system prompt, the first image-bearing message when present, and the newest complete turns that fit the budget. Streaming placeholders, failed assistant messages, and UI-only error text are excluded.

## Error Handling

- User messages are persisted before sending so failed requests can be retried.
- Successful, stopped, and failed assistant states are distinct.
- Switching file/session or closing the panel aborts only that panel's active request.
- A provider failover resets partial content before rendering the replacement attempt.
- Formula validation failures disable replacement.
- Stale selection checks prevent replacement at the wrong location.
- Corrupt history is preserved as a timestamped backup.
- Missing image assets leave text history readable.

## Test Strategy

Use Node.js built-in testing without a new test framework. Pure modules receive unit tests; DOM-facing modules use focused fake DOM fixtures consistent with existing editor tests. Real Typora validation covers provider integration and editor behavior.

Automated coverage includes:

- fragmented SSE, line endings, trailing buffers, stop, errors, and failover reset;
- all supported math delimiters, escaping, code spans/fences, and sentinel corruption;
- Chinese/English Diff, whitespace, punctuation, long passages, formulas, and reconstruction invariants;
- lazy session creation, per-document isolation, atomic writes, corruption recovery, version migration, retention, and asset reference cleanup;
- multi-turn replay, image follow-up, context trimming, retry, stop, and stale-stream rejection;
- safe replacement and persistent last-caret insertion without closing the chat panel.

Manual validation is performed with both ChatGPT OAuth and an OpenAI-compatible provider.

## Delivery Breakdown

Implementation is divided into three independently testable plans in dependency order:

1. Streaming, prompts, and formula protection.
2. Diff rewrite workflow and safe replacement.
3. Persistent multi-session text/image conversations.

Each plan uses test-first steps, preserves the user's existing working-tree changes, and ends with documentation and real-Typora acceptance checks appropriate to that phase.

## Acceptance Criteria

- All generation modes visibly stream with both providers.
- New default prompts establish the senior linguist/editor identity.
- Supported formulas in the replaceable selection are restored byte-for-byte.
- Local rewrites show a Diff, support regeneration, and replace only a verified unchanged target.
- Opening chat creates no session; the first question creates one.
- One Markdown file can own multiple persistent, explicitly selectable sessions.
- Text and image sessions support follow-up questions after restart.
- Every assistant message can be inserted without closing the panel.
- File switches, aborts, provider failures, corrupt history, and missing assets cannot write into the wrong document or irreversibly overwrite recoverable data.
- Existing and new automated tests pass, and README/version history are updated.
