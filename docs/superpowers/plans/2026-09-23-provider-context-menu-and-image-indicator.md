# Provider, Context Menu, Shortcut Hint, and Image Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider settings unambiguous, restore Typora's native selected-text right-click menu, present shortcuts line by line, and show whether an image is pending or attached to a sent chat message.

**Architecture:** Keep the current plugin boundaries: settings presentation in `settings-tab.js`, editor context-menu routing in `plugin.js`, floating hint and styles in `ui.js`, chat state in `chat-service.js`, and chat rendering in `chat-panel.js`. Use existing configuration and message shapes; add one small pending-image removal service operation. Do not change the API adapter, Diff Replace rules, or saved-history schema.

**Tech Stack:** JavaScript ES modules, Typora community plugin API, Node.js `node:test` and `node:assert/strict`, DOM fakes used by this repository.

**Reference spec:** `docs/superpowers/specs/2026-09-23-provider-context-menu-and-image-indicator-design.md`

---

## Execution notes and file map

- The workspace already has uncommitted changes in several `src/` and `test/` files from earlier requested fixes. Preserve them. Before each task, record `git status --short`; stage and commit only the new task's hunks after checking `git diff --cached`. If a new hunk cannot be separated from existing work, leave it uncommitted and report that explicitly rather than committing unrelated changes. The design document was separately committed as `c23bb39`.
- `src/settings-tab.js`: provider-specific group visibility and Advanced compatible connections UI; keep field values in the DOM when a group is hidden.
- `src/plugin.js`: only image right-click interception; selected text right-click falls through to Typora.
- `src/ui.js`: individual shortcut rows and chat attachment indicator styles.
- `src/chat-service.js`: pending image removal and accurate pending-to-persisted transition.
- `src/chat-panel.js`: composer indicator, remove action, and sent-message image marker.
- `test/settings-provider-visibility.test.js`, `test/plugin-chat-lifecycle.test.js`, `test/shortcut-guide.test.js`, `test/chat-service.test.js`, `test/chat-panel.test.js`: focused behavior tests. Extend existing DOM fakes instead of adding a DOM dependency.
- `src/config.js`, API request code, Diff code, and saved-history format are not to be changed for this request.

Run a single named test file (or two closely related files) after each task. At the end run only those changed test files together, plus one Typora smoke check. No broad test sweep is required unless a focused failure suggests it.

### Task 1: Provider-aware settings without losing values

**Files:**
- Modify: `src/settings-tab.js`
- Create: `test/settings-provider-visibility.test.js`

- [ ] **Step 1: Write a focused failing test for visibility and preservation.**

  Add a small DOM-node fake in the new test and import a named `applyProviderVisibility(container, provider)` helper from `src/settings-tab.js`. Give the fake container `#ai-edit-chatgpt-settings` and `#ai-edit-compatible-settings` nodes with `hidden` properties. Assert `openai_compat` sets ChatGPT `hidden === true`, compatible `hidden === false`, and `chatgpt` reverses them. Give both groups input values and assert switching twice does not alter either value. Trigger Save after editing ChatGPT, compatible primary, and backup fields, then switching providers; assert the saved object retains all edited values, including fields hidden at Save time. Assert the compatible group template has three free-text primary inputs and a `<details id="ai-edit-compatible-advanced">` element without `open`; backup fields remain inside it. The DOM fake may expose/render this markup by intercepting `innerHTML`, following existing test patterns, or the test can assert the generated markup and separately exercise the helper. Avoid snapshotting the entire settings page.

  Representative assertions:

  ```js
  applyProviderVisibility(container, "openai_compat");
  assert.equal(chatgpt.hidden, true);
  assert.equal(compatible.hidden, false);
  assert.equal(compatibleModel.value, "deepseek-v4.1-flash");
  applyProviderVisibility(container, "chatgpt");
  assert.equal(compatibleModel.value, "deepseek-v4.1-flash");
  ```

- [ ] **Step 2: Run the new test and see the expected failure.**

  Run: `node --test test/settings-provider-visibility.test.js`  
  Expected: FAIL because the helper/group wrappers do not yet exist.

