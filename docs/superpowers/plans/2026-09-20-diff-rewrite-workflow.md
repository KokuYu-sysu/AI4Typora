# Diff Rewrite Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain local-rewrite result window with a maintainable Unicode-aware Diff workflow that supports streaming, regeneration, and verified one-click replacement.

**Architecture:** A pure `src/text-diff.js` module computes reconstructable operations without Python or runtime packages. `src/diff-dialog.js` owns only rendering and UI events. `EditorSelectionController` owns immutable selection snapshots and the final stale-target check, while `plugin.js` coordinates requests and regeneration.

**Tech Stack:** JavaScript ES modules, DOM APIs, `Intl.Segmenter` with Unicode fallback, Node.js 22 built-in tests, Typora editor APIs.

## Global Constraints

- Complete `2026-09-20-streaming-prompts-math.md` first.
- Preserve all pre-existing user changes and integrate with the formula-validity result from phase 1.
- Do not add Python, a Diff package, a build step, or a frontend framework.
- Render model text with DOM `textContent`; never interpolate untrusted model output into `innerHTML`.
- Only `src/editor.js` may replace Typora document content.

## File Map

- Create `src/text-diff.js`: tokenization, hierarchical Diff, operation coalescing, and reconstruction.
- Create `src/diff-dialog.js`: streaming state, Diff rendering, validation messages, and action wiring.
- Create `src/document-identity.js`: stable normalized identity for the active Markdown file.
- Modify `src/editor.js`: immutable selection snapshot, freshness check, and snapshot replacement.
- Modify `src/plugin.js`: rewrite-cycle orchestration and regeneration.
- Modify `src/ui.js`: shared style primitives only; do not place Diff behavior here.
- Create `test/text-diff.test.js`, `test/document-identity.test.js`, `test/editor-selection-snapshot.test.js`, and `test/diff-rewrite-flow.test.js`.

---

### Task 1: Define Reconstructable Diff Operations

**Files:**
- Create: `src/text-diff.js`
- Create: `test/text-diff.test.js`

**Interfaces:**
- Produces:

```js
tokenizeForDiff(text, locale) => string[]
buildTextDiff(before, after, options = {}) => Array<{
  type: "equal" | "insert" | "delete",
  text: string,
}>
reconstructDiff(operations, side) => string
```

- `side` is `"before"` or `"after"`.
- Equal and delete operations reconstruct `before`; equal and insert operations reconstruct `after`.

- [ ] **Step 1: Write invariant tests first**

For every fixture, assert:

```js
const operations = buildTextDiff(before, after);
assert.equal(reconstructDiff(operations, "before"), before);
assert.equal(reconstructDiff(operations, "after"), after);
assert.ok(operations.every(op => op.text.length > 0));
assert.ok(operations.every((op, i) => i === 0 || op.type !== operations[i - 1].type));
```

Fixtures must include identical text, empty-to-text, text-to-empty, English word edits, Chinese edits, mixed Chinese/English, punctuation-only changes, whitespace and line-ending changes, emoji/surrogate pairs, and a 5,000-character paragraph.

- [ ] **Step 2: Add formula atomicity tests**

Pass `atomicRanges` or `atomicValues` through options and assert `$A + B$` and `$$ C $$` each appear as one complete operation rather than character-level fragments.

- [ ] **Step 3: Run tests and verify failure**

Run: `node --test test/text-diff.test.js`

Expected: module-not-found failure.

- [ ] **Step 4: Implement tokenization**

Use `Intl.Segmenter(locale, { granularity: "word" })` when available, preserving spaces and punctuation as returned substrings. Fall back to `Array.from(text)` so Unicode code points are not split into UTF-16 halves. Replace atomic ranges with temporary internal tokens before segmentation and expand them afterward.

- [ ] **Step 5: Implement the sequence algorithm**

Implement Myers shortest-edit-script or an equivalently bounded algorithm over arrays. Add a prefix/suffix fast path. Coalesce adjacent operations of the same type. For changed line blocks, refine their delete/insert pair with word tokens; leave unchanged lines as equal operations.

Set a deterministic safety threshold: when `beforeTokens.length * afterTokens.length` exceeds the selected algorithm's safe bound, return one delete plus one insert rather than blocking the UI.

- [ ] **Step 6: Run tests**

Run: `node --test test/text-diff.test.js`

Expected: all reconstruction, Unicode, performance-fallback, and formula tests pass.

- [ ] **Step 7: Commit**

