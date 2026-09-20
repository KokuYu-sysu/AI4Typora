import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexSse, parseOpenAiSse } from "../src/api.js";

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
