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
    openaiCompatPreferredConnection: "backup_1",
    openaiCompatFailoverEnabled: true,
    openaiCompatBackups: [
      {
        name: "DeepSeek",
        baseUrl: "https://deepseek.example.com",
        apiKey: "deepseek-key",
        model: "deepseek-chat",
      },
      {
        name: "Backup2",
        baseUrl: "https://backup2.example.com",
        apiKey: "backup2-key",
        model: "gpt-4o-mini",
      },
    ],
  };
}

test("createAiRequest keeps preferred connection ordering and normalizes a text message", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return createSseResponse("preferred-ok");
  };

  try {
    const result = await createAiRequest({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "user" }],
      settings: createSettings(),
    }).promise;
    assert.equal(result, "preferred-ok");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith("https://deepseek.example.com/chat/completions"));
    assert.deepEqual(calls[0].body.messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAiRequest normalizes one multimodal user message", async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return createSseResponse("image-ok");
  };

  try {
    const result = await createAiRequest({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "describe", imageInput: "data:image/png;base64,AAA=" }],
      settings: createSettings(),
    }).promise;
    assert.equal(result, "image-ok");
    assert.deepEqual(body.messages, [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent request handles abort independently", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (_url, options) => new Promise((resolve, reject) => {
    const request = { signal: options.signal, resolve, reject };
    requests.push(request);
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  let diffHandle;
  let chatHandle;

  try {
    diffHandle = createAiRequest({ systemPrompt: "sys", messages: [{ role: "user", content: "diff" }], settings: createSettings() });
    chatHandle = createAiRequest({ systemPrompt: "sys", messages: [{ role: "user", content: "chat" }], settings: createSettings() });
    assert.equal(requests.length, 2);

    const diffRejected = assert.rejects(diffHandle.promise, { name: "AbortError" });
    diffHandle.abort();
    await diffRejected;
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
    requests[1].resolve(createSseResponse("chat-ok"));
    assert.equal(await chatHandle.promise, "chat-ok");
  } finally {
    diffHandle?.abort();
    chatHandle?.abort();
    await Promise.allSettled([diffHandle?.promise, chatHandle?.promise].filter(Boolean));
    globalThis.fetch = originalFetch;
  }
});
