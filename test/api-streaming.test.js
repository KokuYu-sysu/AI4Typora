import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import * as api from "../src/api.js";

const { parseCodexSse, parseOpenAiSse } = api;
globalThis.require = createRequire(import.meta.url);

test("createAiRequest returns a synchronous request handle", () => {
  assert.equal(typeof api.createAiRequest, "function");

  const handle = api.createAiRequest({
    systemPrompt: "system",
    messages: [],
    settings: { provider: "openai_compat" },
  });

  assert.ok(handle.promise instanceof Promise);
  assert.equal(typeof handle.abort, "function");
  void handle.promise.catch(() => {});
  handle.abort();
  handle.abort();
});

test("OpenAI-compatible requests preserve normalized multi-turn messages", async () => {
  const originalFetch = globalThis.fetch;
  let requestOptions;
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`;
    return createChunkedSseResponse([new TextEncoder().encode(payload)]);
  };

  try {
    const handle = api.createAiRequest({
      systemPrompt: "system rules",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "look here", imageInput: "data:image/png;base64,AAA=" },
      ],
      settings: {
        provider: "openai_compat",
        openaiCompat: {
          baseUrl: "https://primary.example.com/",
          apiKey: "key",
          model: "model",
        },
      },
    });

    assert.equal(await handle.promise, "ok");
    assert.deepEqual(JSON.parse(requestOptions.body).messages, [
      { role: "system", content: "system rules" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      {
        role: "user",
        content: [
          { type: "text", text: "look here" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ChatGPT OAuth requests preserve normalized multi-turn input", async () => {
  const originalFetch = globalThis.fetch;
  const tokenPath = path.resolve("test", `.tmp-api-streaming-token-${process.pid}.json`);
  fs.writeFileSync(tokenPath, JSON.stringify({
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
    account_id: "account-id",
  }));
  let requestOptions;
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    const payload = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "oauth-ok" })}\n\n`;
    return createChunkedSseResponse([new TextEncoder().encode(payload)]);
  };

  try {
    const handle = api.createAiRequest({
      systemPrompt: "system rules",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "look here", imageInput: "https://example.com/image.png" },
      ],
      settings: {
        provider: "chatgpt_oauth",
        model: "gpt-5.4",
        oauthTokenPath: tokenPath,
      },
    });

    assert.equal(await handle.promise, "oauth-ok");
    const body = JSON.parse(requestOptions.body);
    assert.equal(body.instructions, "system rules");
    assert.deepEqual(body.input, [
      { role: "user", content: [{ type: "input_text", text: "first question" }] },
      { role: "assistant", content: [{ type: "input_text", text: "first answer" }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: "look here" },
          { type: "input_image", image_url: "https://example.com/image.png" },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tokenPath, { force: true });
  }
});

