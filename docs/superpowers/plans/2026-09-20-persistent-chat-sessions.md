# Persistent Multi-Session Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-modal right-side chat panel with lazy session creation, per-file persistent multi-session history, text and image follow-ups, and per-message Markdown insertion that leaves the panel open.

**Architecture:** `document-identity.js` scopes data to the current Markdown file. `chat-store.js` owns versioned JSON and image assets. `chat-service.js` owns session/message state and provider replay. `chat-panel.js` renders service state and emits user intent. `plugin.js` wires commands and lifecycle, while `editor.js` remains the only document insertion boundary.

**Tech Stack:** JavaScript ES modules, Node/Electron filesystem access, Fetch, DOM APIs, Node.js 22 built-in tests, Typora Community Plugin runtime.

## Global Constraints

- Complete the streaming/math and Diff plans first.
- Preserve the no-build JavaScript distribution model and Windows support.
- Store history under `%APPDATA%\typora-ai-edit`, not in plugin settings.
- Never store API keys, OAuth tokens, or full Markdown documents in chat history.
- Opening the panel must not create or restore a session; first Send creates the new `session_id`.
- Selecting history is the only way to restore an old session.
- Inserting an assistant message must not close the panel.
- Retain at most 100 sessions per document, 200 messages per session, and 100 MB globally.

## File Map

- Reuse `src/document-identity.js`: normalized current-file identity and stable hash from the Diff plan.
- Create `src/chat-store.js`: schema v1, serialized writes, corruption recovery, retention, and assets.
- Create `src/chat-service.js`: draft/session lifecycle, context replay, streaming state, image follow-up, and retry.
- Create `src/chat-panel.js`: resizable panel, history rail, message cards, and input controls.
- Modify `src/editor.js`: continuously remember the last valid editor caret and insert Markdown there.
- Modify `src/plugin.js`: panel lifecycle, shortcuts/context menu, file switching, and service construction.
- Modify `src/settings-tab.js`: destructive history controls with confirmation.
- Modify `src/ui.js`: panel styles and confirmation primitive only.
- Modify `src/platform.js`: narrowly scoped runtime path/byte helpers if required by the store.
- Create `test/document-identity.test.js`, `test/chat-store.test.js`, `test/chat-service.test.js`, `test/chat-context.test.js`, `test/chat-panel.test.js`, and `test/editor-chat-insert.test.js`.
- Modify `README.md`, `package.json`, and `manifest.json` for the release.

---

### Task 1: Verify Document Identity for Persistent Chat

**Files:**
- Modify: `src/document-identity.js` only if a missing chat case is exposed.
- Modify: `test/document-identity.test.js`

**Interfaces:**
- Consumes and verifies:

```js
getCurrentDocumentIdentity(runtime = window) => {
  persistable: boolean,
  key: string,
  path: string,
  label: string,
}

normalizeWindowsDocumentPath(value) => string
hashDocumentPath(normalizedPath) => string
```

- Saved-file lookup order: `window.File.filePath`, `window.File.bundle.filePath`, then a `.md` URL only when it is a local filesystem path.
- Unsaved identity: `{ persistable: false, key: "unsaved", path: "", label: "Unsaved document" }`.

- [ ] **Step 1: Review the phase-2 identity contract**

Confirm the module already resolves `window.File.filePath`, `window.File.bundle.filePath`, local `.md` URL fallback, and an unsaved identity without writing any state.

- [ ] **Step 2: Extend normalization tests for persistence paths**

Cover slash conversion, `.`/`..`, drive-letter casing, trailing separators, spaces, non-ASCII paths, and case-insensitive equality:

```js
assert.equal(
  normalizeWindowsDocumentPath("C:/Work/../Work/Paper.md"),
  normalizeWindowsDocumentPath("c:\\work\\paper.md"),
);
```

Assert distinct normalized paths produce distinct fixed-length keys and that the raw path cannot be recovered from the key.

- [ ] **Step 3: Extend runtime lookup tests**

