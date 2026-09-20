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

function isEscaped(text, index) {
  let backslashes = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }

  return backslashes % 2 === 1;
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

function fenceAtLineStart(text, lineStart) {
  let cursor = lineStart;
  let indent = 0;

  while (indent < 3 && text[cursor] === " ") {
    indent += 1;
    cursor += 1;
  }

  const marker = text[cursor];
  if (marker !== "`" && marker !== "~") return null;

  const runStart = cursor;
  while (text[cursor] === marker) cursor += 1;
  const length = cursor - runStart;
  if (length < 3) return null;

  return { marker, length };
}

function isClosingFenceLine(text, lineStart, fence) {
  let cursor = lineStart;
  let indent = 0;

  while (indent < 3 && text[cursor] === " ") {
    indent += 1;
    cursor += 1;
  }

  const runStart = cursor;
  while (text[cursor] === fence.marker) cursor += 1;
  if (cursor - runStart < fence.length) return false;

  const end = lineEndIndex(text, cursor);
  while (cursor < end && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor += 1;
  }
  return cursor === end;
}

function fencedBlockEnd(text, lineStart, fence) {
  let cursor = nextLineIndex(text, lineEndIndex(text, lineStart));

  while (cursor < text.length) {
    const end = lineEndIndex(text, cursor);
    if (isClosingFenceLine(text, cursor, fence)) {
      return nextLineIndex(text, end);
    }
    cursor = nextLineIndex(text, end);
  }

  return text.length;
}

function backtickRunLength(text, start) {
  let cursor = start;
  while (text[cursor] === "`") cursor += 1;
  return cursor - start;
}

function inlineCodeEnd(text, start) {
  const openingLength = backtickRunLength(text, start);
  let cursor = start + openingLength;

  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    const length = backtickRunLength(text, cursor);
    if (length === openingLength) return cursor + length;
    cursor += length;
  }

  return null;
}

function displayDollarEnd(text, start) {
  let cursor = start + 2;

  while (cursor < text.length - 1) {
    if (
      text[cursor] === "$" &&
      text[cursor + 1] === "$" &&
      !isEscaped(text, cursor)
    ) {
      return cursor + 2;
    }
    cursor += 1;
  }

  return null;
}

function inlineDollarEnd(text, start) {
  let cursor = start + 1;

  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "\r" || character === "\n") return null;

    if (character === "$" && !isEscaped(text, cursor)) {
      if (text[cursor + 1] === "$" && !isEscaped(text, cursor + 1)) {
        return null;
      }
      if (text[cursor - 1] !== "$" || isEscaped(text, cursor - 1)) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }

  return null;
}

function latexEnd(text, start, closingCharacter, allowNewlines) {
  let cursor = start + 2;

  while (cursor < text.length - 1) {
    if (!allowNewlines && (text[cursor] === "\r" || text[cursor] === "\n")) {
      return null;
    }
    if (
      text[cursor] === "\\" &&
      text[cursor + 1] === closingCharacter &&
      !isEscaped(text, cursor)
    ) {
      return cursor + 2;
    }
    cursor += 1;
  }

  return null;
}

function mathEndAt(text, start) {
  if (
    text[start] === "$" &&
    text[start + 1] === "$" &&
    !isEscaped(text, start)
  ) {
    return displayDollarEnd(text, start);
  }

  if (
    text[start] === "$" &&
    (text[start - 1] !== "$" || isEscaped(text, start - 1)) &&
    (text[start + 1] !== "$" || isEscaped(text, start + 1)) &&
    !isEscaped(text, start)
  ) {
    return inlineDollarEnd(text, start);
  }

  if (text[start] === "\\" && !isEscaped(text, start)) {
    if (text[start + 1] === "(") return latexEnd(text, start, ")", false);
    if (text[start + 1] === "[") return latexEnd(text, start, "]", true);
  }

  return null;
}

export function protectMath(text) {
  const formulaEntries = [];
  const segments = [];
  let cursor = 0;
  let unchangedStart = 0;

  while (cursor < text.length) {
    const atLineStart =
      cursor === 0 || text[cursor - 1] === "\n" || text[cursor - 1] === "\r";

    if (atLineStart) {
      const fence = fenceAtLineStart(text, cursor);
      if (fence) {
        cursor = fencedBlockEnd(text, cursor, fence);
        continue;
      }
    }

    if (text[cursor] === "`") {
      const codeEnd = inlineCodeEnd(text, cursor);
      if (codeEnd !== null) {
        cursor = codeEnd;
        continue;
      }
      cursor += backtickRunLength(text, cursor);
      continue;
    }

    const end = mathEndAt(text, cursor);
    if (end === null) {
      cursor += 1;
      continue;
    }

    const token = mathToken(formulaEntries.length);
    const source = text.slice(cursor, end);
    segments.push({
      kind: "text",
      source: text.slice(unchangedStart, cursor),
      start: unchangedStart,
    });
    segments.push({ kind: "math", source: token });
    formulaEntries.push({ token, source, start: cursor, end });
    cursor = end;
    unchangedStart = end;
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

  const output = [];
  let cursor = 0;

  while (cursor < text.length) {
    let nextPosition = -1;
    let nextEntry = null;

    for (const entry of entries) {
      if (entry.token.length === 0) continue;
      const position = text.indexOf(entry.token, cursor);
      if (position !== -1 && (nextPosition === -1 || position < nextPosition)) {
        nextPosition = position;
        nextEntry = entry;
      }
    }

    if (nextEntry === null) break;
    output.push(text.slice(cursor, nextPosition), nextEntry.source);
    cursor = nextPosition + nextEntry.token.length;
  }

  output.push(text.slice(cursor));
  return output.join("");
}

function findSentinelLikeValues(text) {
  return findSentinelLikeMatches(text).map(({ source }) => source);
}

function occurrencePositions(text, token) {
  const positions = [];
  let cursor = 0;

  while (cursor <= text.length - token.length) {
    const position = text.indexOf(token, cursor);
    if (position === -1) break;
    positions.push(position);
    cursor = position + token.length;
  }

  return positions;
}

export function restoreMath(text, entries) {
  const expectedTokens = new Set(entries.map(({ token }) => token));

  for (const value of findSentinelLikeValues(text)) {
    if (!expectedTokens.has(value)) {
      return {
        ok: false,
        text,
        error: `Unexpected or mutated math placeholder: ${value}`,
      };
    }
  }

  const protectedEntries = [...entries].sort(
    (left, right) => left.start - right.start,
  );
  const positions = [];
  for (const { token } of protectedEntries) {
    const matches = occurrencePositions(text, token);
    if (matches.length === 0) {
      return { ok: false, text, error: `Missing math placeholder: ${token}` };
    }
    if (matches.length > 1) {
      return { ok: false, text, error: `Duplicated math placeholder: ${token}` };
    }
    positions.push(matches[0]);
  }

  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] < positions[index - 1]) {
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
  for (let index = 0; index < protectedEntries.length; index += 1) {
    const entry = protectedEntries[index];
    const position = positions[index];
    output.push(text.slice(cursor, position), entry.source);
    cursor = position + entry.token.length;
  }
  output.push(text.slice(cursor));

  return { ok: true, text: output.join("") };
}