test("ChatGPT OAuth snapshots messages before awaiting token resolution", async () => {
  const originalFetch = globalThis.fetch;
  const tokenPath = path.resolve("test", `.tmp-api-snapshot-token-${process.pid}.json`);
  fs.writeFileSync(tokenPath, JSON.stringify({
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
    account_id: "account-id",
  }));
  let requestOptions;
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    const payload = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "snapshot-ok" })}\n\n`;
    return createChunkedSseResponse([new TextEncoder().encode(payload)]);
  };
  const firstMessage = {
    role: "user",
    content: "original question",
    imageInput: "https://example.com/original.png",
  };
  const secondMessage = { role: "assistant", content: "original answer" };
  const messages = [firstMessage, secondMessage];

  try {
    const handle = api.createAiRequest({
      systemPrompt: "system rules",
      messages,
      settings: {
        provider: "chatgpt_oauth",
        model: "gpt-5.4",
        oauthTokenPath: tokenPath,
      },
    });

    firstMessage.role = "assistant";
    firstMessage.content = "mutated question";
    firstMessage.imageInput = "https://example.com/mutated.png";
    messages[1] = { role: "user", content: "replacement" };
    messages.push({ role: "user", content: "late addition" });

    assert.equal(await handle.promise, "snapshot-ok");
    assert.deepEqual(JSON.parse(requestOptions.body).input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "original question" },
          { type: "input_image", image_url: "https://example.com/original.png" },
        ],
      },
      { role: "assistant", content: [{ type: "input_text", text: "original answer" }] },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tokenPath, { force: true });
  }
});

test("simultaneous request handles abort independently", async () => {
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = (_url, options) => new Promise((resolve, reject) => {
    const request = { signal: options.signal, resolve, reject };
    pending.push(request);
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const settings = {
    provider: "openai_compat",
    openaiCompat: {
      baseUrl: "https://primary.example.com",
      apiKey: "key",
      model: "model",
    },
  };

  try {
    const first = api.createAiRequest({ systemPrompt: "sys", messages: [], settings });
    const second = api.createAiRequest({ systemPrompt: "sys", messages: [], settings });
    assert.equal(pending.length, 2);
    assert.notEqual(pending[0].signal, pending[1].signal);

    const firstRejected = assert.rejects(first.promise, { name: "AbortError" });
    first.abort();
    first.abort();
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].signal.aborted, false);

    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: "still-running" } }] })}\n\n`;
    pending[1].resolve(createChunkedSseResponse([new TextEncoder().encode(payload)]));
    assert.equal(await second.promise, "still-running");
    await firstRejected;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid normalized messages reject before fetch or failover", async (t) => {
  const cases = [
    { name: "null item", message: null, field: /messages\[0\]/ },
    { name: "system role", message: { role: "system", content: "text" }, field: /messages\[0\]\.role/ },
    { name: "unknown role", message: { role: "tool", content: "text" }, field: /messages\[0\]\.role/ },
    { name: "missing content", message: { role: "user" }, field: /messages\[0\]\.content/ },
    { name: "non-string content", message: { role: "user", content: 42 }, field: /messages\[0\]\.content/ },
    {
      name: "non-string imageInput",
      message: { role: "user", content: "text", imageInput: 42 },
      field: /messages\[0\]\.imageInput/,
    },
    {
      name: "empty imageInput",
      message: { role: "user", content: "text", imageInput: "" },
      field: /messages\[0\]\.imageInput/,
    },
    {
      name: "assistant imageInput",
      message: { role: "assistant", content: "text", imageInput: "https://example.com/image.png" },
      field: /messages\[0\]\.imageInput/,
    },
  ];

  for (const invalidCase of cases) {
    await t.test(invalidCase.name, async () => {
      const originalFetch = globalThis.fetch;
      let fetchCount = 0;
      const attempts = [];
      globalThis.fetch = async () => {
        fetchCount += 1;
        const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: "unexpected" } }] })}\n\n`;
        return createChunkedSseResponse([new TextEncoder().encode(payload)]);
      };

      try {
        const handle = api.createAiRequest({
          systemPrompt: "sys",
          messages: [invalidCase.message],
          settings: {
            provider: "openai_compat",
            openaiCompat: {
              baseUrl: "https://primary.example.com",
              apiKey: "primary-key",
              model: "model",
            },
            openaiCompatBackups: [{
              baseUrl: "https://backup.example.com",
              apiKey: "backup-key",
              model: "model",
            }],
          },
          onAttemptStart: (attempt) => attempts.push(attempt),
        });

        await assert.rejects(handle.promise, (error) => {
          assert.ok(error instanceof TypeError);
          assert.match(error.message, invalidCase.field);
          return true;
        });
        assert.equal(fetchCount, 0);
        assert.deepEqual(attempts, []);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

function createChunkedSseResponse(chunks) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  };
}

function fragmentUtf8(text, chunkSizes) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const chunks = [];
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= bytes.length) {
      break;
    }
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) {
    chunks.push(bytes.slice(offset));
  }
  return chunks;
}

function oneByteUtf8Chunks(text) {
  return Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte));
}

function createTrackedReaderResponse(chunks) {
  let index = 0;
  const state = { cancelCalls: 0, releaseCalls: 0 };
  const reader = {
    async read() {
      if (index < chunks.length) {
        const value = chunks[index];
        index += 1;
        return { done: false, value };
      }
      return { done: true };
    },
    async cancel() {
      state.cancelCalls += 1;
    },
    releaseLock() {
      state.releaseCalls += 1;
    },
  };
  return {
    response: { body: { getReader: () => reader } },
    state,
  };
}

test("Codex SSE preserves fragmented UTF-8, framing, data lines, and chunk order", async () => {
  const payload = [
    ": keepalive\r\n",
    "\r\n",
    "data: {\"type\":\"response.output_text.delta\",\r\n",
    "data: \"delta\":\"你\"}\r\n",
    "\r\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"😀\"}\n",
    "\n",
    "data: [DONE]",
  ].join("");
  const received = [];
  const chunks = oneByteUtf8Chunks(payload);

  assert.ok(chunks.every((chunk) => chunk.byteLength === 1), "must split every UTF-8 byte");

  const output = await parseCodexSse(
    createChunkedSseResponse(chunks),
    (chunk) => received.push(chunk),
  );

  assert.equal(output, "你😀");
  assert.deepEqual(received, ["你", "😀"]);
});

test("OpenAI-compatible SSE preserves fragmented UTF-8, framing, data lines, and chunk order", async () => {
  const payload = [
    ": keepalive\n",
    "\n",
    "data: {\"choices\":[{\"delta\":\r\n",
    "data: {\"content\":\"你\"}}]}\r\n",
    "\r\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"😀\"}}]}\n",
    "\n",
    "data: [DONE]",
  ].join("");
  const received = [];
  const chunks = oneByteUtf8Chunks(payload);

  assert.ok(chunks.every((chunk) => chunk.byteLength === 1), "must split every UTF-8 byte");

  const output = await parseOpenAiSse(
    createChunkedSseResponse(chunks),
    (chunk) => received.push(chunk),
  );

  assert.equal(output, "你😀");
  assert.deepEqual(received, ["你", "😀"]);
});

test("SSE parsers process a final unframed data event", async () => {
  const codexPayload = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "final" })}`;
  const openAiPayload = `data: ${JSON.stringify({ choices: [{ delta: { content: "final" } }] })}`;

  assert.equal(
    await parseCodexSse(createChunkedSseResponse(fragmentUtf8(codexPayload, [1, 2, 1]))),
    "final",
  );
  assert.equal(
    await parseOpenAiSse(createChunkedSseResponse(fragmentUtf8(openAiPayload, [1, 2, 1]))),
    "final",
  );
});