Test every lookup source and the unsaved fallback using plain runtime objects.

- [ ] **Step 4: Run the extended tests**

Run: `node --test test/document-identity.test.js`

Expected: all phase-2 tests remain green; any newly added chat-specific edge case fails before the minimal correction.

- [ ] **Step 5: Make only required corrections**

Use Node `path.win32` and `crypto.createHash("sha256")` through the same safe Node lookup pattern already used in `platform.js`. Prefix keys with `doc_` and use the first 32 hexadecimal hash characters. Keep normalized path only as record metadata, never as a JSON object property.

- [ ] **Step 6: Run and commit only if changed**

```powershell
node --test test/document-identity.test.js
```

If Step 5 changed code or tests, commit only those files:

```powershell
git add -- src/document-identity.js test/document-identity.test.js
git commit -m "fix: harden chat document identity"
```

---

### Task 2: Implement the Versioned Chat Store Core

**Files:**
- Create: `src/chat-store.js`
- Modify: `src/platform.js`
- Create: `test/chat-store.test.js`

**Interfaces:**
- Produces:

```js
createChatStore({ baseDir, fs, path, now }) => {
  initialize(): Promise<void>,
  listSessions(documentIdentity): Promise<SessionSummary[]>,
  getSession(documentIdentity, sessionId): Promise<ChatSession | null>,
  createSession(documentIdentity, input): Promise<ChatSession>,
  appendMessage(documentIdentity, sessionId, message): Promise<ChatSession>,
  updateMessage(documentIdentity, sessionId, messageId, patch): Promise<ChatSession>,
  renameSession(documentIdentity, sessionId, title): Promise<void>,
  deleteSession(documentIdentity, sessionId): Promise<void>,
  clearDocument(documentIdentity): Promise<void>,
  clearAll(): Promise<void>,
}
```

Schema v1:

```js
{
  version: 1,
  documents: {
    [documentKey]: {
      path: string,
      label: string,
      lastAccessedAt: string,
      sessions: ChatSession[],
    }
  }
}
```

`ChatSession` contains `id`, `title`, `mode`, `createdAt`, `updatedAt`, and `messages`. `ChatMessage` contains `id`, `role`, `content`, `createdAt`, `status`, and optional `image` metadata.

- [ ] **Step 1: Write lazy-creation and isolation tests**

Assert `listSessions` on a new document performs no write and creates no document record. Create two sessions under one document and one under another; verify ordering by `updatedAt` and strict isolation.

- [ ] **Step 2: Write atomic/recovery tests**

With a temporary test directory and injected clock:

- initialize an absent store;
- persist and reload schema v1;
- confirm writes go to a same-directory temporary file before rename;
- load invalid JSON, assert it is renamed to `chat-history-v1.corrupt-<timestamp>.json`, and assert a new empty store is usable;
- reject unsupported future schema versions without overwriting them.

- [ ] **Step 3: Write retention tests**

Create 101 sessions and assert the oldest inactive session is pruned. Append 201 messages and assert the oldest complete turn is pruned without deleting the active streaming message. Inject a small global byte threshold in tests and assert least-recently-used inactive sessions are removed.

- [ ] **Step 4: Verify failure**

Run: `node --test test/chat-store.test.js`

Expected: module-not-found failure.

- [ ] **Step 5: Implement serialized writes**

Maintain one in-memory database after `initialize()`. Chain mutations through a private promise queue:

```js
writeQueue = writeQueue.then(async () => {
  await writeJsonAtomically(database);
});
```

Write UTF-8 JSON to `chat-history-v1.json.tmp`, flush/close it, then rename over `chat-history-v1.json`. Clean a stale `.tmp` during initialization only after validating the main file.

- [ ] **Step 6: Add production base-directory resolution**

Expose a narrow helper from `platform.js`:

```js
getChatDataDirectory() => path.join(process.env.APPDATA, "typora-ai-edit")
```