- [ ] **Step 3: Implement only the provider presentation change.**

  In `src/settings-tab.js`, wrap ChatGPT model and OAuth elements in one `div#ai-edit-chatgpt-settings`, and primary compatible fields plus failover in `div#ai-edit-compatible-settings`. Do not put shared prompts/export/history in either group. Replace the failover card's outer wrapper with `<details id="ai-edit-compatible-advanced" class="ai-edit-setting-card">` and a `<summary>Advanced: compatible connections and failover</summary>`; keep the existing toggle, active-connection selector, and both backup triplets inside. Do not add `open` so it starts collapsed. The three primary compatible fields remain `type="text"`, `type="password"`, `type="text"`; the Model ID has no select or value rewriting.

  Add and export the narrow helper:

  ```js
  export function applyProviderVisibility(container, provider) {
    container.querySelector("#ai-edit-chatgpt-settings").hidden = provider !== "chatgpt";
    container.querySelector("#ai-edit-compatible-settings").hidden = provider !== "openai_compat";
  }
  ```

  Call it once after `innerHTML` is assigned and on `#ai-edit-provider` `change`, using that select's current value. Do not rerender on provider change: rerendering would discard unsaved edits. Keep hidden fields mounted so the existing Save handler retains ChatGPT and backup values. Keep provider-specific model validation as it is. If the test uncovers a hidden-field Save overwrite, adjust the Save handler to preserve its current input values, not defaults.

- [ ] **Step 4: Run the focused test and inspect settings markup.**

  Run: `node --test test/settings-provider-visibility.test.js`  
  Expected: PASS; the Compatible group has the three editable primary fields and collapsed Advanced section, while shared settings remain outside provider groups.

- [ ] **Step 5: Commit only separable task hunks.**

  Check: `git diff -- src/settings-tab.js test/settings-provider-visibility.test.js` and `git diff --cached`. Stage only Task 1 hunks (for example `git add -p -- src/settings-tab.js`; stage the new test by exact path), verify the staged diff, then `git commit -m "feat: clarify provider-specific settings"` if no pre-existing changes are included. Otherwise leave uncommitted and note why.

### Task 2: Native selected-text context menu, image entry retained

**Files:**
- Modify: `src/plugin.js`
- Modify: `test/plugin-chat-lifecycle.test.js`

- [ ] **Step 1: Add two failing context-menu tests.**

  Use the plugin harness already in `test/plugin-chat-lifecycle.test.js`; extend its DOM fake only as needed by the image menu (`getBoundingClientRect`, viewport sizes, style) and stub `editorSelection.getImageElementFromTarget`. For selected text with no image, call `handleContextMenu` and assert neither `preventDefault` nor `stopImmediatePropagation` occurs, no `#ai-edit-context-menu` exists, and no selection/caret capture occurs. For an image target, assert both event methods are called and the menu contains `AI Ask About Image` and `Open Typora Menu`. Keep the existing direct `openImageQaFlow` test.

- [ ] **Step 2: Run the focused test to verify it fails.**

  Run: `node --test test/plugin-chat-lifecycle.test.js`  
  Expected: selected-text test FAILS because the plugin currently intercepts it; image test establishes retained behavior.

- [ ] **Step 3: Remove only the selected-text interception branch.**

  In `handleContextMenu` in `src/plugin.js`, keep the editor-target guard and the entire image branch, then return for non-image targets. Delete the selection text lookup, capture calls, `preventDefault`/`stopImmediatePropagation`, and plugin text menu item construction from this handler. Do not change `handleKeyDown`, `openOptimizeFlow`, or `openQaFlow`.

- [ ] **Step 4: Run the focused test.**

  Run: `node --test test/plugin-chat-lifecycle.test.js`  
  Expected: PASS for both native text-menu fallthrough and image-menu interception, with existing keyboard/chat lifecycle assertions still passing.

- [ ] **Step 5: Commit only separable task hunks.**

  Review and stage only Task 2 changes in `src/plugin.js` and `test/plugin-chat-lifecycle.test.js`, inspect `git diff --cached`, then `git commit -m "fix: restore native text context menu"` if the staged diff excludes earlier unrelated changes. Otherwise leave them uncommitted and report.

