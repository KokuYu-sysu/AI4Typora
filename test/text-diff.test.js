import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTextDiff,
  reconstructDiff,
  tokenizeForDiff,
} from "../src/text-diff.js";

function assertReconstructable(before, after, options) {
  const operations = buildTextDiff(before, after, options);

  assert.equal(reconstructDiff(operations, "before"), before);
  assert.equal(reconstructDiff(operations, "after"), after);
  assert.ok(operations.every((operation) => operation.text.length > 0));
  assert.ok(
    operations.every(
      (operation, index) =>
        index === 0 || operation.type !== operations[index - 1].type,
    ),
  );
  return operations;
}

test("diff operations reconstruct representative Unicode text exactly", async (t) => {
  const fixtures = [
    ["", ""],
    ["identical text", "identical text"],
    ["", "new text"],
    ["old text", ""],
    ["The quick brown fox.", "The very quick red fox."],
    ["这是一段需要润色的文字。", "这是一段已经润色好的文字。"],
    ["模型 output 很清楚。", "模型的 output 更清楚。"],
    ["Hello, world!", "Hello: world?"],
    ["first line\r\nsecond  line\n", "first line\nsecond line\nthird\n"],
    ["Keep 👩🏽‍💻 and 😀 here", "Keep 👨‍🔬 and 🎉 here"],
    ["甲".repeat(5_000), `${"甲".repeat(2_500)}乙${"甲".repeat(2_499)}`],
  ];

  for (const [index, fixture] of fixtures.entries()) {
    await t.test(`fixture ${index + 1}`, () => {
      assertReconstructable(...fixture);
    });
  }
});

test("tokenization preserves every code point with and without Intl.Segmenter", () => {
  const input = "中文 English 👩🏽‍💻!\r\n";
  assert.equal(tokenizeForDiff(input, "zh-CN").join(""), input);

  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  Object.defineProperty(Intl, "Segmenter", {
    configurable: true,
    value: undefined,
  });
  try {
    const tokens = tokenizeForDiff("A😀B", "en");
    assert.deepEqual(tokens, ["A", "😀", "B"]);
  } finally {
    Object.defineProperty(Intl, "Segmenter", descriptor);
  }
});

test("formula values remain atomic within refined changes", () => {
  const inline = "$A + B$";
  const display = "$$ C $$";
  const before = `原文 ${inline} and ${display} is clear.`;
  const after = `润色后 ${inline} plus ${display} remains clear.`;
  const operations = assertReconstructable(before, after, {
    atomicValues: [inline, display],
  });

  for (const formula of [inline, display]) {
    const containing = operations.filter(({ text }) => text.includes(formula));
    assert.ok(containing.length > 0, `${formula} should occur in a diff operation`);
    assert.equal(containing.length, 1);
  }
});

test("changed formula values are emitted as complete delete and insert operations", () => {
  const beforeFormula = "$A + B$";
  const afterFormula = "$$ C $$";
  const operations = assertReconstructable(
    `value: ${beforeFormula}.`,
    `value: ${afterFormula}.`,
    { atomicValues: [beforeFormula, afterFormula] },
  );

  assert.ok(
    operations.some(
      ({ type, text }) => type === "delete" && text === beforeFormula,
    ),
  );
  assert.ok(
    operations.some(
      ({ type, text }) => type === "insert" && text === afterFormula,
    ),
  );
});

test("atomic ranges are respected by the tokenizer used for each side", () => {
  const before = "before FORMULA after";
  const after = "before REPLACEMENT after";
  const operations = assertReconstructable(before, after, {
    atomicRanges: {
      before: [{ start: 7, end: 14 }],
      after: [{ start: 7, end: 18 }],
    },
  });

  assert.ok(
    operations.some(
      ({ type, text }) => type === "delete" && text === "FORMULA",
    ),
  );
  assert.ok(
    operations.some(
      ({ type, text }) => type === "insert" && text === "REPLACEMENT",
    ),
  );
});

test("large token matrices use a deterministic delete-insert fallback", () => {
  const before = "a b c d e";
  const after = "1 2 3 4 5";
  const operations = assertReconstructable(before, after, {
    maxMatrixCells: 4,
  });

  assert.deepEqual(operations, [
    { type: "delete", text: before },
    { type: "insert", text: after },
  ]);
});

test("reconstructDiff rejects an unknown side", () => {
  assert.throws(
    () => reconstructDiff([{ type: "equal", text: "x" }], "middle"),
    /side/i,
  );
});
