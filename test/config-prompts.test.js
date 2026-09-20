import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  createDefaultPrompts,
  mergeSettings,
} from "../src/config.js";

const identityTerms = {
  chinese: ["资深语言学专家", "专业编辑"],
  english: ["senior linguistics expert", "professional editor"],
};

for (const [locale, isChinese] of [["Chinese", true], ["English", false]]) {
  const prompts = createDefaultPrompts(isChinese);
  const terms = identityTerms[isChinese ? "chinese" : "english"];

  for (const mode of ["optimize", "optimize_with_context", "qa", "qa_with_context", "image_qa"]) {
    assert.ok(
      terms.every((term) => prompts[mode].system.includes(term)),
      `${locale} ${mode} system prompt should identify the linguist-editor role`,
    );
  }
}

const chinese = createDefaultPrompts(true);
const english = createDefaultPrompts(false);

assert.match(chinese.optimize_with_context.system, /⟪AI_EDIT_MATH_n⟫.*原样保留.*恰好出现一次.*原始顺序/s);
assert.match(english.optimize_with_context.system, /preserve every ⟪AI_EDIT_MATH_n⟫ placeholder exactly once and in its original order/i);
for (const prompts of [chinese, english]) {
  assert.match(prompts.optimize_with_context.user, /⟪AI_EDIT_MATH_n⟫/);
  assert.match(prompts.optimize.user, /\{selection\}/);
  assert.match(prompts.optimize_with_context.user, /\{document\}/);
  assert.match(prompts.optimize_with_context.user, /\{selection\}/);
  assert.match(prompts.qa.user, /\{question\}/);
  assert.match(prompts.qa_with_context.user, /\{document\}/);
  assert.match(prompts.qa_with_context.user, /\{question\}/);
  assert.match(prompts.image_qa.user, /\{question\}/);
}

assert.equal(DEFAULT_SETTINGS.prompts.optimize.system, createDefaultPrompts().optimize.system);

const merged = mergeSettings({
  prompts: {
    optimize: { system: "custom system" },
  },
});
assert.equal(merged.prompts.optimize.system, "custom system");
assert.equal(merged.prompts.optimize.user, DEFAULT_SETTINGS.prompts.optimize.user);
assert.equal(merged.prompts.qa.system, DEFAULT_SETTINGS.prompts.qa.system);

console.log("config prompts tests passed");