Throw a descriptive error when `APPDATA` or filesystem access is unavailable; do not silently write inside the plugin directory.

- [ ] **Step 7: Run and commit**

```powershell
node --test test/chat-store.test.js
git add -- src/chat-store.js src/platform.js test/chat-store.test.js
git commit -m "feat: persist versioned per-file chat sessions"
```

---

### Task 3: Persist Image Assets by Reference

**Files:**
- Modify: `src/chat-store.js`
- Modify: `src/platform.js`
- Modify: `test/chat-store.test.js`

**Interfaces:**
- Extends the store with:

```js
saveImageAsset(source) => Promise<{
  assetId: string,
  originalSource: string,
  mimeType: string,
  storedPath: string,
  fallbackUrl: string,
}>
resolveImageAsset(imageMeta) => Promise<string>
```

- `resolveImageAsset` returns a provider-ready local data URL or original HTTP URL.

- [ ] **Step 1: Write asset tests**

Cover local files, data URLs, mocked HTTP bytes, duplicate byte content, missing local files, failed HTTP snapshot with URL fallback, and reference cleanup after deleting the last referencing session.

- [ ] **Step 2: Verify failure**

Run: `node --test test/chat-store.test.js`

Expected: asset methods are missing.

- [ ] **Step 3: Implement content-addressed assets**

Hash image bytes with SHA-256, save as `chat-assets/<hash>.<safe-extension>`, and reuse an existing file for duplicate content. Validate MIME as an image type and impose a 20 MB per-image limit. Never place Base64 in history JSON.

For HTTP/blob/data sources, fetch or decode immediately when the first user image message is committed. Preserve `fallbackUrl` only for HTTP(S).

- [ ] **Step 4: Implement reference cleanup**

After session/document deletion, collect all live `assetId` values from the database and remove only unreferenced files inside the resolved `chat-assets` directory. Verify the resolved deletion target begins with the exact normalized asset directory before deletion.

- [ ] **Step 5: Run and commit**

```powershell
node --test test/chat-store.test.js test/image-input.test.js
git add -- src/chat-store.js src/platform.js test/chat-store.test.js
git commit -m "feat: retain chat image assets by reference"
```

---

### Task 4: Build Deterministic Conversation Replay

**Files:**
- Create: `src/chat-service.js`
- Create: `test/chat-context.test.js`

**Interfaces:**
- Produces:

```js
buildReplayMessages(messages, {
  maxCharacters = 60000,
  resolvedImageInput = null,
}) => Array<{
  role: "user" | "assistant",
  content: string,
  imageInput?: string,
}>
```

- Includes complete/stopped user-visible history.
- Excludes streaming placeholders, failed assistant messages, and UI error strings.
- Always retains the first image-bearing user message and newest complete turns fitting the budget.

- [ ] **Step 1: Write replay tests**

Assert correct role order, omission rules, exact 60,000-character accounting, preservation of the newest complete user/assistant turns, and forced inclusion of the first image message. Assert stored messages are not mutated.

- [ ] **Step 2: Verify failure**

