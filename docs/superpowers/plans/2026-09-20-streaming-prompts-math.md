# Streaming, Prompts, and Math Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide robust per-request streaming for both providers, establish the senior linguist/editor default identity, and preserve selected Markdown/LaTeX formulas byte-for-byte during context-aware rewriting.

**Architecture:** `src/api.js` exposes a provider-neutral request handle that accepts message history and owns its abort controller. `src/math-protection.js` is a pure scanner/restorer used by the context rewrite flow. Existing UI remains in place for this phase, with a small value-replacement addition so streamed placeholder previews can be restored incrementally.

**Tech Stack:** JavaScript ES modules, Fetch/ReadableStream SSE, Node.js 22 built-in test runner, Typora Community Plugin runtime.

## Global Constraints

- Preserve the existing uncommitted changes in `src/editor.js`, `src/plugin.js`, `src/ui.js`, and the three untracked editor tests.
- Keep the no-build ES-module distribution model.
- Do not add Python, TypeScript, a test framework, or a runtime dependency.
- Continue supporting ChatGPT OAuth and OpenAI-compatible providers, including configured failover.
- Existing customized prompts must not be overwritten during upgrade.

## File Map

- Modify `src/api.js`: normalized messages, request-scoped cancellation, resilient SSE, and compatibility wrappers.
- Modify `src/config.js`: new Chinese and English default prompt identity and formula rules.
- Create `src/math-protection.js`: pure math scanner, sentinel validation, preview restoration, and exact restoration.
- Modify `src/ui.js`: allow a stream dialog to replace its displayed value and control replacement eligibility.
- Modify `src/plugin.js`: own the active rewrite request and integrate formula protection into context rewriting.
- Create `test/api-streaming.test.js`, `test/math-protection.test.js`, `test/config-prompts.test.js`, and `test/context-rewrite-math.test.js`.
- Modify `package.json`: add a repeatable test command.

---

### Task 1: Establish a Repeatable Test Command

**Files:**
- Modify: `package.json`
- Test: all existing `test/*.test.js`

**Interfaces:**
- Produces: `npm test` running every test with Node's built-in test runner.

- [ ] **Step 1: Record the dirty-tree baseline**

Run `git status --short`. Expected: the pre-existing editor/plugin/UI changes and editor tests are visible. Save the output in implementation notes and do not stage those files until a task intentionally modifies and reviews them.

- [ ] **Step 2: Add the test script**

```json
{
  "scripts": {
    "build": "echo AI Edit plugin does not require a build step",
    "test": "node --test test/*.test.js"
  }
}
```

- [ ] **Step 3: Run the baseline suite**

Run: `npm test`

Expected: all existing tests pass. If a dirty-tree test fails, diagnose it without reverting the user's changes and record the baseline failure.

- [ ] **Step 4: Commit**

```powershell
git add -- package.json
git commit -m "test: add unified node test command"
```

---

### Task 2: Make SSE Parsing Robust and Testable

**Files:**
- Modify: `src/api.js`
- Create: `test/api-streaming.test.js`

**Interfaces:**
- Produces: exported `parseCodexSse(response, onChunk)` and `parseOpenAiSse(response, onChunk)` returning complete text.
- Produces: parser behavior that flushes `TextDecoder` and processes a final buffered event.

- [ ] **Step 1: Write failing fragmented-stream tests**

Create a response helper that emits caller-supplied byte chunks and assert behavior equivalent to:

```js
const chunks = splitUtf8AtEveryBoundary(
  'data: {"type":"response.output_text.delta","delta":"你"}\r\n\r\n' +
  'data: {"type":"response.output_text.delta","delta":"好"}'
);
const seen = [];
assert.equal(await parseCodexSse(createResponse(chunks), x => seen.push(x)), "你好");
assert.deepEqual(seen, ["你", "好"]);
```

Add equivalent OpenAI coverage, `[DONE]`, comments, malformed JSON with a descriptive error, explicit provider error events, and a final event without a trailing separator.

- [ ] **Step 2: Verify the new test fails**

Run: `node --test test/api-streaming.test.js`

Expected: at least the CRLF or final-buffer assertion fails against the current parser.

- [ ] **Step 3: Extract a shared SSE frame iterator**

Implement:

```js
async function* readSseData(response) {
  // Decode streaming UTF-8, normalize CRLF framing, emit joined data lines,
  // and process the final non-empty frame after reader completion.
}
```

Keep provider-specific JSON interpretation in the two exported parser functions. Ignore `[DONE]`; throw an `Error` containing the provider's message for explicit error events.

- [ ] **Step 4: Run focused regressions**

