import assert from "node:assert/strict";
import test from "node:test";

import {
  protectMath,
  restoreMath,
  restoreMathPreview,
} from "../src/math-protection.js";

test("protects inline and display math and restores the exact input", () => {
  const input = "Before $A$ and $$ B + C $$ after.";
  const result = protectMath(input);

  assert.equal(
    result.protectedText,
    "Before ⟪AI_EDIT_MATH_0⟫ and ⟪AI_EDIT_MATH_1⟫ after.",
  );
  assert.deepEqual(
    result.entries.map(({ token, source }) => ({ token, source })),
    [
      { token: "⟪AI_EDIT_MATH_0⟫", source: "$A$" },
      { token: "⟪AI_EDIT_MATH_1⟫", source: "$$ B + C $$" },
    ],
  );
  assert.deepEqual(restoreMath(result.protectedText, result.entries), {
    ok: true,
    text: input,
  });
});

test("protects multiline display forms without changing CRLF line endings", () => {
  const input = "top\r\n$$a\r\n+b$$\r\nmid\r\n\\[c\r\n+d\\]\r\nbottom";
  const result = protectMath(input);

  assert.equal(
    result.protectedText,
    "top\r\n⟪AI_EDIT_MATH_0⟫\r\nmid\r\n⟪AI_EDIT_MATH_1⟫\r\nbottom",
  );
  assert.deepEqual(
    result.entries.map(({ source }) => source),
    ["$$a\r\n+b$$", "\\[c\r\n+d\\]"],
  );
  assert.deepEqual(restoreMath(result.protectedText, result.entries), {
    ok: true,
    text: input,
  });
});

test("protects parenthesized, adjacent, and consistently empty math forms", () => {
  const input = "\\(x\\)\\[y\\]$z$\\(\\)$$$$";
  const result = protectMath(input);

  assert.equal(
    result.protectedText,
    "⟪AI_EDIT_MATH_0⟫⟪AI_EDIT_MATH_1⟫⟪AI_EDIT_MATH_2⟫⟪AI_EDIT_MATH_3⟫⟪AI_EDIT_MATH_4⟫",
  );
  assert.deepEqual(
    result.entries.map(({ source }) => source),
    ["\\(x\\)", "\\[y\\]", "$z$", "\\(\\)", "$$$$"],
  );
});

test("ignores escaped dollars using odd and even preceding backslash counts", () => {
  const input = String.raw`price \$100; even \\$x$; odd \\\$no; then $ok$`;
  const result = protectMath(input);

  assert.equal(
    result.protectedText,
    String.raw`price \$100; even \\⟪AI_EDIT_MATH_0⟫; odd \\\$no; then ⟪AI_EDIT_MATH_1⟫`,
  );
  assert.deepEqual(
    result.entries.map(({ source }) => source),
    ["$x$", "$ok$"],
  );
});

test("does not let inline math consume a double-dollar delimiter", () => {
  const result = protectMath("$a$$b$");

  assert.deepEqual(result, { protectedText: "$a$$b$", entries: [] });
});

test("ignores math-looking text in inline code spans with matching backtick runs", () => {
  const input = "`$no$` ``code `$stillNo$` code`` $yes$";
  const result = protectMath(input);

  assert.equal(
    result.protectedText,
    "`$no$` ``code `$stillNo$` code`` ⟪AI_EDIT_MATH_0⟫",
  );
  assert.deepEqual(result.entries.map(({ source }) => source), ["$yes$"]);
});

test("does not reinterpret part of an unmatched backtick run as code", () => {
  const result = protectMath("`` $yes$ `");

  assert.equal(result.protectedText, "`` ⟪AI_EDIT_MATH_0⟫ `");
  assert.deepEqual(result.entries.map(({ source }) => source), ["$yes$"]);
});

test("ignores math-looking text in backtick and tilde fenced code blocks", () => {
  const input =
    "```js\r\n$no$\r\n```\r\n~~~\n$$also no$$\n~~~~\n$yes$";
  const result = protectMath(input);

  assert.equal(
    result.protectedText,
    "```js\r\n$no$\r\n```\r\n~~~\n$$also no$$\n~~~~\n⟪AI_EDIT_MATH_0⟫",
  );
  assert.deepEqual(result.entries.map(({ source }) => source), ["$yes$"]);
});

test("leaves unmatched opening delimiters byte-for-byte unchanged", () => {
  const input = "inline $open\ndisplay $$open\nparen \\(open\nbracket \\[open";

  assert.deepEqual(protectMath(input), {
    protectedText: input,
    entries: [],
  });
});

test("does not allow parenthesized inline math to cross a newline", () => {
  const input = "\\(first line\r\nsecond line\\)";

  assert.deepEqual(protectMath(input), {
    protectedText: input,
    entries: [],
  });
});