### Task 3: Persistent, one-shortcut-per-line hint

**Files:**
- Modify: `src/ui.js`
- Create: `test/shortcut-guide.test.js`

- [ ] **Step 1: Add a failing hint test using a minimal DOM fake.**

  Call `showShortcutGuide("Ctrl+E")`; assert three distinct `.ai-edit-shortcut-guide-row` children carry the conversation, `Ctrl+R`, and `Ctrl+Shift+R` labels in order. Assert the guide remains attached until the close button's click handler runs, then it is removed. Call `closeShortcutGuide()` again to verify unload cleanup is harmless. Test the default `Ctrl+E` text only; existing shortcut formatting is already covered elsewhere.

- [ ] **Step 2: Run the new test to verify it fails.**

  Run: `node --test test/shortcut-guide.test.js`  
  Expected: FAIL because the current hint has one combined text node.

- [ ] **Step 3: Render explicit rows and keep the existing close behavior.**

  Replace the combined `span.textContent` in `showShortcutGuide` with a text container containing three `div.ai-edit-shortcut-guide-row` elements. Use `textContent` for each label. Keep the `×` button, `closeShortcutGuide` event binding, fixed upper-right CSS positioning, and `removeStyles`/unload behavior. Add `.ai-edit-shortcut-guide-text { display: flex; flex-direction: column; gap: 3px; }` in `ensureStyles` so each child is a separate line; do not add a timeout or persistent-dismissal storage.

- [ ] **Step 4: Run the focused test.**

  Run: `node --test test/shortcut-guide.test.js`  
  Expected: PASS; three rows remain until × is clicked.

- [ ] **Step 5: Commit only separable task hunks.**

  Inspect/stage only the hint code and test, then `git commit -m "ui: show shortcut guide on separate lines"` if the staged diff is clean. Preserve unrelated `src/ui.js` modifications.

### Task 4: Pending and sent image status in conversation

**Files:**
- Modify: `src/chat-service.js`
- Modify: `src/chat-panel.js`
- Modify: `src/ui.js`
- Modify: `test/chat-service.test.js`
- Modify: `test/chat-panel.test.js`

- [ ] **Step 1: Add focused failing service tests for the image lifecycle.**

  In `test/chat-service.test.js`, assert that `openDraft(identity, { pendingImage: { source: "C:\\figure.png" } })` exposes `pendingImage` and creates no session; `removePendingImage()` clears it and does not create a session. Add a stored-asset variant asserting exactly one `releaseImageAsset` call. Add a save-failure test by making `appendMessage` reject after `createSession`: `pendingImage` must still be present, the service must report an error, no user message has an `image`, and a second Send must persist an image-bearing user message without making the old pending asset appear sent. Repeat the failure/retry case with an already-stored pending asset and assert it is not released while still pending. Finally assert successful first Send clears `pendingImage` only after the persisted user message has `image`. Use the existing fake store/request helpers and resolve the successful mocked request so no test hangs.

- [ ] **Step 2: Run the focused service test and verify failure.**

  Run: `node --test test/chat-service.test.js`  
  Expected: FAIL at the new removal method and/or save-failure pending-state assertions.

- [ ] **Step 3: Implement the service transition without changing storage shape.**

  Add `async removePendingImage()` to the returned service API. It snapshots `state.pendingImage`, sets it to `null` synchronously so the panel rerenders, then calls existing `releasePending(snapshot)`. If there is none, it does nothing. Use the existing state/navigation guards to avoid a slow release clearing a newer draft.

  In `send`, preserve the original `pendingImage` until `store.appendMessage` succeeds. Prepare `savedImage` whenever a pending image exists, including a retry in an already-created but empty session. Set `activeSession` after `createSession` without clearing `pendingImage`. Construct the user message with the prepared image; only after append succeeds set `{ activeSession: persisted, pendingImage: null }`. Track whether this Send created a new stored asset; if append fails, release only that new asset and leave the original pending source/asset in state for retry. A pre-existing stored pending asset must not be released while it is still pending. On a stale navigation, release newly created assets and do not overwrite the new document's state. Keep the current retry/streaming/history behavior and avoid a second user message after an assistant request failure (that existing path uses `retryMessageId`). The key transition is:

  ```js
  // Before successful append: pendingImage is still visible; no image message exists.
  const persisted = await store.appendMessage(identity, session.id, user);
  imagePersisted = Boolean(user.image);
  if (!current(session.id)) return;
  set({ activeSession: persisted, pendingImage: null, error: null });
  ```

  Preserve the existing release-on-openDraft/openSession/dispose behavior.

