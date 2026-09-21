import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayMessages } from "../src/chat-service.js";

test("replay keeps visible history, the first image, and newest messages within its budget", () => {
  const messages = [
    { role: "user", content: "image question", status: "complete", image: { assetId: "a".repeat(64) } },
    { role: "assistant", content: "old answer", status: "complete" },
    { role: "user", content: "new question", status: "complete" },
    { role: "assistant", content: "new answer", status: "complete" },
    { role: "assistant", content: "partial", status: "streaming" },
    { role: "assistant", content: "UI error", status: "failed" },
  ];
  const original = JSON.stringify(messages);
  const replay = buildReplayMessages(messages, { maxCharacters: 40, resolvedImageInput: "data:image/png;base64,AA" });
  assert.deepEqual(replay, [
    { role: "user", content: "image question", imageInput: "data:image/png;base64,AA" },
    { role: "user", content: "new question" },
    { role: "assistant", content: "new answer" },
  ]);
  assert.equal(JSON.stringify(messages), original);
});

test("replay permits one newest oversize message instead of an empty request", () => {
  assert.deepEqual(buildReplayMessages([{ role: "user", content: "x".repeat(5), status: "complete" }], { maxCharacters: 1 }), [
    { role: "user", content: "x".repeat(5) },
  ]);
});
