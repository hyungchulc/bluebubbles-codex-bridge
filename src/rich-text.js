export function renderMarkdownRichText(value) {
  if (typeof value !== "string" || value.length === 0) {
    return { text: value, attributedBody: null };
  }

  const segments = [];
  let activeBold = false;
  let inlineCode = false;
  let fencedCode = false;
  let atLineStart = true;
  let i = 0;

  while (i < value.length) {
    if (atLineStart && value.startsWith("```", i)) {
      appendSegment(segments, "```", activeBold);
      fencedCode = !fencedCode;
      i += 3;
      atLineStart = false;
      continue;
    }

    const char = value[i];
    if (!fencedCode && char === "`" && !isEscaped(value, i)) {
      inlineCode = !inlineCode;
      appendSegment(segments, char, activeBold);
      i += 1;
      atLineStart = false;
      continue;
    }

    if (
      !fencedCode &&
      !inlineCode &&
      value.startsWith("**", i) &&
      !isEscaped(value, i)
    ) {
      if (activeBold || hasClosingBoldMarker(value, i + 2)) {
        activeBold = !activeBold;
        i += 2;
        atLineStart = false;
        continue;
      }
    }

    appendSegment(segments, char, activeBold);
    i += 1;
    atLineStart = char === "\n";
  }

  const text = segments.map((segment) => segment.text).join("");
  const hasBold = segments.some((segment) => segment.bold && segment.text.length > 0);
  if (!hasBold) {
    return { text: value, attributedBody: null };
  }

  let location = 0;
  const runs = [];
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const attributes = {
      __kIMMessagePartAttributeName: 0,
    };
    if (segment.bold) {
      attributes.__kIMTextBoldAttributeName = 1;
      attributes.bold = true;
    }
    runs.push({
      range: [location, segment.text.length],
      attributes,
    });
    location += segment.text.length;
  }

  return {
    text,
    attributedBody: {
      string: text,
      runs,
    },
  };
}

function appendSegment(segments, text, bold) {
  const last = segments.at(-1);
  if (last && last.bold === bold) {
    last.text += text;
    return;
  }
  segments.push({ text, bold });
}

function hasClosingBoldMarker(value, start) {
  let inlineCode = false;
  let fencedCode = false;
  let atLineStart = false;

  for (let i = start; i < value.length; i += 1) {
    if (atLineStart && value.startsWith("```", i)) {
      fencedCode = !fencedCode;
      i += 2;
      atLineStart = false;
      continue;
    }

    const char = value[i];
    if (!fencedCode && char === "`" && !isEscaped(value, i)) {
      inlineCode = !inlineCode;
      atLineStart = false;
      continue;
    }
    if (!fencedCode && !inlineCode && value.startsWith("**", i) && !isEscaped(value, i)) {
      return true;
    }
    atLineStart = char === "\n";
  }
  return false;
}

function isEscaped(value, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
