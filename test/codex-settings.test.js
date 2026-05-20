import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearDesiredCodexState,
  readDesiredCodexState,
  updateCodexConfigFile,
  writeDesiredCodexState,
} from "../src/codex-settings.js";

test("writes and preserves desired Codex UI state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desired-"));
  const statePath = path.join(dir, "state.json");

  const first = writeDesiredCodexState(statePath, { modelText: "gpt-5.5" });
  assert.equal(first.modelText, "5.5");
  assert.equal(first.reasoningText, undefined);

  const second = writeDesiredCodexState(statePath, { reasoningText: "xhigh" });
  assert.equal(second.modelText, "5.5");
  assert.equal(second.reasoningText, "Extra High");
  assert.deepEqual(readDesiredCodexState(statePath), {
    modelText: "5.5",
    reasoningText: "Extra High",
    updatedAt: second.updatedAt,
  });
});

test("clears desired Codex UI state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-clear-desired-"));
  const statePath = path.join(dir, "state.json");
  writeDesiredCodexState(statePath, { reasoningText: "high" });

  const result = clearDesiredCodexState(statePath);

  assert.equal(result.changed, true);
  assert.equal(readDesiredCodexState(statePath), null);
});

test("updates only top-level Codex config model settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      'model_reasoning_effort = "medium"',
      'model = "gpt-5.4"',
      "",
      "[agents.executor]",
      'model = "gpt-5.5"',
      'model_reasoning_effort = "medium"',
      "",
    ].join("\n"),
  );

  const result = updateCodexConfigFile(configPath, {
    modelText: "5.5",
    reasoningText: "high",
  });
  const text = fs.readFileSync(configPath, "utf8");

  assert.equal(result.changed, true);
  assert.match(text, /^model = "gpt-5\.5"$/m);
  assert.match(text, /^model_reasoning_effort = "high"$/m);
  assert.match(text, /\[agents\.executor\]\nmodel = "gpt-5\.5"\nmodel_reasoning_effort = "medium"/);
});
