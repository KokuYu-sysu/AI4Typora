const localeIsChinese = typeof navigator !== "undefined" && /^zh/i.test(
  (navigator.language || (navigator.languages && navigator.languages[0]) || "en")
);

export const CHATGPT_MODEL_PRESETS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-5-mini",
  "o4-mini",
];

export const OPENAI_COMPAT_MODEL_PRESETS = [
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-4.1",
  "gpt-4o-mini",
];

function normalizeCompatBackups(rawBackups) {
  if (!Array.isArray(rawBackups)) {
    return [];
  }
  return rawBackups.map((item) => ({
    name: String(item?.name || "").trim(),
    baseUrl: String(item?.baseUrl || "").trim(),
    apiKey: String(item?.apiKey || "").trim(),
    model: String(item?.model || "").trim(),
  }));
}

export function createDefaultPrompts(isChinese = localeIsChinese) {
  if (isChinese) {
    return {
      optimize: {
        system: "你是一位资深语言学专家和专业编辑，精通语法、语义、语用与语域、术语一致性及跨语言表达。请在不改变作者原意或事实主张的前提下优化文字。仅返回修订后的正文。",
        user: "请优化下面这段文字。保留原意，提升表达质量。只返回优化后的正文，不要解释。\n\n{selection}",
      },
      optimize_with_context: {
        system: "你是一位资深语言学专家和专业编辑，精通语法、语义、语用与语域、术语一致性及跨语言表达。请结合全文语境优化局部文字，保持作者原意、事实主张、术语、风格和逻辑一致。必须将每个 ⟪AI_EDIT_MATH_n⟫ 占位符原样保留，且每个恰好出现一次并保持原始顺序。仅返回修订后的正文。",
        user: "以下是完整文档：\n\n<document>\n{document}\n</document>\n\n请优化下面选中的内容，并保持与全文一致；不得改变作者原意或事实主张。必须将每个 ⟪AI_EDIT_MATH_n⟫ 占位符原样保留，且每个恰好出现一次并保持原始顺序。只返回优化后的正文，不要解释。\n\n<selection>\n{selection}\n</selection>",
      },
      qa: {
        system: "你是一位资深语言学专家和专业编辑，精通语法、语义、语用与语域、术语一致性及跨语言表达。请直接、准确地回答用户问题；需要时提供清晰的编辑与语言建议。",
        user: "{question}",
      },
      qa_with_context: {
        system: "你是一位资深语言学专家和专业编辑，精通语法、语义、语用与语域、术语一致性及跨语言表达。请结合用户当前正在编辑的完整文档，直接、准确地回答问题；需要时提供清晰的编辑与语言建议。",
        user: "完整文档：\n\n<document>\n{document}\n</document>\n\n用户问题：\n{question}",
      },
      image_qa: {
        system: "你是一位资深语言学专家和专业编辑，精通语法、语义、语用与语域、术语一致性及跨语言表达。请基于图像内容直接、准确地回答问题；若信息不足请明确说明。",
        user: "请根据这张图片回答问题。只输出答案正文，不要添加多余说明。\n\n问题：{question}",
      },
    };
  }

  return {
    optimize: {
        system: "You are a senior linguistics expert and professional editor with expertise in grammar, semantics, pragmatics and register, terminology consistency, and cross-language expression. Improve the text without changing the author's meaning or factual claims. Return only the revised text.",
        user: "Please improve the following text. Keep the original meaning and return only the revised passage.\n\n{selection}",
      },
      optimize_with_context: {
        system: "You are a senior linguistics expert and professional editor with expertise in grammar, semantics, pragmatics and register, terminology consistency, and cross-language expression. Improve a local passage in context while preserving the author's meaning and factual claims. You must preserve every ⟪AI_EDIT_MATH_n⟫ placeholder exactly once and in its original order. Return only the revised text.",
        user: "Here is the full document:\n\n<document>\n{document}\n</document>\n\nPlease improve the selected passage while preserving the author's meaning and factual claims. You must preserve every ⟪AI_EDIT_MATH_n⟫ placeholder exactly once and in its original order. Return only the revised passage.\n\n<selection>\n{selection}\n</selection>",
      },
      qa: {
        system: "You are a senior linguistics expert and professional editor with expertise in grammar, semantics, pragmatics and register, terminology consistency, and cross-language expression. Answer the user's question directly and accurately, providing clear language and editing guidance when useful.",
        user: "{question}",
      },
      qa_with_context: {
        system: "You are a senior linguistics expert and professional editor with expertise in grammar, semantics, pragmatics and register, terminology consistency, and cross-language expression. Use the current document as context and answer the user's question directly and accurately, providing clear language and editing guidance when useful.",
        user: "Full document:\n\n<document>\n{document}\n</document>\n\nUser question:\n{question}",
      },
      image_qa: {
        system: "You are a senior linguistics expert and professional editor with expertise in grammar, semantics, pragmatics and register, terminology consistency, and cross-language expression. Answer accurately based on the image and clearly state uncertainty when needed.",
        user: "Answer the question based on this image. Return only the answer text.\n\nQuestion: {question}",
      },
  };
}