Run: `node --test test/chat-context.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement backward context selection**

Reserve the first image message when present, then walk complete messages newest-to-oldest until the budget is exhausted. Restore chronological order. Do not split a message; allow the newest single message to exceed the budget rather than send an empty request.

- [ ] **Step 4: Run and commit**

```powershell
node --test test/chat-context.test.js
git add -- src/chat-service.js test/chat-context.test.js
git commit -m "feat: build bounded multi-turn chat context"
```

---

### Task 5: Implement Lazy Session and Streaming Chat State

**Files:**
- Modify: `src/chat-service.js`
- Create: `test/chat-service.test.js`

**Interfaces:**
- Produces:

```js
createChatService({ store, createRequest, resolveSettings, now }) => {
  subscribe(listener): () => void,
  openDraft(documentIdentity, options?): Promise<void>,
  openSession(documentIdentity, sessionId): Promise<void>,
  send(text, options?): Promise<void>,
  retryLastFailed(): Promise<void>,
  stop(): void,
  renameActive(title): Promise<void>,
  deleteActive(): Promise<void>,
  dispose(): void,
  getState(): ChatState,
}
```

`ChatState` contains `documentIdentity`, `sessions`, `activeSession`, `draftMode`, `pendingImage`, `requestStatus`, and `error`.

- [ ] **Step 1: Write the no-empty-session test**

Call `openDraft` and dispose without sending. Assert `store.createSession` and every mutation method were never called.

- [ ] **Step 2: Write first-send and follow-up tests**

On first Send, assert order is: create session, append user message, create request, stream an in-memory assistant message, then persist the completed assistant message. On a second Send, assert replay contains the first exchange.

- [ ] **Step 3: Write stop/failure/failover tests**

Assert Stop calls only the active handle, preserves partial content as `stopped`, and returns UI state to idle. A failed request leaves the user message persisted, marks a retryable error, and does not persist API error prose as assistant content. A failover reset clears partial assistant content before backup chunks.

- [ ] **Step 4: Write stale-stream tests**

Switch session or document while a fake request is active, then emit another chunk. Assert the old request is aborted and the late chunk cannot mutate the new state or store.

- [ ] **Step 5: Write image follow-up tests**

Open a draft with pending image metadata. First Send saves/resolves the asset and includes it. Second Send includes the original resolved image plus conversation history. Missing asset produces a readable, retryable UI error without hiding persisted text.

- [ ] **Step 6: Verify failure**

Run: `node --test test/chat-service.test.js`

Expected: service methods are missing.

- [ ] **Step 7: Implement service state transitions**

Use monotonically increasing request generation IDs. Every chunk/completion handler compares its captured generation and document/session IDs to current state before mutating. Generate session/message IDs with `crypto.randomUUID()` and derive the initial title from the first 40 Unicode graphemes.

- [ ] **Step 8: Run and commit**

```powershell
node --test test/chat-service.test.js test/chat-context.test.js test/chat-store.test.js test/api-streaming.test.js
git add -- src/chat-service.js test/chat-service.test.js
git commit -m "feat: manage lazy multi-turn chat sessions"
```

---

### Task 6: Track the Last Editor Caret and Insert Chat Markdown

**Files:**
- Modify: `src/editor.js`
- Create: `test/editor-chat-insert.test.js`
- Test: existing editor tests.

**Interfaces:**
- Produces:

```js
startCaretTracking(getDocumentIdentity): void
stopCaretTracking(): void
insertMarkdownAtLastCaret(text): { ok: boolean, reason?: string }
```

- Preserves all existing selection snapshot, auto-paste, and insertion behavior.

- [ ] **Step 1: Write caret tracking tests**

Assert only non-collapsed or collapsed selections inside `#write` update the saved editor range. Clicking panel DOM does not erase it. Stopping tracking removes the listener. Insertion restores a connected range, inserts `\n\n${text}\n\n`, dispatches input, and keeps panel DOM untouched.

- [ ] **Step 2: Verify failure**

Run: `node --test test/editor-chat-insert.test.js`

Expected: tracking methods are missing.

- [ ] **Step 3: Implement tracking and insertion**

Register one `selectionchange` listener and clone the most recent editor-owned Range together with `getDocumentIdentity().key`. Reuse existing range-validity and input-notification helpers. If the range is stale, fall back to the current document's final block only when the saved document identity still matches; otherwise return `document-changed`.

- [ ] **Step 4: Run editor regressions**

```powershell
node --test test/editor-chat-insert.test.js test/editor-auto-paste.test.js test/editor-insert-response.test.js test/editor-restore-caret.test.js test/editor-selection-snapshot.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/editor.js test/editor-chat-insert.test.js
git commit -m "feat: insert chat messages at last editor caret"
```

---

### Task 7: Build the Non-Modal Chat Panel

**Files:**
- Create: `src/chat-panel.js`
- Modify: `src/ui.js`
- Create: `test/chat-panel.test.js`