test("allows escaped characters inside formulas", () => {
  const input = String.raw`$a\$b$ \(\alpha + \{x\}\) \[c\\d\]`;
  const result = protectMath(input);

  assert.deepEqual(
    result.entries.map(({ source }) => source),
    [String.raw`$a\$b$`, String.raw`\(\alpha + \{x\}\)`, String.raw`\[c\\d\]`],
  );
  assert.deepEqual(restoreMath(result.protectedText, result.entries), {
    ok: true,
    text: input,
  });
});

test("records exact inclusive-exclusive source offsets", () => {
  const input = "ab $x$ cd \\[y\\] ef";
  const { entries } = protectMath(input);

  assert.deepEqual(entries, [
    { token: "⟪AI_EDIT_MATH_0⟫", source: "$x$", start: 3, end: 6 },
    { token: "⟪AI_EDIT_MATH_1⟫", source: "\\[y\\]", start: 10, end: 15 },
  ]);
  for (const entry of entries) {
    assert.equal(input.slice(entry.start, entry.end), entry.source);
  }
});

test("preview restores complete known tokens and preserves partial or unknown tokens", () => {
  const { entries } = protectMath("$a$ then $$b$$");
  const response =
    "A ⟪AI_EDIT_MATH_0⟫ B ⟪AI_EDIT_MATH_1 C ⟪AI_EDIT_MATH_99⟫";

  assert.equal(
    restoreMathPreview(response, entries),
    "A $a$ B ⟪AI_EDIT_MATH_1 C ⟪AI_EDIT_MATH_99⟫",
  );
});

test("preview replacement does not cascade into token text inside a formula", () => {
  const { protectedText, entries } = protectMath(
    "$literal ⟪AI_EDIT_MATH_1⟫$ then $second$",
  );

  assert.equal(
    restoreMathPreview(protectedText, entries),
    "$literal ⟪AI_EDIT_MATH_1⟫$ then $second$",
  );
});

test("round-trips an original literal that collides with the first math token", () => {
  const input = "prefix ⟪AI_EDIT_MATH_0⟫ and $x$";
  const result = protectMath(input);
  const entriesSnapshot = structuredClone(result.entries);
  Object.freeze(result.entries);
  for (const entry of result.entries) Object.freeze(entry);

  assert.equal(
    result.protectedText.split("⟪AI_EDIT_MATH_0⟫").length - 1,
    1,
  );
  assert.equal(restoreMathPreview(result.protectedText, result.entries), input);
  assert.deepEqual(restoreMath(result.protectedText, result.entries), {
    ok: true,
    text: input,
  });
  assert.deepEqual(result.entries, entriesSnapshot);
});

test("round-trips repeated and differently indexed literal sentinels around formulas", () => {
  const input =
    "⟪AI_EDIT_MATH_0⟫ before $a$ ⟪AI_EDIT_MATH_0⟫ between ⟪AI_EDIT_MATH_1⟫ and ⟪AI_EDIT_MATH_2⟫ $b$ after ⟪AI_EDIT_MATH_99⟫";
  const result = protectMath(input);

  assert.deepEqual(
    result.entries.map(({ token, source }) => ({ token, source })),
    [
      { token: "⟪AI_EDIT_MATH_3⟫", source: "⟪AI_EDIT_MATH_0⟫" },
      { token: "⟪AI_EDIT_MATH_0⟫", source: "$a$" },
      { token: "⟪AI_EDIT_MATH_4⟫", source: "⟪AI_EDIT_MATH_0⟫" },
      { token: "⟪AI_EDIT_MATH_5⟫", source: "⟪AI_EDIT_MATH_1⟫" },
      { token: "⟪AI_EDIT_MATH_6⟫", source: "⟪AI_EDIT_MATH_2⟫" },
      { token: "⟪AI_EDIT_MATH_1⟫", source: "$b$" },
      { token: "⟪AI_EDIT_MATH_7⟫", source: "⟪AI_EDIT_MATH_99⟫" },
    ],
  );
  assert.equal(restoreMathPreview(result.protectedText, result.entries), input);
  assert.deepEqual(restoreMath(result.protectedText, result.entries), {
    ok: true,
    text: input,
  });
});

test("preview restoration does not cascade into protected literal sentinels", () => {
  const input = "⟪AI_EDIT_MATH_0⟫ then $x$ then ⟪AI_EDIT_MATH_1⟫";
  const { protectedText, entries } = protectMath(input);

  assert.equal(restoreMathPreview(protectedText, entries), input);
});

test("literal-only sentinel text round-trips with no formula entries", () => {
  const input = "literal ⟪AI_EDIT_MATH_0⟫ and ⟪AI_EDIT_MATH_custom⟫";
  const result = protectMath(input);

  assert.deepEqual(result.entries, [
    {
      token: "⟪AI_EDIT_MATH_1⟫",
      source: "⟪AI_EDIT_MATH_0⟫",
      start: 8,
      end: 24,
    },
    {
      token: "⟪AI_EDIT_MATH_2⟫",
      source: "⟪AI_EDIT_MATH_custom⟫",
      start: 29,
      end: 50,
    },
  ]);
  assert.equal(restoreMathPreview(result.protectedText, result.entries), input);
  assert.deepEqual(restoreMath(result.protectedText, result.entries), {
    ok: true,
    text: input,
  });
});

