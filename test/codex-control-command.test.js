import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeModelForConfig,
  normalizeReasoningForConfig,
  parseCodexControlCommand,
  parseCodexRawReasoningCommand,
} from "../src/codex-control-command.js";

test("does not parse natural-language model or reasoning text as control messages", () => {
  assert.equal(parseCodexControlCommand("모델을 5.5로 해줘"), null);
  assert.equal(parseCodexControlCommand("reasoning high로 바꿔"), null);
  assert.equal(parseCodexControlCommand("모델 5.5 reasoning extra high로"), null);
  assert.equal(parseCodexControlCommand("Reasoning high로 바뀌었어? 확인해봐"), null);
});

test("parses explicit slash model and reasoning control messages", () => {
  assert.deepEqual(parseCodexControlCommand("/model gpt-5.5"), {
    type: "codex_model_reasoning",
    modelText: "5.5",
    reasoningText: "",
  });
  assert.deepEqual(parseCodexControlCommand("/reasoning xhigh"), {
    type: "codex_model_reasoning",
    modelText: "",
    reasoningText: "Extra High",
  });
});

test("parses short slash reasoning aliases as raw Codex commands", () => {
  assert.deepEqual(parseCodexRawReasoningCommand("/high"), {
    type: "codex_raw_reasoning",
    reasoningText: "High",
    prompt: "/reasoning High",
  });
  assert.deepEqual(parseCodexRawReasoningCommand("/xhigh"), {
    type: "codex_raw_reasoning",
    reasoningText: "Extra High",
    prompt: "/reasoning Extra High",
  });
  assert.deepEqual(parseCodexRawReasoningCommand("/reasoning xhigh"), {
    type: "codex_raw_reasoning",
    reasoningText: "Extra High",
    prompt: "/reasoning Extra High",
  });
  assert.equal(parseCodexRawReasoningCommand("high"), null);
});

test("does not parse ordinary thesis model prose as a control message", () => {
  assert.equal(
    parseCodexControlCommand("The H3 interaction model is written in the methods section."),
    null,
  );
});

test("does not parse URL query parameters as model control commands", () => {
  assert.equal(
    parseCodexControlCommand(
      "https://developers.openai.com/api/docs/guides/prompt-guidance?model=gpt-5.5\n\n일단 이거 기반으로 좀 최적화 해봐",
    ),
    null,
  );
  assert.equal(parseCodexControlCommand("https://example.com/?model=gpt-5.5 모델 5.5로 해줘"), null);
});

test("normalizes model and reasoning values for config.toml", () => {
  assert.equal(normalizeModelForConfig("5.5"), "gpt-5.5");
  assert.equal(normalizeModelForConfig("gpt-5.5"), "gpt-5.5");
  assert.equal(normalizeReasoningForConfig("Extra High"), "xhigh");
  assert.equal(normalizeReasoningForConfig("High"), "high");
});
