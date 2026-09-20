const DEFAULT_MAX_MATRIX_CELLS = 250_000;
const VALID_OPERATION_TYPES = new Set(["equal", "insert", "delete"]);

function segmentPlainText(text, locale) {
  if (text.length === 0) return [];

  if (typeof Intl?.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
      return Array.from(segmenter.segment(text), ({ segment }) => segment);
    } catch {
      // An unavailable Segmenter or invalid locale must not make Diff unusable.
    }
  }

  return Array.from(text);
}

function normalizeAtomicRanges(text, ranges = []) {
  const normalized = ranges.map((range) => {
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > text.length
    ) {
      throw new RangeError("Atomic ranges must be valid inclusive-exclusive offsets");
    }
    return { start, end };
  });

  normalized.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].start < normalized[index - 1].end) {
      throw new RangeError("Atomic ranges must not overlap");
    }
  }
  return normalized;
}

function mergeAtomicRanges(text, ...rangeGroups) {
  const ranges = rangeGroups
    .flatMap((group) => normalizeAtomicRanges(text, group))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous?.start === range.start && previous.end === range.end) continue;
    if (previous && range.start < previous.end) {
      throw new RangeError("Atomic ranges must not overlap");
    }
    merged.push(range);
  }
  return merged;
}

function atomicToken(text) {
  return { atomic: true, text };
}

function tokenText(token) {
  return typeof token === "string" ? token : token.text;
}

function tokensEqual(left, right) {
  if (typeof left === "string" || typeof right === "string") {
    return typeof left === "string" && typeof right === "string" && left === right;
  }
  return left.atomic === true && right.atomic === true && left.text === right.text;
}

function tokenizeWithRanges(text, locale, ranges) {
  const tokens = [];
  let cursor = 0;

  for (const range of normalizeAtomicRanges(text, ranges)) {
    tokens.push(...segmentPlainText(text.slice(cursor, range.start), locale));
    tokens.push(atomicToken(text.slice(range.start, range.end)));
    cursor = range.end;
  }
  tokens.push(...segmentPlainText(text.slice(cursor), locale));
  return tokens;
}

function rangesForAtomicValues(text, values = []) {
  const candidates = [...new Set(values)]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  const ranges = [];
  let cursor = 0;

  while (cursor < text.length && candidates.length > 0) {
    let nextStart = -1;
    let nextValue = "";
    for (const value of candidates) {
      const start = text.indexOf(value, cursor);
      if (
        start !== -1 &&
        (nextStart === -1 ||
          start < nextStart ||
          (start === nextStart && value.length > nextValue.length))
      ) {
        nextStart = start;
        nextValue = value;
      }
    }
    if (nextStart === -1) break;
    ranges.push({ start: nextStart, end: nextStart + nextValue.length });
    cursor = nextStart + nextValue.length;
  }

  return ranges;
}

export function tokenizeForDiff(text, locale) {
  if (typeof text !== "string") {
    throw new TypeError("Diff text must be a string");
  }
  return segmentPlainText(text, locale);
}

function appendTokenOperation(operations, type, tokens) {
  if (tokens.length === 0) return;
  const previous = operations.at(-1);
  if (previous?.type === type) {
    previous.tokens.push(...tokens);
  } else {
    operations.push({ type, tokens: [...tokens] });
  }
}