test("copied and serialized collision entries retain everything needed to restore", () => {
  const input = "prefix ⟪AI_EDIT_MATH_0⟫ and $x$ then ⟪AI_EDIT_MATH_1⟫";
  const { protectedText, entries } = protectMath(input);
  const copies = [
    ["spread", [...entries]],
    ["slice", entries.slice()],
    ["JSON", JSON.parse(JSON.stringify(entries))],
  ];
  if (typeof structuredClone === "function") {
    copies.push(["structuredClone", structuredClone(entries)]);
  }

  for (const [label, copy] of copies) {
    assert.equal(
      restoreMathPreview(protectedText, copy),
      input,
      `${label} preview`,
    );
    assert.deepEqual(
      restoreMath(protectedText, copy),
      { ok: true, text: input },
      `${label} strict restore`,
    );
  }
});

test("entries use only ordinary array elements and documented object fields", () => {
  const { entries } = protectMath("⟪AI_EDIT_MATH_0⟫ and $x$");

  assert.deepEqual(Object.getOwnPropertySymbols(entries), []);
  assert.deepEqual(
    Object.getOwnPropertyNames(entries),
    [...entries.keys()].map(String).concat("length"),
  );
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["end", "source", "start", "token"]);
  }
});

test("strict restore still rejects a newly introduced sentinel after escaping originals", () => {
  const input = "literal ⟪AI_EDIT_MATH_0⟫ and $x$";
  const { protectedText, entries } = protectMath(input);
  const response = `${protectedText} plus ⟪AI_EDIT_MATH_88⟫`;
  const restored = restoreMath(response, entries);

  assert.equal(restored.ok, false);
  assert.equal(restored.text, response);
  assert.match(restored.error, /⟪AI_EDIT_MATH_88⟫|unexpected|sentinel/i);
});

test("strict restore rejects a deleted token", () => {
  const { entries } = protectMath("$a$ then $b$");
  const text = "⟪AI_EDIT_MATH_0⟫ then gone";
  const restored = restoreMath(text, entries);

  assert.equal(restored.ok, false);
  assert.equal(restored.text, text);
  assert.match(restored.error, /⟪AI_EDIT_MATH_1⟫|missing/i);
});

test("strict restore rejects a duplicated token", () => {
  const { entries } = protectMath("$a$");
  const text = "⟪AI_EDIT_MATH_0⟫ and ⟪AI_EDIT_MATH_0⟫";
  const restored = restoreMath(text, entries);

  assert.equal(restored.ok, false);
  assert.equal(restored.text, text);
  assert.match(restored.error, /⟪AI_EDIT_MATH_0⟫|duplicate|twice/i);
});

test("strict restore rejects reordered tokens", () => {
  const { entries } = protectMath("$a$ then $b$");
  const text = "⟪AI_EDIT_MATH_1⟫ then ⟪AI_EDIT_MATH_0⟫";
  const restored = restoreMath(text, entries);

  assert.equal(restored.ok, false);
  assert.equal(restored.text, text);
  assert.match(restored.error, /order/i);
});

test("strict restore rejects mutated and unexpected sentinel-like tokens", () => {
  const { entries } = protectMath("$a$");
  const mutated = "value ⟪AI_EDIT_MATH_0X⟫";
  const unexpected = "⟪AI_EDIT_MATH_0⟫ plus ⟪AI_EDIT_MATH_88⟫";

  const mutatedResult = restoreMath(mutated, entries);
  assert.equal(mutatedResult.ok, false);
  assert.equal(mutatedResult.text, mutated);
  assert.match(mutatedResult.error, /mutat|sentinel|placeholder/i);

  const unexpectedResult = restoreMath(unexpected, entries);
  assert.equal(unexpectedResult.ok, false);
  assert.equal(unexpectedResult.text, unexpected);
  assert.match(unexpectedResult.error, /⟪AI_EDIT_MATH_88⟫|unexpected|sentinel/i);
});

test("no-entry inputs pass through all APIs unchanged", () => {
  const input = "plain `code` text\r\nwith no formulas";
  const protectedResult = protectMath(input);
  const frozenEntries = Object.freeze(protectedResult.entries);

  assert.deepEqual(protectedResult, { protectedText: input, entries: [] });
  assert.equal(restoreMathPreview(input, frozenEntries), input);
  assert.deepEqual(restoreMath(input, frozenEntries), { ok: true, text: input });
  assert.deepEqual(frozenEntries, []);
});

test("restore helpers do not mutate entries", () => {
  const result = protectMath("$a$ and $b$");
  const snapshot = structuredClone(result.entries);
  Object.freeze(result.entries);
  for (const entry of result.entries) Object.freeze(entry);

  restoreMathPreview(result.protectedText, result.entries);
  assert.deepEqual(restoreMath(result.protectedText, result.entries), {
    ok: true,
    text: "$a$ and $b$",
  });
  assert.deepEqual(result.entries, snapshot);
});
