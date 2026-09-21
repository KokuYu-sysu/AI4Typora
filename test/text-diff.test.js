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

test("an unchanged multiline display formula stays whole inside one operation", () => {
  const formula = "$$\nA + B\n$$";
  const operations = assertReconstructable(
    `Old wording before ${formula} after.`,
    `New wording before ${formula} after.`,
    { atomicValues: [formula] },
  );

  assert.equal(
    operations.filter(({ text }) => text.includes(formula)).length,
    1,
  );
  assert.equal(
    operations
      .filter(({ text }) => text.includes("A + B"))
      .map(({ text }) => text.includes(formula))
      .every(Boolean),
    true,
  );
});

test("changed multiline display formulas are complete delete and insert operations", () => {
  const beforeFormula = "$$\nA + B\n$$";
  const afterFormula = "$$\nC + D\n$$";
  const operations = assertReconstructable(
    `value ${beforeFormula} end`,
    `value ${afterFormula} end`,
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

test("an explicit atomic range does not make an equal value atomic elsewhere", () => {
  const before = "A + B\nA + B";
  const after = "C + D\nC + D";
  const operations = assertReconstructable(before, after, {
    atomicRanges: {
      before: [{ start: 0, end: 5 }],
      after: [{ start: 0, end: 5 }],
    },
  });

  assert.ok(
    operations.some(
      ({ type, text }) => type === "delete" && text === "A + B",
    ),
  );
  assert.ok(
    operations.some(
      ({ type, text }) => type === "insert" && text === "C + D",
    ),
  );
  assert.ok(
    operations.some(
      ({ type, text }) => type === "delete" && (text === "A" || text === "B"),
    ),
    "the second occurrence should still receive word-level refinement",
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

test("atomic value lookup scales with occurrences instead of candidate matches", () => {
  const values = Array.from(
    { length: 300 },
    (_, index) => `value-${String(index).padStart(3, "0")}`,
  );
  const text = values.join(" ");
  const originalIndexOf = String.prototype.indexOf;
  let calls = 0;

  String.prototype.indexOf = function (...args) {
    calls += 1;
    return originalIndexOf.apply(this, args);
  };
  try {
    assertReconstructable(text, text, { atomicValues: values });
  } finally {
    String.prototype.indexOf = originalIndexOf;
  }

  assert.ok(calls <= values.length * 6, `expected bounded lookups, got ${calls}`);
});

test("diff options reject invalid atomic ranges and matrix limits", () => {
  for (const ranges of [
    [{ start: -1, end: 1 }],
    [{ start: 1, end: 1 }],
    [{ start: 0, end: 4 }],
    [{ start: 0, end: 2 }, { start: 1, end: 3 }],
  ]) {
    assert.throws(
      () => buildTextDiff("abc", "abc", { atomicRanges: ranges }),
      RangeError,
    );
  }
  for (const maxMatrixCells of [-1, 1.5, Number.NaN, "4"]) {
    assert.throws(
      () => buildTextDiff("abc", "abc", { maxMatrixCells }),
      RangeError,
    );
  }
});

test("reconstructDiff rejects an unknown side", () => {
  assert.throws(
    () => reconstructDiff([{ type: "equal", text: "x" }], "middle"),
    /side/i,
  );
});