Run: `node --test test/api-streaming.test.js test/api-failover.test.js test/api-preferred-connection.test.js`

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/api.js test/api-streaming.test.js
git commit -m "fix: harden provider SSE parsing"
```

---

### Task 3: Introduce Request-Scoped Message Streaming

**Files:**
- Modify: `src/api.js`
- Modify: `test/api-streaming.test.js`
- Modify: `test/api-failover.test.js`
- Modify: `test/api-preferred-connection.test.js`

**Interfaces:**
- Produces:

```js
createAiRequest({
  systemPrompt,
  messages,
  settings,
  onChunk,
  onAttemptStart,
}) => {
  promise: Promise<string>,
  abort: () => void,
}
```

- `messages` items are `{ role: "user" | "assistant", content: string, imageInput?: string }`.
- `onAttemptStart({ attemptIndex, name, resetOutput })` fires before each compatible-provider attempt.
- Compatibility wrappers `callAi` and `callAiWithImage` remain until later plans are complete.

- [ ] **Step 1: Write failing request-shape and isolation tests**

Assert that a two-turn message array becomes this compatible-provider body:

```js
[
  { role: "system", content: "system" },
  { role: "user", content: "first" },
  { role: "assistant", content: "answer" },
  { role: "user", content: "follow-up" }
]
```

Assert equivalent Responses API input for ChatGPT OAuth. Create two simultaneous handles, abort one, and verify the other signal remains active. Simulate primary output followed by failure and assert backup invokes `onAttemptStart` with `resetOutput: true` and produces only backup final text.

- [ ] **Step 2: Verify failure**

Run: `node --test test/api-streaming.test.js test/api-failover.test.js`

Expected: `createAiRequest` is missing.

- [ ] **Step 3: Implement the request handle**

```js
export function createAiRequest(options) {
  const controller = new AbortController();
  return {
    abort: () => controller.abort(),
    promise: dispatchAiRequest(options, controller.signal),
  };
}
```

Pass `signal` through every provider/failover function. Track emitted text per attempt. Buffer each attempt's final result separately while forwarding chunks live. Before backup chunks, call `onAttemptStart({ resetOutput: true, ... })` if the previous attempt emitted text.

- [ ] **Step 4: Preserve old call sites temporarily**

Implement `callAi` and `callAiWithImage` as adapters that create one normalized user message, assign a `legacyActiveRequest`, await its promise, and clear it in `finally`. Keep `abortCurrentRequest()` delegating only to that legacy handle until all plugin flows own their handles.

- [ ] **Step 5: Run API tests**

Run: `node --test test/api-streaming.test.js test/api-failover.test.js test/api-preferred-connection.test.js test/image-input.test.js`

Expected: all pass and no test observes shared cancellation between new handles.

- [ ] **Step 6: Commit**

```powershell
git add -- src/api.js test/api-streaming.test.js test/api-failover.test.js test/api-preferred-connection.test.js
git commit -m "refactor: add request-scoped AI streaming"
```

---

### Task 4: Update the Default Linguist-Editor Prompts

**Files:**
- Modify: `src/config.js`
- Create: `test/config-prompts.test.js`

**Interfaces:**
- Produces: new defaults through `DEFAULT_SETTINGS.prompts`.
- Preserves: stored custom prompt fields in `mergeSettings(raw)`.

- [ ] **Step 1: Write prompt identity tests**

Export `createDefaultPrompts` for locale-independent tests. Assert Chinese defaults contain `语言学专家` and `资深编辑`, English defaults contain `senior linguistics expert` and `professional editor`, and context rewrite explicitly requires exact placeholder preservation.

Also assert:

```js
const merged = mergeSettings({
  prompts: { optimize: { system: "my custom system" } }
});
assert.equal(merged.prompts.optimize.system, "my custom system");
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/config-prompts.test.js`

Expected: the new identity assertions fail.

- [ ] **Step 3: Replace Chinese and English defaults**

Use mode-specific variants of:

```text
You are a senior linguistics expert and professional editor with deep knowledge
of grammar, semantics, pragmatics, register, terminology consistency, and
cross-language expression. Preserve the author's meaning and factual claims.
```

For context rewrite add: `Preserve every ⟪AI_EDIT_MATH_n⟫ placeholder exactly once and in the original order.` Keep `{selection}`, `{document}`, and `{question}` variables unchanged.

- [ ] **Step 4: Run regressions**

Run: `node --test test/config-prompts.test.js test/prompt-export.test.js`

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add -- src/config.js test/config-prompts.test.js
git commit -m "feat: adopt linguist editor default prompts"
```

---

### Task 5: Build Deterministic Math Protection

**Files:**
- Create: `src/math-protection.js`
- Create: `test/math-protection.test.js`

**Interfaces:**
- Produces:

