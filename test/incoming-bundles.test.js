import assert from "node:assert/strict";
import test from "node:test";

import {
  getIncomingBundleDelayMs,
  hasPendingLinkCue,
  isUrlOnlyText,
  shouldUseLinkBundleDelay,
} from "../src/incoming-bundles.js";

const defaultDelayMs = 1800;
const linkDelayMs = 8000;

test("detects URL-only messages for delayed bundling", () => {
  assert.equal(isUrlOnlyText("https://facetime.apple.com/join#v=1&p=abc"), true);
  assert.equal(isUrlOnlyText("<https://example.com/path>"), true);
  assert.equal(isUrlOnlyText("open https://example.com/path"), false);
});

test("detects pending link cues without delaying ordinary messages", () => {
  assert.equal(hasPendingLinkCue("음 너 혹시 브라우저유즈로 이거 들어올 수 있냐"), true);
  assert.equal(hasPendingLinkCue("이거"), true);
  assert.equal(hasPendingLinkCue("오늘 저녁 뭐 먹지"), false);
});

test("uses longer delay before a likely follow-up link arrives", () => {
  assert.equal(
    getIncomingBundleDelayMs(
      [{ text: "음 너 혹시 브라우저유즈로 이거 들어올 수 있냐" }],
      { defaultDelayMs, linkDelayMs },
    ),
    linkDelayMs,
  );
});

test("uses longer delay before a likely follow-up reference link arrives", () => {
  assert.equal(
    getIncomingBundleDelayMs(
      [{ text: "그리고 gpt 5.5 프롬프트 가이드를 따라야하지않을까??" }],
      { defaultDelayMs, linkDelayMs },
    ),
    linkDelayMs,
  );
  assert.equal(
    getIncomingBundleDelayMs(
      [{ text: "OpenAI 공식 가이드대로 최적화해봐" }],
      { defaultDelayMs, linkDelayMs },
    ),
    linkDelayMs,
  );
});

test("does not delay ordinary prompt wording without a reference cue", () => {
  assert.equal(
    getIncomingBundleDelayMs(
      [{ text: "기본 프롬프트를 업그레이드 해봐" }],
      { defaultDelayMs, linkDelayMs },
    ),
    defaultDelayMs,
  );
});

test("uses longer delay for a standalone link to wait for context", () => {
  assert.equal(
    shouldUseLinkBundleDelay([{ text: "https://facetime.apple.com/join#v=1&p=abc" }]),
    true,
  );
});

test("returns to the normal delay once cue and link are bundled", () => {
  assert.equal(
    getIncomingBundleDelayMs(
      [
        { text: "음 너 혹시 브라우저유즈로 이거 들어올 수 있냐" },
        { text: "https://facetime.apple.com/join#v=1&p=abc" },
      ],
      { defaultDelayMs, linkDelayMs },
    ),
    defaultDelayMs,
  );
});

test("does not delay a complete message that already contains a link and context", () => {
  assert.equal(
    getIncomingBundleDelayMs(
      [{ text: "이 링크 열어봐 https://example.com" }],
      { defaultDelayMs, linkDelayMs },
    ),
    defaultDelayMs,
  );
});
