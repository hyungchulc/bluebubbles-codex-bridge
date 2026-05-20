import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IncomingJobStore } from "../src/incoming-jobs.js";

test("lists jobs that started but were not completed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-jobs-test-"));
  const store = new IncomingJobStore({ logPath: path.join(dir, "jobs.jsonl") });

  const id = store.start({
    incoming: {
      guid: "message-1",
      chatGuid: "chat-1",
      handle: "user@example.com",
      text: "hello",
      attachments: [],
    },
    prompt: "prompt text",
  });

  assert.equal(id, "message-1");
  assert.deepEqual(
    store.listOpen().map((job) => [job.id, job.status, job.incoming.text]),
    [["message-1", "started", "hello"]],
  );
});

test("completed jobs are not listed as open", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-jobs-test-"));
  const store = new IncomingJobStore({ logPath: path.join(dir, "jobs.jsonl") });

  const id = store.start({
    incoming: { guid: "message-2", chatGuid: "chat-1", attachments: [] },
    prompt: "prompt text",
  });
  store.mark(id, "sent", { requestId: "request-1" });

  assert.deepEqual(store.listOpen(), []);
});

test("stale started jobs are not listed as open", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-jobs-test-"));
  const old = new Date("2026-01-01T00:00:00.000Z");
  const current = new Date("2026-01-01T05:00:00.000Z");
  const store = new IncomingJobStore({
    logPath: path.join(dir, "jobs.jsonl"),
    now: () => old,
  });

  store.start({
    incoming: { guid: "message-old", chatGuid: "chat-1", attachments: [] },
    prompt: "prompt text",
  });
  store.now = () => current;

  assert.deepEqual(store.listOpen(), []);
  assert.equal(store.listOpen({ maxAgeMs: 6 * 60 * 60 * 1000 }).length, 1);
});
