const TOKEN_PREFIX = "⟪AI_EDIT_MATH_";
const TOKEN_SUFFIX = "⟫";

function mathToken(index) {
  return `${TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`;
}

function sentinelLikePattern() {
  return /⟪AI_EDIT_MATH_[^⟫\r\n]*⟫|⟪AI_EDIT_MATH_[^\s]*|AI_EDIT_MATH_[A-Za-z0-9_-]+/g;
}

function findSentinelLikeMatches(text) {
  return Array.from(text.matchAll(sentinelLikePattern()), (match) => ({
    source: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function lineEndIndex(text, start) {
  let cursor = start;
  while (cursor < text.length && text[cursor] !== "\r" && text[cursor] !== "\n") {
    cursor += 1;
  }
  return cursor;
}

function nextLineIndex(text, end) {
  if (end >= text.length) return end;
  if (text[end] === "\r" && text[end + 1] === "\n") return end + 2;
  return end + 1;
}

function blockquoteContentStart(text, lineStart, lineEnd) {
  let cursor = lineStart;
  let depth = 0;

  while (cursor < lineEnd) {
    const prefixStart = cursor;
    let spaces = 0;
    while (spaces < 3 && text[cursor] === " ") {
      spaces += 1;
      cursor += 1;
    }
    if (text[cursor] !== ">") {
      cursor = prefixStart;
      break;
    }

    depth += 1;
    cursor += 1;
    if (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  }

  return { contentStart: cursor, depth };
}

function fenceOnLine(text, lineStart, lineEnd) {
  const container = blockquoteContentStart(text, lineStart, lineEnd);
  let cursor = container.contentStart;
  let indent = 0;
  while (indent < 3 && text[cursor] === " ") {
    indent += 1;
    cursor += 1;
  }

  const marker = text[cursor];
  if (marker !== "`" && marker !== "~") return { ...container, fence: null };

  const runStart = cursor;
  while (text[cursor] === marker) cursor += 1;
  const length = cursor - runStart;
  if (length < 3) return { ...container, fence: null };

  return {
    ...container,
    fence: {
      marker,
      length,
      rest: text.slice(cursor, lineEnd),
    },
  };
}

function isFenceCloser(fence, activeFence) {
  return (
    fence !== null &&
    fence.marker === activeFence.marker &&
    fence.length >= activeFence.length &&
    /^[ \t]*$/.test(fence.rest)
  );
}

function isFenceOpener(fence) {
  if (fence === null) return false;
  return fence.marker !== "`" || !fence.rest.includes("`");
}

function findFencedCodeRanges(text) {
  const ranges = [];
  let activeFence = null;
  let lineStart = 0;

  while (lineStart < text.length) {
    const lineEnd = lineEndIndex(text, lineStart);
    const parsed = fenceOnLine(text, lineStart, lineEnd);

    if (
      activeFence !== null &&
      activeFence.quoteDepth > 0 &&
      parsed.depth < activeFence.quoteDepth
    ) {
      ranges.push({ start: activeFence.start, end: lineStart });
      activeFence = null;
      continue;
    }

    const afterLine = nextLineIndex(text, lineEnd);
    if (activeFence !== null) {
      if (
        parsed.depth === activeFence.quoteDepth &&
        isFenceCloser(parsed.fence, activeFence)
      ) {
        ranges.push({ start: activeFence.start, end: afterLine });
        activeFence = null;
      }
      lineStart = afterLine;
      continue;
    }

    if (isFenceOpener(parsed.fence)) {
      activeFence = {
        ...parsed.fence,
        start: lineStart,
        quoteDepth: parsed.depth,
      };
    }
    lineStart = afterLine;
  }

  if (activeFence !== null) {
    ranges.push({ start: activeFence.start, end: text.length });
  }
  return ranges;
}

function appendInlineCodeRanges(text, start, end, ranges) {
  const runs = [];
  let cursor = start;
  while (cursor < end) {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    const runStart = cursor;
    while (cursor < end && text[cursor] === "`") cursor += 1;
    runs.push({ start: runStart, end: cursor, length: cursor - runStart });
  }

  const nextSameRun = new Map();
  const nextByLength = new Map();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (nextByLength.has(run.length)) {
      nextSameRun.set(run.start, nextByLength.get(run.length));
    }
    nextByLength.set(run.length, run);
  }

  let index = 0;
  while (index < runs.length) {
    const opening = runs[index];
    const closing = nextSameRun.get(opening.start);
    if (closing === undefined) {
      index += 1;
      continue;
    }

    ranges.push({ start: opening.start, end: closing.end });
    index += 1;
    while (index < runs.length && runs[index].start < closing.end) index += 1;
  }
}

function findCodeRanges(text) {
  const fencedRanges = findFencedCodeRanges(text);
  const ranges = [];
  let segmentStart = 0;

  for (const fencedRange of fencedRanges) {
    appendInlineCodeRanges(text, segmentStart, fencedRange.start, ranges);
    ranges.push(fencedRange);
    segmentStart = fencedRange.end;
  }
  appendInlineCodeRanges(text, segmentStart, text.length, ranges);
  return ranges;
}

function scanFormulaEntries(text, codeRanges) {
  const entries = [];
  let codeRangeIndex = 0;
  let cursor = 0;
  let precedingBackslashes = 0;
  let candidate = null;

  const finishCandidate = (end) => {
    const token = mathToken(entries.length);
    entries.push({
      token,
      source: text.slice(candidate.start, end),
      start: candidate.start,
      end,
    });
    candidate = null;
    precedingBackslashes = 0;
    cursor = end;
  };

  while (cursor < text.length) {
    if (candidate === null) {
      while (
        codeRangeIndex < codeRanges.length &&
        codeRanges[codeRangeIndex].start < cursor
      ) {
        codeRangeIndex += 1;
      }
      if (
        codeRangeIndex < codeRanges.length &&
        codeRanges[codeRangeIndex].start === cursor
      ) {
        cursor = codeRanges[codeRangeIndex].end;
        codeRangeIndex += 1;
        precedingBackslashes = 0;
        continue;
      }

      const character = text[cursor];
      if (character === "\\") {
        if (
          precedingBackslashes % 2 === 0 &&
          (text[cursor + 1] === "(" || text[cursor + 1] === "[")
        ) {
          candidate = {
            kind: text[cursor + 1] === "(" ? "paren" : "bracket",
            start: cursor,
          };
          cursor += 2;
          precedingBackslashes = 0;
          continue;
        }
        precedingBackslashes += 1;
        cursor += 1;
        continue;
      }

      if (character === "$" && precedingBackslashes % 2 === 0) {
        candidate = {
          kind: text[cursor + 1] === "$" ? "display-dollar" : "inline-dollar",
          start: cursor,
        };
        cursor += candidate.kind === "display-dollar" ? 2 : 1;
        precedingBackslashes = 0;
        continue;
      }

      precedingBackslashes = 0;
      cursor += 1;
      continue;
    }

    const character = text[cursor];
    if (
      (candidate.kind === "inline-dollar" || candidate.kind === "paren") &&
      (character === "\r" || character === "\n")
    ) {
      candidate = null;
      precedingBackslashes = 0;
      cursor += 1;
      continue;
    }

    if (character === "\\") {
      const closingCharacter = candidate.kind === "paren" ? ")" : "]";
      if (
        (candidate.kind === "paren" || candidate.kind === "bracket") &&
        precedingBackslashes % 2 === 0 &&
        text[cursor + 1] === closingCharacter
      ) {
        finishCandidate(cursor + 2);
        continue;
      }
      precedingBackslashes += 1;
      cursor += 1;
      continue;
    }

    const escaped = precedingBackslashes % 2 === 1;
    precedingBackslashes = 0;
    if (character === "$" && !escaped) {
      if (candidate.kind === "inline-dollar") {
        if (text[cursor + 1] === "$") {
          candidate = null;
          continue;
        }
        finishCandidate(cursor + 1);
        continue;
      }
      if (candidate.kind === "display-dollar" && text[cursor + 1] === "$") {
        finishCandidate(cursor + 2);
        continue;
      }
    }
    cursor += 1;
  }

  return entries;
}

export function protectMath(text) {
  const formulaEntries = scanFormulaEntries(text, findCodeRanges(text));
  const segments = [];
  let unchangedStart = 0;

  for (const entry of formulaEntries) {
    segments.push({
      kind: "text",
      source: text.slice(unchangedStart, entry.start),
      start: unchangedStart,
    });
    segments.push({ kind: "math", source: entry.token });
    unchangedStart = entry.end;
  }

  segments.push({
    kind: "text",
    source: text.slice(unchangedStart),
    start: unchangedStart,
  });

  const textSegments = segments.filter(({ kind }) => kind === "text");
  const literalCount = textSegments.reduce(
    (count, segment) => count + findSentinelLikeMatches(segment.source).length,
    0,
  );
  if (formulaEntries.length === 0 && literalCount === 0) {
    return { protectedText: text, entries: formulaEntries };
  }

  const unavailableTokens = new Set([
    ...formulaEntries.map(({ token }) => token),
    ...findSentinelLikeMatches(text).map(({ source }) => source),
  ]);
  const literalEntries = [];
  const output = [];
  let nextLiteralIndex = formulaEntries.length;

  for (const segment of segments) {
    if (segment.kind === "math") {
      output.push(segment.source);
      continue;
    }

    let localCursor = 0;
    for (const match of findSentinelLikeMatches(segment.source)) {
      let token = mathToken(nextLiteralIndex);
      while (unavailableTokens.has(token)) {
        nextLiteralIndex += 1;
        token = mathToken(nextLiteralIndex);
      }
      nextLiteralIndex += 1;
      unavailableTokens.add(token);
      output.push(segment.source.slice(localCursor, match.start), token);
      literalEntries.push({
        token,
        source: match.source,
        start: segment.start + match.start,
        end: segment.start + match.end,
      });
      localCursor = match.end;
    }
    output.push(segment.source.slice(localCursor));
  }

  const entries = [...formulaEntries, ...literalEntries].sort(
    (left, right) => left.start - right.start,
  );
  return { protectedText: output.join(""), entries };
}

export function restoreMathPreview(text, entries) {
  if (entries.length === 0) return text;

  const entriesByToken = new Map(entries.map((entry) => [entry.token, entry]));
  const output = [];
  let cursor = 0;
  for (const match of findSentinelLikeMatches(text)) {
    const entry = entriesByToken.get(match.source);
    if (entry === undefined) continue;
    output.push(text.slice(cursor, match.start), entry.source);
    cursor = match.end;
  }

  output.push(text.slice(cursor));
  return output.join("");
}

export function restoreMath(text, entries) {
  const entriesByToken = new Map(entries.map((entry) => [entry.token, entry]));
  const counts = new Map(entries.map(({ token }) => [token, 0]));
  const encountered = [];

  for (const match of findSentinelLikeMatches(text)) {
    const entry = entriesByToken.get(match.source);
    if (entry === undefined) {
      return {
        ok: false,
        text,
        error: `Unexpected or mutated math placeholder: ${match.source}`,
      };
    }

    const count = counts.get(entry.token) + 1;
    counts.set(entry.token, count);
    if (count > 1) {
      return {
        ok: false,
        text,
        error: `Duplicated math placeholder: ${entry.token}`,
      };
    }
    encountered.push({ entry, match });
  }

  const protectedEntries = [...entries].sort(
    (left, right) => left.start - right.start,
  );
  for (const entry of protectedEntries) {
    if (counts.get(entry.token) === 0) {
      return {
        ok: false,
        text,
        error: `Missing math placeholder: ${entry.token}`,
      };
    }
  }

  for (let index = 0; index < protectedEntries.length; index += 1) {
    if (encountered[index].entry.token !== protectedEntries[index].token) {
      return {
        ok: false,
        text,
        error: `Protected placeholders are out of order near ${protectedEntries[index].token}`,
      };
    }
  }

  if (protectedEntries.length === 0) return { ok: true, text };

  const output = [];
  let cursor = 0;
  for (const { entry, match } of encountered) {
    output.push(text.slice(cursor, match.start), entry.source);
    cursor = match.end;
  }
  output.push(text.slice(cursor));

  return { ok: true, text: output.join("") };
}
