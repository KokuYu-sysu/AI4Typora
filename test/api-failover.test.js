import assert from "node:assert/strict";
import test from "node:test";

import { createAiRequest } from "../src/api.js";

function createSseResponse(text) {
  const encoder = new TextEncoder();
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  };
}

function createSettings() {
  return {
    provider: "openai_compat",
    model: "gpt-5.4",
    openaiCompat: {
      baseUrl: "https://primary.example.com",
      apiKey: "primary-key",
      model: "gpt-4o-mini",
    },
    openaiCompatBackups: [
      {
        name: "Secondary",
        baseUrl: "https://backup.example.com",
        apiKey: "backup-key",
        model: "gpt-4o-mini",
      },
    ],
  };
}

test("failover resets partial output and resolves only the successful attempt", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      const encoder = new TextEncoder();
      const payload = [
        { choices: [{ delta: { content: "partial-primary" } }] },
        { error: { message: "primary stream failed" } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(payload));
            controller.close();
          },
        }),
      };
    }
    return createSseResponse("backup-ok");
  };
  const chunks = [];
  const attempts = [];

  try {
    const handle = createAiRequest({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "user" }],
      settings: createSettings(),
      onChunk: (chunk) => chunks.push(chunk),
      onAttemptStart: (attempt) => attempts.push(attempt),
    });

    assert.equal(await handle.promise, "backup-ok");
    assert.deepEqual(chunks, ["partial-primary", "backup-ok"]);
    assert.deepEqual(attempts, [
      { attemptIndex: 0, name: "Primary", resetOutput: false },
      { attemptIndex: 1, name: "Secondary", resetOutput: true },
    ]);
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("abort errors never trigger OpenAI-compatible failover", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    const error = new Error("stopped");
    error.name = "AbortError";
    throw error;
  };
  const attempts = [];

  try {
    const handle = createAiRequest({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "user" }],
      settings: createSettings(),
      onAttemptStart: (attempt) => attempts.push(attempt),
    });

    await assert.rejects(handle.promise, { name: "AbortError" });
    assert.equal(callCount, 1);
    assert.deepEqual(attempts, [
      { attemptIndex: 0, name: "Primary", resetOutput: false },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
