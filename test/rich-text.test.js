import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdownRichText } from "../src/rich-text.js";

test("leaves plain text untouched", () => {
  assert.deepEqual(renderMarkdownRichText("plain reply"), {
    text: "plain reply",
    attributedBody: null,
  });
});

test("converts markdown bold to an attributed body", () => {
  const result = renderMarkdownRichText("hello **bold** now");

  assert.equal(result.text, "hello bold now");
  assert.equal(result.attributedBody.string, "hello bold now");
  assert.deepEqual(result.attributedBody.runs, [
    {
      range: [0, 6],
      attributes: {
        __kIMMessagePartAttributeName: 0,
      },
    },
    {
      range: [6, 4],
      attributes: {
        __kIMMessagePartAttributeName: 0,
        __kIMTextBoldAttributeName: 1,
        bold: true,
      },
    },
    {
      range: [10, 4],
      attributes: {
        __kIMMessagePartAttributeName: 0,
      },
    },
  ]);
});

test("preserves unmatched bold delimiters", () => {
  assert.deepEqual(renderMarkdownRichText("hello **bold"), {
    text: "hello **bold",
    attributedBody: null,
  });
});

test("does not parse bold markers inside inline code", () => {
  const result = renderMarkdownRichText("keep `**code**` but **send bold**");

  assert.equal(result.text, "keep **code** but send bold");
  assert.deepEqual(result.attributedBody.runs.at(-1), {
    range: [18, 9],
    attributes: {
      __kIMMessagePartAttributeName: 0,
      __kIMTextBoldAttributeName: 1,
      bold: true,
    },
  });
});

test("does not parse bold markers inside fenced code", () => {
  const result = renderMarkdownRichText("```\n**code**\n```\n**real**");

  assert.equal(result.text, "\n**code**\n\nreal");
  assert.deepEqual(result.attributedBody.runs.at(-1), {
    range: [11, 4],
    attributes: {
      __kIMMessagePartAttributeName: 0,
      __kIMTextBoldAttributeName: 1,
      bold: true,
    },
  });
});

test("handles multiple bold spans", () => {
  const result = renderMarkdownRichText("**one** and **two**");

  assert.equal(result.text, "one and two");
  assert.deepEqual(
    result.attributedBody.runs
      .filter((run) => run.attributes.bold)
      .map((run) => run.range),
    [
      [0, 3],
      [8, 3],
    ],
  );
});

test("normalizes inline code delimiters in plain replies", () => {
  assert.deepEqual(renderMarkdownRichText("path `SOURCE_RULES.md` ok"), {
    text: "path SOURCE_RULES.md ok",
    attributedBody: null,
  });
});

test("normalizes markdown links for iMessage plain text", () => {
  assert.deepEqual(
    renderMarkdownRichText("[Prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance)"),
    {
      text: "Prompt guidance: https://developers.openai.com/api/docs/guides/prompt-guidance",
      attributedBody: null,
    },
  );
});
