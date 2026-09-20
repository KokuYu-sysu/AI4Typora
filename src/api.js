import { getFreshToken } from "./platform.js";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
let legacyActiveRequest = null;

export function abortCurrentRequest() {
  if (legacyActiveRequest) {
    legacyActiveRequest.abort();
  }
}

async function* readSseData(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanPosition = 0;
  let dataLines = [];

  function readLine(isFinal) {
    for (let index = scanPosition; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character !== "\r" && character !== "\n") {
        continue;
      }
      if (character === "\r" && index === buffer.length - 1 && !isFinal) {
        scanPosition = index;
        return null;
      }

      const nextIndex = character === "\r" && buffer[index + 1] === "\n"
        ? index + 2
        : index + 1;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(nextIndex);
      scanPosition = 0;
      return line;
    }

    if (isFinal && buffer) {
      const line = buffer;
      buffer = "";
      scanPosition = 0;
      return line;
    }
    scanPosition = buffer.length;
    return null;
  }

  function processLine(line) {
    if (line === "") {
      const data = dataLines.join("\n");
      dataLines = [];
      return data;
    }
    if (line.startsWith(":")) {
      return null;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      dataLines.push(value);
    }
    return null;
  }

  async function* emitCompleteLines(isFinal) {
    while (true) {
      const line = readLine(isFinal);
      if (line === null) {
        break;
      }
      const data = processLine(line);
      if (data !== null && data !== "") {
        yield data;
      }
    }
  }

  let reachedEof = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        reachedEof = true;
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      yield* emitCompleteLines(false);
    }

    buffer += decoder.decode();
    yield* emitCompleteLines(true);
    if (dataLines.length) {
      const data = dataLines.join("\n");
      if (data) {
        yield data;
      }
    }
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original parsing or callback error.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Preserve the original parsing or callback error.
    }
  }
}

function parseSseJson(data, providerName) {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`${providerName} SSE JSON parse failed: ${error.message}`);
  }
}

function getProviderErrorMessage(event, fallback) {
  if (typeof event?.message === "string" && event.message) {
    return event.message;
  }
  if (typeof event?.error === "string" && event.error) {
    return event.error;
  }
  if (typeof event?.error?.message === "string" && event.error.message) {
    return event.error.message;
  }
  if (typeof event?.response?.error?.message === "string" && event.response.error.message) {
    return event.response.error.message;
  }
  return fallback;
}

export async function parseCodexSse(response, onChunk) {
  let result = "";

  for await (const data of readSseData(response)) {
    if (data.trim() === "[DONE]") {
      continue;
    }

    const event = parseSseJson(data, "Codex");
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error(getProviderErrorMessage(event, "Codex request failed."));
    }
    if (event.type === "response.output_text.delta" && event.delta) {
      result += event.delta;
      if (onChunk) {
        onChunk(event.delta);
      }
    }
  }

  return result;
}

export async function parseOpenAiSse(response, onChunk) {
  let result = "";

  for await (const data of readSseData(response)) {
    if (data.trim() === "[DONE]") {
      continue;
    }

    const event = parseSseJson(data, "OpenAI-compatible");
    if (event?.error || event?.type === "error") {
      throw new Error(getProviderErrorMessage(event, "OpenAI-compatible request failed."));
    }
    const delta = event?.choices?.[0]?.delta?.content;
    if (delta) {
      result += delta;
      if (onChunk) {
        onChunk(delta);
      }
    }
  }

  return result;
}

function normalizeCompatConfig(raw, fallbackModel, fallbackName, slot) {
  const baseUrl = String(raw?.baseUrl || "").trim();
  const apiKey = String(raw?.apiKey || "").trim();
  const model = String(raw?.model || fallbackModel || "").trim();
  const name = String(raw?.name || fallbackName || "").trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return {
    slot,
    name: name || baseUrl,
    baseUrl,
    apiKey,
    model,
  };
}