function diffTokenSequences(before, after, maxMatrixCells) {
  const operations = [];
  let prefixLength = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (
    prefixLength < maxPrefix &&
    tokensEqual(before[prefixLength], after[prefixLength])
  ) {
    prefixLength += 1;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > prefixLength &&
    afterEnd > prefixLength &&
    tokensEqual(before[beforeEnd - 1], after[afterEnd - 1])
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  appendTokenOperation(operations, "equal", before.slice(0, prefixLength));
  const beforeMiddle = before.slice(prefixLength, beforeEnd);
  const afterMiddle = after.slice(prefixLength, afterEnd);

  if (beforeMiddle.length === 0) {
    appendTokenOperation(operations, "insert", afterMiddle);
  } else if (afterMiddle.length === 0) {
    appendTokenOperation(operations, "delete", beforeMiddle);
  } else if (beforeMiddle.length * afterMiddle.length > maxMatrixCells) {
    appendTokenOperation(operations, "delete", beforeMiddle);
    appendTokenOperation(operations, "insert", afterMiddle);
  } else {
    const columns = afterMiddle.length + 1;
    const table = new Uint32Array((beforeMiddle.length + 1) * columns);
    for (let left = beforeMiddle.length - 1; left >= 0; left -= 1) {
      for (let right = afterMiddle.length - 1; right >= 0; right -= 1) {
        const offset = left * columns + right;
        table[offset] =
          tokensEqual(beforeMiddle[left], afterMiddle[right])
            ? table[(left + 1) * columns + right + 1] + 1
            : Math.max(
                table[(left + 1) * columns + right],
                table[left * columns + right + 1],
              );
      }
    }

    let left = 0;
    let right = 0;
    while (left < beforeMiddle.length && right < afterMiddle.length) {
      if (tokensEqual(beforeMiddle[left], afterMiddle[right])) {
        appendTokenOperation(operations, "equal", [beforeMiddle[left]]);
        left += 1;
        right += 1;
      } else if (
        table[(left + 1) * columns + right] >=
        table[left * columns + right + 1]
      ) {
        appendTokenOperation(operations, "delete", [beforeMiddle[left]]);
        left += 1;
      } else {
        appendTokenOperation(operations, "insert", [afterMiddle[right]]);
        right += 1;
      }
    }
    appendTokenOperation(operations, "delete", beforeMiddle.slice(left));
    appendTokenOperation(operations, "insert", afterMiddle.slice(right));
  }

  appendTokenOperation(operations, "equal", before.slice(beforeEnd));
  return operations;
}

function splitLines(text) {
  return text.match(/[^\r\n]+(?:\r\n|\r|\n)?|(?:\r\n|\r|\n)/g) ?? [];
}

function splitLinesWithRanges(text, ranges) {
  const tokens = [];
  let cursor = 0;
  for (const range of normalizeAtomicRanges(text, ranges)) {
    tokens.push(...splitLines(text.slice(cursor, range.start)));
    tokens.push(atomicToken(text.slice(range.start, range.end)));
    cursor = range.end;
  }
  tokens.push(...splitLines(text.slice(cursor)));
  return tokens;
}

function appendTextOperation(operations, type, text) {
  if (text.length === 0) return;
  const previous = operations.at(-1);
  if (previous?.type === type) {
    previous.text += text;
  } else {
    operations.push({ type, text });
  }
}

function textFromTokenOperation(operation) {
  return operation.tokens.map(tokenText).join("");
}

function resolveAtomicRanges(before, after, options) {
  const values = Array.isArray(options.atomicValues) ? options.atomicValues : [];
  const rangeOptions = options.atomicRanges;
  const beforeRanges = Array.isArray(rangeOptions)
    ? rangeOptions
    : rangeOptions?.before ?? [];
  const afterRanges = Array.isArray(rangeOptions)
    ? rangeOptions
    : rangeOptions?.after ?? [];
  return {
    before: mergeAtomicRanges(
      before,
      rangesForAtomicValues(before, values),
      beforeRanges,
    ),
    after: mergeAtomicRanges(
      after,
      rangesForAtomicValues(after, values),
      afterRanges,
    ),
  };
}

function flattenTokens(tokens) {
  const textParts = [];
  const ranges = [];
  let offset = 0;
  for (const token of tokens) {
    const text = tokenText(token);
    textParts.push(text);
    if (typeof token !== "string" && token.atomic === true) {
      ranges.push({ start: offset, end: offset + text.length });
    }
    offset += text.length;
  }
  return { text: textParts.join(""), ranges };
}

function refineChangedLines(lineOperations, options) {
  const output = [];
  let index = 0;
  while (index < lineOperations.length) {
    const operation = lineOperations[index];
    if (operation.type === "equal") {
      appendTextOperation(output, "equal", textFromTokenOperation(operation));
      index += 1;
      continue;
    }

    const beforeTokens = [];
    const afterTokens = [];
    while (index < lineOperations.length && lineOperations[index].type !== "equal") {
      const changed = lineOperations[index];
      if (changed.type === "delete") beforeTokens.push(...changed.tokens);
      if (changed.type === "insert") afterTokens.push(...changed.tokens);
      index += 1;
    }

    const beforeChange = flattenTokens(beforeTokens);
    const afterChange = flattenTokens(afterTokens);

    const wordOperations = diffTokenSequences(
      tokenizeWithRanges(
        beforeChange.text,
        options.locale,
        beforeChange.ranges,
      ),
      tokenizeWithRanges(afterChange.text, options.locale, afterChange.ranges),
      options.maxMatrixCells,
    );
    for (const wordOperation of wordOperations) {
      appendTextOperation(
        output,
        wordOperation.type,
        textFromTokenOperation(wordOperation),
      );
    }
  }
  return output;
}

export function buildTextDiff(before, after, options = {}) {
  if (typeof before !== "string" || typeof after !== "string") {
    throw new TypeError("Diff inputs must be strings");
  }
  const requestedLimit = options.maxMatrixCells ?? DEFAULT_MAX_MATRIX_CELLS;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) {
    throw new RangeError("maxMatrixCells must be a non-negative safe integer");
  }

  const normalizedOptions = {
    locale: options.locale,
    maxMatrixCells: requestedLimit,
  };
  const atomicRanges = resolveAtomicRanges(before, after, options);
  const lineOperations = diffTokenSequences(
    splitLinesWithRanges(before, atomicRanges.before),
    splitLinesWithRanges(after, atomicRanges.after),
    normalizedOptions.maxMatrixCells,
  );
  return refineChangedLines(lineOperations, normalizedOptions);
}

export function reconstructDiff(operations, side) {
  if (side !== "before" && side !== "after") {
    throw new TypeError('Diff side must be "before" or "after"');
  }
  if (!Array.isArray(operations)) {
    throw new TypeError("Diff operations must be an array");
  }

  const includedType = side === "before" ? "delete" : "insert";
  let output = "";
  for (const operation of operations) {
    if (
      !operation ||
      !VALID_OPERATION_TYPES.has(operation.type) ||
      typeof operation.text !== "string"
    ) {
      throw new TypeError("Invalid Diff operation");
    }
    if (operation.type === "equal" || operation.type === includedType) {
      output += operation.text;
    }
  }
  return output;
}