```powershell
git add -- src/text-diff.js test/text-diff.test.js
git commit -m "feat: add unicode aware text diff engine"
```

---

### Task 2: Add Document Identity and Verified Selection Snapshots

**Files:**
- Create: `src/document-identity.js`
- Modify: `src/editor.js`
- Create: `test/document-identity.test.js`
- Create: `test/editor-selection-snapshot.test.js`
- Test: `test/editor-auto-paste.test.js`, `test/editor-insert-response.test.js`, `test/editor-restore-caret.test.js`

**Interfaces:**
- Produces:

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

- Produces:

```js
captureSelectionSnapshot(documentId) => {
  documentId: string,
  text: string,
  range: Range,
}

validateSelectionSnapshot(snapshot, currentDocumentId) =>
  | { ok: true }
  | { ok: false, reason: string }

replaceSelectionSnapshot(snapshot, nextText, currentDocumentId) =>
  | { ok: true }
  | { ok: false, reason: string }
```

- Preserves existing `savedRange`, caret restoration, auto-paste, and editor-input notification behavior.

- [ ] **Step 1: Write document identity tests**

Cover `window.File.filePath`, `window.File.bundle.filePath`, a local `.md` URL fallback, Windows slash/case normalization, non-ASCII paths, stable SHA-256-derived keys, distinct-file keys, and the non-persistable unsaved fallback.

- [ ] **Step 2: Implement document identity**

Use `path.win32` and `crypto.createHash("sha256")` through the safe Node lookup pattern already used in `platform.js`. Prefix keys with `doc_` and retain the normalized path only as metadata.

- [ ] **Step 3: Write failing snapshot tests**

Use focused Range/Selection fakes to cover:

- same document + connected range + unchanged text succeeds;
- different document ID fails;
- disconnected range fails;
- current range text different from snapshot text fails;
- replacement dispatches editor input and clears only the consumed snapshot;
- a failure never calls `document.execCommand("insertText", ...)`.

- [ ] **Step 4: Verify snapshot failure**

Run: `node --test test/document-identity.test.js test/editor-selection-snapshot.test.js`

Expected: snapshot methods are missing.

- [ ] **Step 5: Implement snapshot methods without removing old methods**

Clone the Range at capture. Validation must check `range.startContainer`, connection to `#write`, exact `range.toString()`, and document ID before restoring selection. Return structured failures such as `document-changed`, `range-detached`, and `selection-changed`.

Keep `restoreAndReplace` as a compatibility wrapper until `plugin.js` migrates.

- [ ] **Step 6: Run editor regressions**

Run:

```powershell
node --test test/document-identity.test.js test/editor-selection-snapshot.test.js test/editor-auto-paste.test.js test/editor-insert-response.test.js test/editor-restore-caret.test.js test/editor-image-target.test.js
```

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add -- src/document-identity.js src/editor.js test/document-identity.test.js test/editor-selection-snapshot.test.js
git commit -m "feat: verify rewrite selection snapshots"
```

---

### Task 3: Build the Dedicated Diff Dialog

**Files:**
- Create: `src/diff-dialog.js`
- Modify: `src/ui.js`
- Create: `test/diff-dialog.test.js`

**Interfaces:**
- Consumes: `buildTextDiff(originalText, candidateText, options)`.
- Produces:

```js
createDiffDialog({
  title,
  originalText,
  onStop,
  onRegenerate,
  onReplace,
  onClose,
}) => {
  beginGeneration(): void,
  setStreamingText(text): void,
  complete({ candidateText, replaceAllowed, validationMessage }): void,
  fail(message): void,
  close(reason): void,
}
```

- [ ] **Step 1: Write state-transition tests**

With a minimal fake DOM, assert:

- generating state shows Stop and streamed text;
- complete valid state shows Copy, Regenerate, Close, and Replace;
- complete invalid state shows the validation message and no enabled Replace;
- stopped state preserves text and offers Regenerate/Close without Replace;
- clicking Regenerate does not close the dialog;
- model output is assigned through `textContent` nodes.

- [ ] **Step 2: Verify failure**

Run: `node --test test/diff-dialog.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement semantic rendering**

Create DOM nodes with these class roles:

```text
.ai-edit-diff-equal
.ai-edit-diff-delete
.ai-edit-diff-insert
.ai-edit-diff-collapsed
.ai-edit-diff-validation
```

Use `<del>` for delete and `<ins>` for insert. Collapse long equal operations to bounded leading/trailing context with an expandable control. Keep line breaks with `white-space: pre-wrap`.

- [ ] **Step 4: Add styles without moving unrelated UI**