export const DEFAULT_SETTINGS = {
  provider: "chatgpt",
  model: "gpt-5.4",
  oauthTokenPath: "",
  oauthUserInfoPath: "",
  promptExportPath: "",
  openaiCompatFailoverEnabled: true,
  openaiCompatPreferredConnection: "primary",
  openaiCompatBackups: [
    { name: "Backup 1", baseUrl: "", apiKey: "", model: "" },
    { name: "Backup 2", baseUrl: "", apiKey: "", model: "" },
  ],
  openaiCompat: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-5.4-mini",
  },
  shortcut: {
    key: "e",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  },
  prompts: createDefaultPrompts(),
};

export function mergeSettings(raw = {}) {
  const prompts = raw.prompts || {};
  const normalizedBackups = normalizeCompatBackups(raw.openaiCompatBackups);
  const preferredConnection = String(raw.openaiCompatPreferredConnection || DEFAULT_SETTINGS.openaiCompatPreferredConnection);
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    openaiCompat: {
      ...DEFAULT_SETTINGS.openaiCompat,
      ...(raw.openaiCompat || {}),
    },
    openaiCompatFailoverEnabled: raw.openaiCompatFailoverEnabled !== undefined
      ? !!raw.openaiCompatFailoverEnabled
      : DEFAULT_SETTINGS.openaiCompatFailoverEnabled,
    openaiCompatPreferredConnection: [
      "primary",
      "backup_1",
      "backup_2",
    ].includes(preferredConnection) ? preferredConnection : DEFAULT_SETTINGS.openaiCompatPreferredConnection,
    openaiCompatBackups: normalizedBackups.length > 0
      ? normalizedBackups
      : DEFAULT_SETTINGS.openaiCompatBackups.map((x) => ({ ...x })),
    shortcut: {
      ...DEFAULT_SETTINGS.shortcut,
      ...(raw.shortcut || {}),
    },
    prompts: {
      ...DEFAULT_SETTINGS.prompts,
      ...prompts,
      optimize: {
        ...DEFAULT_SETTINGS.prompts.optimize,
        ...(prompts.optimize || {}),
      },
      optimize_with_context: {
        ...DEFAULT_SETTINGS.prompts.optimize_with_context,
        ...(prompts.optimize_with_context || {}),
      },
      qa: {
        ...DEFAULT_SETTINGS.prompts.qa,
        ...(prompts.qa || {}),
      },
      qa_with_context: {
        ...DEFAULT_SETTINGS.prompts.qa_with_context,
        ...(prompts.qa_with_context || {}),
      },
      image_qa: {
        ...DEFAULT_SETTINGS.prompts.image_qa,
        ...(prompts.image_qa || {}),
      },
    },
  };
}

export function shortcutMatches(event, shortcut) {
  if (!shortcut || !event || !event.key) {
    return false;
  }

  return (
    String(event.key).toLowerCase() === String(shortcut.key).toLowerCase()
    && !!event.ctrlKey === !!shortcut.ctrlKey
    && !!event.shiftKey === !!shortcut.shiftKey
    && !!event.altKey === !!shortcut.altKey
    && !!event.metaKey === !!shortcut.metaKey
  );
}

export function formatShortcut(shortcut) {
  if (!shortcut) {
    return "";
  }

  const parts = [];
  if (shortcut.ctrlKey) parts.push("Ctrl");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  if (shortcut.metaKey) parts.push("Meta");
  parts.push(String(shortcut.key || "").toUpperCase());
  return parts.join("+");
}
