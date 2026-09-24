# Typora Markdown system-prompt rules

Date: 2026-09-24

## Goal

Make every AI-generated response use Typora-compatible Markdown, particularly `$A+B$` for inline math and a display-math block with opening and closing `$$` on separate lines. Preserve existing user-edited prompts and editing safeguards.

## Current behavior

`src/config.js` contains Chinese and English defaults for local optimization, context optimization, text Q&A, document-context Q&A, and image Q&A. Settings may retain a complete `prompts` object, so changing defaults alone would not necessarily affect existing installations. Local optimization and chat both pass a system prompt through `createAiRequest` in `src/api.js`; the latter also handles follow-up turns. Context optimization additionally protects existing formulas with `⟪AI_EDIT_MATH_n⟫` placeholders.

## Design

Use one small, centralized formatter for system prompts. It appends a locale-appropriate Typora Markdown instruction at the shared request boundary unless that exact instruction is already present. Build new default system prompts with the same instruction, so it is visible in settings while avoiding duplication at request time. Existing custom system and user prompts remain byte-for-byte unchanged in storage and in the settings UI. Do not migrate or rewrite saved settings or exported prompt JSON.

The instruction requires generated text, including chat answers, to be paste-ready Typora Markdown source. It specifies:

- Inline math uses paired dollar signs with no whitespace immediately inside them, such as `$A+B$`, not `$ A+B $`.
- Display math uses `$$` on its own opening line, TeX content on following line(s), and `$$` on its own closing line, separated from surrounding paragraphs as a block.
- Use Typora-compatible Markdown for paragraphs, headings, lists, blockquotes, inline code, fenced code blocks, links, and images when such structures are needed. Do not wrap an entire response in an outer Markdown code fence.
- When revising source text, preserve existing formula content and delimiters, math placeholders, code, and meaningful Markdown structure unless the user explicitly requests a change. The existing requirement that each context-rewrite placeholder appear exactly once in original order remains authoritative.

This is a prompt-level output constraint, not a Markdown parser or output rewriter. It does not change the provider payload schema, streaming, Diff replacement, selection capture, or chat persistence. User instructions still determine the answer's substance, while the format instruction determines its Markdown representation. If a saved custom prompt conflicts with Typora formatting, the appended instruction states the plugin's output-format requirement without altering the saved text.

Typora's official math reference defines `$...$` inline math and `$$` display blocks. Its default inline-math parser does not accept spaces directly after the opening `$` or before the closing `$`; rendering inline math also depends on enabling Inline Math in Typora preferences. The plugin will not change that preference.

## Verification

Run only focused tests. Check Chinese and English defaults across all five modes, preserved custom prompts, no duplicated suffix, and the effective system prompt in both ChatGPT OAuth and OpenAI Compatible request payloads. Verify that context-rewrite placeholder instructions remain present. No full test suite or live model call is required for this text-only change.

## Sources

- [Typora Math and Academic Functions](https://support.typora.io/Math/)
- [Typora Markdown Reference](https://support.typora.io/Markdown-Reference/)
