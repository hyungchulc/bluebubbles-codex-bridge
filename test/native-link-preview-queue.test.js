import assert from "node:assert/strict";
import test from "node:test";

import {
  createSequentialTaskQueue,
  isLinkPreviewMaterializedRecord,
  waitForLinkPreviewMaterialization,
} from "../src/native-link-preview-queue.js";

test("sequential task queue runs overlapping submissions one at a time", async () => {
  const queue = createSequentialTaskQueue();
  const events = [];
  const task = (name) =>
    queue.run(async () => {
      events.push(`start:${name}`);
      await Promise.resolve();
      events.push(`end:${name}`);
      return name;
    });

  const results = await Promise.all([task("a"), task("b"), task("c")]);

  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(events, [
    "start:a",
    "end:a",
    "start:b",
    "end:b",
    "start:c",
    "end:c",
  ]);
});

test("sequential task queue continues after a failed task", async () => {
  const queue = createSequentialTaskQueue();
  const events = [];
  const failed = queue.run(async () => {
    events.push("fail:start");
    throw new Error("boom");
  });
  const passed = queue.run(async () => {
    events.push("pass:start");
    return "ok";
  });

  await assert.rejects(failed, /boom/);
  assert.equal(await passed, "ok");
  assert.deepEqual(events, ["fail:start", "pass:start"]);
});

test("recognizes materialized link previews from payload or attachments", () => {
  assert.equal(isLinkPreviewMaterializedRecord({ hasPayloadData: true }), true);
  assert.equal(isLinkPreviewMaterializedRecord({ attachments: [{ guid: "a" }] }), true);
  assert.equal(isLinkPreviewMaterializedRecord({ hasPayloadData: false, attachments: [] }), false);
  assert.equal(isLinkPreviewMaterializedRecord(null), false);
});

test("waits until a link preview record materializes", async () => {
  let calls = 0;
  const record = await waitForLinkPreviewMaterialization({
    timeoutMs: 1000,
    pollMs: 100,
    sleep: async () => {},
    getRecord: () => {
      calls += 1;
      return calls >= 3 ? { attachments: [{ guid: "ready" }] } : { attachments: [] };
    },
  });

  assert.deepEqual(record, { attachments: [{ guid: "ready" }] });
  assert.equal(calls, 3);
});