function getCompatCandidates(settings) {
  const candidates = [];
  const primary = normalizeCompatConfig(settings?.openaiCompat || {}, settings?.model, "Primary", "primary");
  if (primary) {
    candidates.push(primary);
  }

  const backups = Array.isArray(settings?.openaiCompatBackups) ? settings.openaiCompatBackups : [];
  for (let i = 0; i < backups.length; i += 1) {
    const candidate = normalizeCompatConfig(backups[i], settings?.model, `Backup ${i + 1}`, `backup_${i + 1}`);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = `${item.baseUrl.toLowerCase()}|${item.apiKey}|${item.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  if (!deduped.length) {
    return deduped;
  }

  const preferred = String(settings?.openaiCompatPreferredConnection || "primary");
  const preferredIndex = deduped.findIndex((item) => item.slot === preferred);
  if (preferredIndex <= 0) {
    return deduped;
  }

  const ordered = [deduped[preferredIndex]];
  for (let i = 0; i < deduped.length; i += 1) {
    if (i !== preferredIndex) {
      ordered.push(deduped[i]);
    }
  }
  return ordered;
}

function toCodexInput(messages) {
  return messages.map((message) => {
    const content = [
      { type: "input_text", text: message.content },
    ];
    if (message.imageInput) {
      content.push({ type: "input_image", image_url: message.imageInput });
    }
    return { role: message.role, content };
  });
}

function toOpenAiMessages(systemPrompt, messages) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((message) => ({
      role: message.role,
      content: message.imageInput
        ? [
          { type: "text", text: message.content },
          { type: "image_url", image_url: { url: message.imageInput } },
        ]
        : message.content,
    })),
  ];
}

async function callChatGptOauthApi(systemPrompt, messages, settings, onChunk, signal) {
  const token = await getFreshToken(settings);
  if (!token) {
    throw new Error("OAuth token unavailable.");
  }
  const response = await fetch(CODEX_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access}`,
      "chatgpt-account-id": token.account_id,
      "OpenAI-Beta": "responses=experimental",
      originator: "typora-plugin-ai-edit",
      "User-Agent": "typora-plugin-ai-edit/0.1.0",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      store: false,
      stream: true,
      instructions: systemPrompt,
      input: toCodexInput(messages),
      include: ["reasoning.encrypted_content"],
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${errorText.slice(0, 200)}`);
  }

  return parseCodexSse(response, onChunk);
}

async function callOpenAiCompatApi(systemPrompt, messages, compat, onChunk, signal) {
  const response = await fetch(`${String(compat.baseUrl).replace(/\/+$/g, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${compat.apiKey}`,
      "Content-Type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: compat.model,
      stream: true,
      messages: toOpenAiMessages(systemPrompt, messages),
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${errorText.slice(0, 200)}`);
  }

  return parseOpenAiSse(response, onChunk);
}

async function callOpenAiCompatApiWithFailover(
  systemPrompt,
  messages,
  settings,
  onChunk,
  onAttemptStart,
  signal,
) {
  const candidates = getCompatCandidates(settings);
  if (!candidates.length) {
    throw new Error("OpenAI compatible API is not configured.");
  }

  const failoverEnabled = settings?.openaiCompatFailoverEnabled !== false;
  const failures = [];
  let previousAttemptEmittedOutput = false;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (onAttemptStart) {
      onAttemptStart({
        attemptIndex: i,
        name: candidate.name,
        resetOutput: previousAttemptEmittedOutput,
      });
    }
    let attemptEmittedOutput = false;
    try {
      return await callOpenAiCompatApi(
        systemPrompt,
        messages,
        candidate,
        (chunk) => {
          attemptEmittedOutput = true;
          if (onChunk) {
            onChunk(chunk);
          }
        },
        signal,
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      previousAttemptEmittedOutput = attemptEmittedOutput;
      failures.push(`${candidate.name}: ${error?.message || "Unknown error"}`);
      if (!failoverEnabled || i === candidates.length - 1) {
        break;
      }
    }
  }

  throw new Error(`All OpenAI compatible connections failed. ${failures.join(" | ")}`.trim());
}

export function createAiRequest({
  systemPrompt,
  messages,
  settings,
  onChunk,
  onAttemptStart,
}) {
  const controller = new AbortController();
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const promise = settings?.provider === "openai_compat"
    ? callOpenAiCompatApiWithFailover(
      systemPrompt,
      normalizedMessages,
      settings,
      onChunk,
      onAttemptStart,
      controller.signal,
    )
    : callChatGptOauthApi(
      systemPrompt,
      normalizedMessages,
      settings,
      onChunk,
      controller.signal,
    );

  return {
    promise,
    abort: () => controller.abort(),
  };
}

export async function callAi(systemPrompt, userPrompt, settings, handlers = {}) {
  const handle = createAiRequest({
    systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    settings,
    onChunk: handlers.onChunk,
    onAttemptStart: handlers.onAttemptStart,
  });
  legacyActiveRequest = handle;
  try {
    return await handle.promise;
  } finally {
    if (legacyActiveRequest === handle) {
      legacyActiveRequest = null;
    }
  }
}

export async function callAiWithImage(systemPrompt, userPrompt, imageInput, settings, handlers = {}) {
  const handle = createAiRequest({
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, imageInput }],
    settings,
    onChunk: handlers.onChunk,
    onAttemptStart: handlers.onAttemptStart,
  });
  legacyActiveRequest = handle;
  try {
    return await handle.promise;
  } finally {
    if (legacyActiveRequest === handle) {
      legacyActiveRequest = null;
    }
  }
}
