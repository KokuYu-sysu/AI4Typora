import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = {
  [Symbol.for("typora-plugin-core@v2")]: {
    Plugin: class {},
    PluginSettings: class {},
    SettingTab: class {},
    Notice: class {},
  },
};

const { runRewriteAttempt } = await import("../src/plugin.js");

function deferredRequest() {
  let resolve;
  let reject;
  const handle = {
    aborted: false,
    abort() { this.aborted = true; },
    promise: new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }),
  };
  return { handle, resolve, reject };
}

function fakeDialog() {
  return {
    events: [],
    beginGeneration() { this.events.push(["begin"]); },
    setStreamingText(text) { this.events.push(["stream", text]); },
    complete(result) { this.events.push(["complete", result]); },
    fail(message) { this.events.push(["fail", message]); },
  };
}

const settings = {
  prompts: {
    optimize_with_context: { system: "editor system", user: "unused" },
  },
};

const input = Object.freeze({
  documentId: "doc_a",
  snapshot: Object.freeze({ text: "Before $A$" }),
  selectedText: "Before $A$",
  documentText: "Full document",
  extraPrompt: "Be concise",
  promptKey: "optimize_with_context",
  systemPrompt: "editor system",
  userPrompt: "Be concise\n\nRewrite ⟪AI_EDIT_MATH_0⟫ using Full document",
  mathEntries: Object.freeze([
    Object.freeze({ token: "⟪AI_EDIT_MATH_0⟫", source: "$A$", start: 7, end: 10 }),
  ]),
});

test("regeneration aborts the old request and ignores its late output", async () => {
  const requests = [];
  const calls = [];
  const createRequest = (options) => {
    calls.push(options);
    const request = deferredRequest();
    requests.push(request);
    return request.handle;
  };
  const dialog = fakeDialog();
  let generation = 0;
  let activeRequest = null;

  function attempt() {
    const attemptGeneration = ++generation;
    return runRewriteAttempt({
      input,
      settings,
      dialog,
      createRequest,
      previousRequest: activeRequest,
      onRequest(request) { activeRequest = request; },
      isCurrent: () => generation === attemptGeneration,
      validateReplacement: () => ({ ok: true }),
    });
  }

  const first = attempt();
  calls[0].onChunk("first partial");
  settings.prompts.optimize_with_context.system = "mutated system";
  settings.prompts.optimize_with_context.user = "mutated user prompt";
  const second = attempt();
  assert.equal(requests[0].handle.aborted, true);
  calls[0].onChunk(" late first");
  calls[1].onAttemptStart({ resetOutput: true });
  calls[1].onChunk(`Second ⟪AI_EDIT_MATH_0⟫`);
  requests[1].resolve(`Second ⟪AI_EDIT_MATH_0⟫`);
  requests[0].resolve(`Late ⟪AI_EDIT_MATH_0⟫`);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "stopped");
  assert.deepEqual(secondResult, {
    status: "complete",
    candidateText: "Second $A$",
    replaceAllowed: true,
  });
  assert.equal(calls[0].messages[0].content, calls[1].messages[0].content);
  assert.match(calls[1].messages[0].content, /Rewrite .* using Full document/);
  assert.equal(calls[0].systemPrompt, calls[1].systemPrompt);
  assert.equal(calls[1].systemPrompt, "editor system");
  assert.equal(dialog.events.some((event) => event[1] === "first partial late first"), false);
  assert.deepEqual(dialog.events.at(-1), ["complete", {
    candidateText: "Second $A$",
    replaceAllowed: true,
    validationMessage: "",
  }]);
});

test("invalid formula or stale selection completes as view-only", async () => {
  for (const fixture of [
    {
      result: "Changed without placeholder",
      validation: { ok: true },
      message: /Missing math placeholder/,
    },
    {
      result: "Changed ⟪AI_EDIT_MATH_0⟫",
      validation: { ok: false, reason: "selection-changed" },
      message: /selection changed/i,
    },
  ]) {
    const request = deferredRequest();
    const dialog = fakeDialog();
    const attempt = runRewriteAttempt({
      input,
      settings,
      dialog,
      createRequest: () => request.handle,
      validateReplacement: () => fixture.validation,
    });
    request.resolve(fixture.result);
    const result = await attempt;

    assert.equal(result.status, "complete");
    assert.equal(result.replaceAllowed, false);
    const completion = dialog.events.at(-1)[1];
    assert.equal(completion.replaceAllowed, false);
    assert.match(completion.validationMessage, fixture.message);
  }
});