test("OpenAI-compatible SSE parses a sizable one-byte-fragmented event", async () => {
  const content = "x".repeat(20 * 1024);
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const received = [];

  const output = await parseOpenAiSse(
    createChunkedSseResponse(oneByteUtf8Chunks(payload)),
    (chunk) => received.push(chunk),
  );

  assert.equal(output, content);
  assert.deepEqual(received, [content]);
});

test("SSE reader cancels and releases a reader after a malformed event", async () => {
  const encoder = new TextEncoder();
  const tracked = createTrackedReaderResponse([encoder.encode("data: {bad}\n\n")]);

  await assert.rejects(
    () => parseOpenAiSse(tracked.response),
    /OpenAI-compatible SSE JSON parse failed/,
  );
  assert.equal(tracked.state.cancelCalls, 1);
  assert.equal(tracked.state.releaseCalls, 1);
});

test("SSE reader releases without cancellation after normal EOF", async () => {
  const encoder = new TextEncoder();
  const tracked = createTrackedReaderResponse([
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "complete" } }] })}\n\n`),
  ]);

  assert.equal(await parseOpenAiSse(tracked.response), "complete");
  assert.equal(tracked.state.cancelCalls, 0);
  assert.equal(tracked.state.releaseCalls, 1);
});

test("SSE reader cancels and releases a reader after an onChunk callback error", async () => {
  const encoder = new TextEncoder();
  const tracked = createTrackedReaderResponse([
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "chunk" } }] })}\n\n`),
  ]);

  await assert.rejects(
    () => parseOpenAiSse(tracked.response, () => {
      throw new Error("onChunk failed");
    }),
    /onChunk failed/,
  );
  assert.equal(tracked.state.cancelCalls, 1);
  assert.equal(tracked.state.releaseCalls, 1);
});

test("SSE parser flushes decoder residue before reporting malformed JSON", async () => {
  const OriginalTextDecoder = globalThis.TextDecoder;
  class DeferredTextDecoder {
    decode(value) {
      return value ? "data: " : "{bad}\n\n";
    }
  }
  globalThis.TextDecoder = DeferredTextDecoder;

  try {
    await assert.rejects(
      () => parseOpenAiSse(createChunkedSseResponse([Uint8Array.of(1)])),
      /OpenAI-compatible SSE JSON parse failed/,
    );
  } finally {
    globalThis.TextDecoder = OriginalTextDecoder;
  }
});

test("SSE parsers ignore final blank data events", async () => {
  const encoder = new TextEncoder();
  assert.equal(
    await parseCodexSse(createChunkedSseResponse([encoder.encode("data:")])),
    "",
  );
  assert.equal(
    await parseOpenAiSse(createChunkedSseResponse([encoder.encode("data:")])),
    "",
  );
});

test("SSE parsers report malformed provider JSON descriptively", async () => {
  await assert.rejects(
    () => parseCodexSse(createChunkedSseResponse([new TextEncoder().encode("data: {bad}\n\n")])),
    /Codex SSE JSON parse failed/,
  );
  await assert.rejects(
    () => parseOpenAiSse(createChunkedSseResponse([new TextEncoder().encode("data: {bad}\n\n")])),
    /OpenAI-compatible SSE JSON parse failed/,
  );
});

test("SSE parsers surface provider error messages", async () => {
  const encoder = new TextEncoder();
  await assert.rejects(
    () => parseCodexSse(createChunkedSseResponse([
      encoder.encode(`data: ${JSON.stringify({
        type: "response.failed",
        response: { error: { message: "Codex quota exceeded" } },
      })}\n\n`),
    ])),
    /Codex quota exceeded/,
  );
  await assert.rejects(
    () => parseOpenAiSse(createChunkedSseResponse([
      encoder.encode(`data: ${JSON.stringify({ error: { message: "Compat quota exceeded" } })}\n\n`),
    ])),
    /Compat quota exceeded/,
  );
});
