const FORMAT_RULES = Object.freeze({
  zh: "输出必须是可直接粘贴到 Typora 的 Markdown 源文本。行内公式使用 $A+B$ 形式，紧邻 $ 内侧不得有空格。独立段落公式须将起止 $$ 各放在单独一行，例如：\n$$\nA+B\n$$\n按需使用 Typora 兼容的段落、标题、列表、> 引用、反引号包围的行内代码、围栏代码块、链接和图片语法；不要给整段回答套一层 Markdown 代码块。润色时保留原文公式内容及定界符、代码和有意义的 Markdown 结构，除非用户明确要求修改；不得改写 ⟪AI_EDIT_MATH_n⟫ 占位符。",
  en: "Output paste-ready Typora Markdown source. Use $A+B$ for inline math, with no spaces immediately inside the dollar delimiters. For a standalone display equation, place opening and closing $$ on separate lines, for example:\n$$\nA+B\n$$\nUse Typora-compatible paragraphs, headings, lists, > blockquotes, backtick-delimited inline code, fenced code blocks, links, and images when needed; do not wrap the entire response in an outer Markdown code fence. When revising, preserve existing formula content and delimiters, code, and meaningful Markdown structure unless the user explicitly requests a change; do not rewrite ⟪AI_EDIT_MATH_n⟫ placeholders.",
});

export function isChineseLocale() {
  const language = typeof navigator === "undefined"
    ? "en"
    : navigator.language || navigator.languages?.[0] || "en";
  return /^zh/i.test(language);
}

export function withTyporaFormatRules(systemPrompt, isChinese = isChineseLocale()) {
  const base = String(systemPrompt ?? "");
  if (Object.values(FORMAT_RULES).some((rule) => base.includes(rule))) {
    return base;
  }
  const rule = isChinese ? FORMAT_RULES.zh : FORMAT_RULES.en;
  return base ? `${base}\n\n${rule}` : rule;
}