- [ ] **Step 4: Run the focused service test.**

  Run: `node --test test/chat-service.test.js`  
  Expected: PASS, including append failure and retry.

- [ ] **Step 5: Add failing panel tests for pending chip, remove action, and sent marker.**

  Extend `fakeService` in `test/chat-panel.test.js` to copy `options.pendingImage` into state, offer `removePendingImage()`, and emit a persisted user message with `image` after a simulated Send. Assert image draft displays an `.ai-edit-chat-pending-image` element near the composer, with a labeled remove button, and still has no active session before Send. Click remove, await the action, and assert it disappears without closing the panel. Reopen image draft, send a question, and assert the pending indicator disappears while the user card has `.ai-edit-chat-image-marker`. A text-only draft/message has neither. Keep the existing streamed assistant and Insert test unchanged.

- [ ] **Step 6: Run the focused panel test and verify failure.**

  Run: `node --test test/chat-panel.test.js`  
  Expected: FAIL because the panel does not render either indicator.

- [ ] **Step 7: Render status from actual state and message data.**

  In `src/chat-panel.js`, create a composer-adjacent container for the pending indicator. In `render`, populate it only for `state.pendingImage`, using text like `Image attached · pending send`; add a `button` with `data-action="remove-image"`, an accessible label such as `Remove attached image`, and route that action to `service.removePendingImage()` through `forCurrentDocument`. For each `message.role === "user" && message.image`, append a small `.ai-edit-chat-image-marker` node with `Image attached`. Do not inspect or expose source paths, data URLs, or image bytes. In `src/ui.js`, add compact chip/marker styles that fit the current sidebar width and keep the textarea usable. Do not introduce thumbnails or automatic sends.

- [ ] **Step 8: Run focused service and panel tests together.**

  Run: `node --test test/chat-service.test.js test/chat-panel.test.js`  
  Expected: PASS for pending/remove/sent/failure/navigation, plus existing streaming, history, and Insert behavior in those files.

- [ ] **Step 9: Commit only separable task hunks.**

  Inspect/stage only Task 4 changes in its five files, verify `git diff --cached`, then `git commit -m "feat: show image attachment status in chat"` if it excludes earlier unrelated work. Otherwise leave these changes uncommitted and report.

## Final focused verification and Typora smoke check

- [ ] Run: `node --test test/settings-provider-visibility.test.js test/plugin-chat-lifecycle.test.js test/shortcut-guide.test.js test/chat-service.test.js test/chat-panel.test.js`  
  Expected: all selected tests PASS. If a changed test reveals a failure elsewhere, expand only to the directly affected test file.
- [ ] Inspect `git diff --check`, `git status --short`, and the staged diff if any; confirm that `src/config.js`, API protocol handling, Diff Replace code, and unrelated changes were not modified by this implementation.
- [ ] In Typora with the installed plugin updated to these changes, open Settings and switch ChatGPT ↔ OpenAI Compatible without saving; confirm primary fields, collapsed Advanced backup fields, and existing values. Select text and right-click (native Typora menu), then right-click an image (AI Ask About Image still shown). Verify the shortcut guide has three lines and × dismisses it. Open image Q&A: pending chip appears before typing; remove works; reopen and Send, then see `Image attached` on the user message. Confirm a normal Q&A remains text-only and saved-document Diff Replace behavior is unchanged.
- [ ] Report exactly what was verified and whether the installed plugin copy was updated. Installing/replacing files outside this workspace requires separate filesystem approval; if unavailable, complete workspace tests and give the user installation/reload steps instead of claiming the live plugin was updated.