**Interfaces:**
- Consumes: a subscribed `ChatService` and insertion/copy callbacks.
- Produces:

```js
createChatPanel({
  service,
  getDocumentIdentity,
  onInsertAssistant,
  onCopy,
}) => {
  open(options?): Promise<void>,
  close(): void,
  isOpen(): boolean,
  refreshDocument(): Promise<void>,
}
```

- [ ] **Step 1: Write panel behavior tests**

With a focused fake DOM/service, assert:

- opening calls `openDraft` and never selects the newest history item;
- no `session_id` appears before Send;
- session rail can select, rename, delete, and create a blank new draft;
- streaming updates one assistant card;
- completed/stopped assistant cards have Copy and Insert;
- Insert invokes callback but does not call `close`;
- panel Close disposes DOM listeners but does not delete history;
- narrow layout can collapse the history rail.

- [ ] **Step 2: Verify failure**

Run: `node --test test/chat-panel.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement safe rendering**

Build message/session nodes with `createElement` and `textContent`. Use event delegation through `data-action` and stable IDs. Never render assistant Markdown as HTML in the chat panel; insertion sends the raw stored Markdown string to the editor callback.

- [ ] **Step 4: Implement resizable non-modal layout**

Use a fixed right panel with a drag handle and clamped width from 360 to 720 pixels. Use a 160-pixel history rail that can collapse. Do not add a full-screen overlay, so users can click the Typora editor while the panel remains open.

- [ ] **Step 5: Implement document-change refresh**

While open, use a 500 ms identity check plus checks before Send/Insert/session actions. On identity change call `service.stop()`, then `service.openDraft(newIdentity)`. Clear the timer and subscription on Close.

- [ ] **Step 6: Run and commit**

```powershell
node --test test/chat-panel.test.js test/chat-service.test.js
node --check src/chat-panel.js
git add -- src/chat-panel.js src/ui.js test/chat-panel.test.js
git commit -m "feat: add persistent conversation side panel"
```

---

### Task 8: Wire Text and Image Chat into the Plugin

**Files:**
- Modify: `src/plugin.js`
- Modify: `src/api.js`
- Modify: `test/chat-panel.test.js`
- Create: `test/plugin-chat-lifecycle.test.js`

**Interfaces:**
- Consumes: document identity, store, service, panel, `createAiRequest`, image preparation, and editor insertion.
- Produces: one panel instance and one service/store lifecycle per plugin instance.

- [ ] **Step 1: Write lifecycle tests**

Assert plugin load initializes the store, starts caret tracking, and does not create a session. `Ctrl+E` opens a blank text draft. Image context-menu action opens a blank image draft carrying the selected image but creates no session before Send. Plugin unload stops requests, closes panel, stops tracking, and flushes pending store writes.

- [ ] **Step 2: Verify failure**

Run: `node --test test/plugin-chat-lifecycle.test.js`

Expected: current modal Q&A flow does not satisfy lifecycle assertions.

- [ ] **Step 3: Construct chat dependencies on load**

Create the store with the production data directory, initialize it, create service and panel, and call `editorSelection.startCaretTracking()`. If storage initialization fails, keep an in-memory service available and show a clear non-persistent warning.

- [ ] **Step 4: Replace modal Q&A entry points**

Change `openQaFlow()` to `chatPanel.open({ mode: "text" })`. Change `openImageQaFlow(imageElement)` to prepare/store a pending image reference and open `{ mode: "image", imageSource }`. Remove old one-shot stream dialogs only after the new paths pass tests.

- [ ] **Step 5: Wire per-message insertion**

Call `editorSelection.insertMarkdownAtLastCaret(message.content)`. On success show a toast and retain panel/service state. On failure show the reason and retain both panel and message so the user can reposition the caret and retry.

- [ ] **Step 6: Retire legacy global abort usage**

After optimize, Diff, and chat flows all own request handles, remove `legacyActiveRequest` and `abortCurrentRequest()` from `src/api.js`, update imports, and add a regression assertion that concurrent Diff and chat handles do not cancel each other.

- [ ] **Step 7: Run integration tests**

```powershell
node --test test/plugin-chat-lifecycle.test.js test/chat-panel.test.js test/chat-service.test.js test/editor-chat-insert.test.js test/api-streaming.test.js
npm test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add -- src/plugin.js src/api.js test/plugin-chat-lifecycle.test.js test/chat-panel.test.js
git commit -m "feat: enable multi-turn text and image chat"
```

---

### Task 9: Add History Management Controls

**Files:**
- Modify: `src/settings-tab.js`
- Modify: `src/ui.js`
- Create: `test/chat-history-controls.test.js`

**Interfaces:**
- Produces: `confirmAction({ title, message, confirmText }) => Promise<boolean>`.
- Adds: Clear Current File History and Clear All Chat History settings actions.

- [ ] **Step 1: Write destructive-control tests**

Assert cancel performs no store call. Current-file clear is disabled for unsaved documents. Confirmed current clear calls `clearDocument(identity)`. Confirmed global clear calls `clearAll()`. Both refresh an open panel to a blank draft.

- [ ] **Step 2: Verify failure**

Run: `node --test test/chat-history-controls.test.js`

Expected: controls are missing.

- [ ] **Step 3: Implement confirmation and controls**

Use a plugin-styled modal with explicit destructive copy and Cancel as the initially focused action. Do not use a single-click destructive button. Surface deletion failures without pretending success.

- [ ] **Step 4: Run and commit**

```powershell
node --test test/chat-history-controls.test.js test/chat-store.test.js
git add -- src/settings-tab.js src/ui.js test/chat-history-controls.test.js
git commit -m "feat: add chat history privacy controls"
```

---

### Task 10: Release Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `manifest.json`

**Interfaces:**
- Produces: version `1.5.0` metadata and complete user documentation.

- [ ] **Step 1: Update documentation**

Document:

- blank draft behavior and first-send session creation;
- explicit history restoration;
- text and image follow-ups;
- local persistence path and retention limits;
- per-message Copy/Insert behavior;
- history deletion controls;
- unsaved-document limitation;
- shortcut/context-menu behavior.

- [ ] **Step 2: Bump release metadata**

Set `package.json` and `manifest.json` versions to `1.5.0`. Add a Version 1.5.0 history entry summarizing streaming, formula safety, Diff rewrites, and persistent chat sessions.

- [ ] **Step 3: Run complete automated verification**

```powershell
npm test
node --check src/document-identity.js
node --check src/chat-store.js
node --check src/chat-service.js
node --check src/chat-panel.js
node --check src/plugin.js
git diff --check
```

Expected: all pass.

- [ ] **Step 4: Run the real-Typora acceptance matrix**

For both ChatGPT OAuth and OpenAI-compatible providers:

1. Open panel and close it without sending; verify no empty session appears.
2. Send a first question; verify a new session appears and streams.
3. Send two follow-ups; restart Typora; explicitly open the old session and continue it.
4. Create a second session in the same file and verify histories remain separate.
5. Switch files while streaming and verify no late output enters the new file/session.
6. Ask about an image, follow up twice, restart, and continue from history.
7. Insert an older and then a newer assistant message at chosen caret positions; verify the panel remains open.
8. Delete one session and confirm unrelated sessions/assets remain.
9. Clear current-file history, then clear all history with confirmation.

- [ ] **Step 5: Commit the release metadata**

```powershell
git add -- README.md package.json manifest.json
git commit -m "release: prepare AI Edit 1.5.0"
```

- [ ] **Step 6: Final repository review**

Run `git status --short`, `git log --oneline --max-count=20`, and inspect the cumulative diff from the pre-plan base commit.

Expected: only intentionally preserved user-owned changes remain outside commits, all requested behaviors map to passing tests or the recorded manual matrix, and no secrets or generated chat data are tracked.