```js
protectMath(text) => {
  protectedText: string,
  entries: Array<{ token: string, source: string, start: number, end: number }>
}

restoreMathPreview(text, entries) => string

restoreMath(text, entries) =>
  | { ok: true, text: string }
  | { ok: false, text: string, error: string }
```

- Supported math: `$$...$$`, `$...$`, `\(...\)`, `\[...\]`.
- Excluded regions: fenced code, inline code, escaped delimiters.

- [ ] **Step 1: Write scanner tests**

```js
const source = "Before $A$ and $$ B + C $$ after.";
const protectedValue = protectMath(source);
assert.equal(
  restoreMath(protectedValue.protectedText, protectedValue.entries).text,
  source,
);
```

Add multiline display math, adjacent formulas, `\$100`, inline code, fenced code, unmatched delimiters, and formulas containing escapes.

- [ ] **Step 2: Write corruption tests**

For deletion, duplication, reordering, and mutation of a sentinel, assert `ok === false` and a message naming the affected token or order problem.

- [ ] **Step 3: Verify module absence**

Run: `node --test test/math-protection.test.js`

Expected: module-not-found failure.

- [ ] **Step 4: Implement a single-pass scanner**

Track fenced-code, inline-code, escape, and delimiter state. Prefer `$$` before `$`. Do not normalize input or line endings. Validation counts exact occurrences and compares their first-occurrence order with `entries`. `restoreMathPreview` replaces complete known tokens without claiming validity.

- [ ] **Step 5: Run tests**

Run: `node --test test/math-protection.test.js`

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add -- src/math-protection.js test/math-protection.test.js
git commit -m "feat: protect markdown math during rewrites"
```

---

### Task 6: Integrate Protected Math with Context Rewrite

**Files:**
- Modify: `src/ui.js`
- Modify: `src/plugin.js`
- Create: `test/context-rewrite-math.test.js`

**Interfaces:**
- Consumes: `createAiRequest`, `protectMath`, `restoreMathPreview`, and `restoreMath`.
- Extends stream dialog with `setValue(value)` and `showCompleted({ replaceAllowed, validationMessage, ... })`.
- Produces: replacement only from a complete, formula-valid context rewrite.

- [ ] **Step 1: Write a failing flow test**

Extract and export:

```js
prepareContextRewrite(selectedText, promptTemplate, documentText) => {
  userPrompt,
  mathEntries,
}
```

Assert formulas become sentinels in the replaceable selection section and final restoration is byte-identical.

- [ ] **Step 2: Verify failure**

Run: `node --test test/context-rewrite-math.test.js`

Expected: helper is missing.

- [ ] **Step 3: Add stream-dialog value replacement**

```js
setValue(value) {
  output.value = value;
  output.scrollTop = output.scrollHeight;
}
```

When `replaceAllowed === false`, omit or disable confirm and render `validationMessage`. Preserve the user's current `onClose` changes.

- [ ] **Step 4: Move rewrite flow to a request handle**

Protect only the selected passage in context mode. Accumulate raw streamed output, render `restoreMathPreview(rawOutput, entries)`, and call `restoreMath` after completion. Wire Stop to the local request handle. On `onAttemptStart({ resetOutput: true })`, clear raw output and the dialog before accepting backup chunks.

- [ ] **Step 5: Enforce validation**

For invalid restoration, show the candidate and validation message without Replace. For valid restoration, pass only restored text to `restoreAndReplace`.

- [ ] **Step 6: Run focused and full tests**

```powershell
node --test test/context-rewrite-math.test.js test/math-protection.test.js test/api-streaming.test.js
npm test
```

Expected: all pass.

- [ ] **Step 7: Manually verify in Typora**

For each provider, verify plain streaming, exact restoration of `$A$` and `$$ B + C $$`, disabled replacement after Stop, and clean output reset after failover.

- [ ] **Step 8: Commit**

```powershell
git add -- src/ui.js src/plugin.js test/context-rewrite-math.test.js
git commit -m "feat: stream formula-safe context rewrites"
```

---

### Task 7: Document and Verify Phase 1

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: streaming, linguist/editor defaults, supported formula delimiters, and invalid-result blocking.

- [ ] **Step 1: Update README**

Document that streaming applies to both providers and context rewrite protects `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` outside code spans/fences.

- [ ] **Step 2: Run verification**

```powershell
npm test
node --check src/api.js
node --check src/math-protection.js
node --check src/plugin.js
node --check src/ui.js
git diff --check
```

Expected: all tests/checks pass and no whitespace errors appear.

- [ ] **Step 3: Commit documentation**

```powershell
git add -- README.md
git commit -m "docs: describe streaming and math preservation"
```

- [ ] **Step 4: Review phase state**

Run `git log --oneline --max-count=8` and `git status --short`.

Expected: phase 1 commits are present and no user-owned change was discarded.