Append narrowly scoped Diff CSS in `ensureStyles()`. Do not refactor the settings or context-menu styles in this task.

- [ ] **Step 5: Run tests and syntax checks**

Run:

```powershell
node --test test/diff-dialog.test.js test/text-diff.test.js
node --check src/diff-dialog.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add -- src/diff-dialog.js src/ui.js test/diff-dialog.test.js
git commit -m "feat: add local rewrite diff dialog"
```

---

### Task 4: Orchestrate Streaming, Regeneration, and Safe Replacement

**Files:**
- Modify: `src/plugin.js`
- Modify: `src/editor.js`
- Create: `test/diff-rewrite-flow.test.js`

**Interfaces:**
- Consumes: `createAiRequest`, phase-1 math protection, `createDiffDialog`, and selection snapshots.
- Produces: one immutable rewrite input reused by every regeneration:

```js
{
  documentId,
  snapshot,
  selectedText,
  documentText,
  extraPrompt,
  promptKey,
  mathEntries,
}
```

- [ ] **Step 1: Extract a testable rewrite-cycle function**

Create/export from `src/plugin.js` or a focused helper module:

```js
runRewriteAttempt({ input, settings, dialog, createRequest }) => Promise<{
  status: "complete" | "stopped" | "failed",
  candidateText: string,
  replaceAllowed: boolean,
}>
```

Write tests with an injected fake request handle so no network or full Typora DOM is needed.

- [ ] **Step 2: Test regeneration invariants**

Assert two attempts receive identical captured `selectedText`, `documentText`, prompt configuration, and extra instruction. Assert the second attempt resets the dialog before chunks arrive and aborts a still-running first handle.

- [ ] **Step 3: Test replacement safety**

Assert Replace calls `replaceSelectionSnapshot` with the completed restored candidate. When validation returns `selection-changed` or `document-changed`, keep the dialog open, disable Replace, and display a specific explanation.

- [ ] **Step 4: Verify tests fail**

Run: `node --test test/diff-rewrite-flow.test.js`

Expected: rewrite-cycle interface is missing.

- [ ] **Step 5: Replace the old optimize result dialog**

Capture document identity and selection snapshot before opening the additional-instruction prompt. Instantiate one Diff dialog and define an `attempt()` closure over immutable input. Use `setStreamingText` for formula-restored preview. Call `complete` only after the request promise resolves and formula validation succeeds.

- [ ] **Step 6: Implement Stop and Close cleanup**

Stop aborts only the current attempt and moves to stopped state. Close aborts any running attempt, unregisters dialog listeners, and leaves the selection untouched. Repeated Close/Stop must be idempotent.

- [ ] **Step 7: Run all rewrite tests**

```powershell
node --test test/diff-rewrite-flow.test.js test/diff-dialog.test.js test/text-diff.test.js test/context-rewrite-math.test.js test/editor-selection-snapshot.test.js
npm test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add -- src/plugin.js src/editor.js test/diff-rewrite-flow.test.js
git commit -m "feat: add safe regenerable rewrite workflow"
```

---

### Task 5: Manual Typora Acceptance and Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: Diff meanings, Replace/Regenerate/Stop behavior, and stale-selection safety.

- [ ] **Step 1: Run manual local rewrite cases**

For selection-only and full-context modes:

1. Generate an English edit and confirm word-level additions/deletions.
2. Generate a Chinese edit and confirm characters/words are not garbled.
3. Regenerate twice and confirm only the current candidate is replaceable.
4. Edit the original paragraph while generation is running and confirm Replace is rejected.
5. Switch files before completion and confirm Replace is rejected.
6. Stop a response and confirm the partial candidate remains visible but cannot replace.
7. Confirm formulas appear as intact units in Diff.

- [ ] **Step 2: Update README**

Replace the old plain-result instructions with Diff colors, one-click Replace, Regenerate, and safety behavior. Note that Diff is implemented locally in JavaScript and does not require Python.

- [ ] **Step 3: Run final verification**

```powershell
npm test
node --check src/text-diff.js
node --check src/diff-dialog.js
node --check src/editor.js
node --check src/plugin.js
git diff --check
```

Expected: all pass.

- [ ] **Step 4: Commit**

```powershell
git add -- README.md
git commit -m "docs: explain diff rewrite workflow"
```

- [ ] **Step 5: Review phase state**

Run `git status --short` and `git log --oneline --max-count=10`.

Expected: no implementation file is unintentionally unstaged, and no pre-existing user work has been lost.
