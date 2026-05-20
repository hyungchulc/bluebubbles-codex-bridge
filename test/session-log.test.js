import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionReplyScanner, SessionThreadTailScanner } from "../src/session-log.js";

test("does not append task_complete final when a final_answer message was already seen", () => {
  const requestId = "bb-codex-test-final-duplicate";
  const file = writeSessionLines([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: `[bridge_request_id: ${requestId}]\nhi`,
      },
    },
    {
      type: "response_item",
      payload: {
        id: "final-message",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "first final" }],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "first final plus task metadata",
      },
    },
  ]);

  const hit = new SessionReplyScanner(requestId).scanFile(file);

  assert.equal(hit.complete, true);
  assert.deepEqual(
    hit.messages.map((message) => message.id),
    ["final-message"],
  );
});

test("recognizes task_complete at EOF without waiting for a later newline", () => {
  const requestId = "bb-codex-test-final-eof-task-complete";
  const file = writeSessionText(
    [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: `[bridge_request_id: ${requestId}]\nhi`,
        },
      },
      {
        type: "response_item",
        payload: {
          id: "final-message",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "first final" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          completed_at: 1778447621,
          last_agent_message: "first final",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );

  const hit = new SessionReplyScanner(requestId).scanFile(file);

  assert.equal(hit.complete, true);
  assert.equal(hit.completedAt, 1778447621);
  assert.deepEqual(hit.messages, [
    {
      id: "final-message",
      phase: "final_answer",
      text: "first final",
    },
  ]);
});

test("recognizes appended EOF task_complete after streaming a final_answer", () => {
  const requestId = "bb-codex-test-incremental-eof-task-complete";
  const file = writeSessionLines([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: `[bridge_request_id: ${requestId}]\nhi`,
      },
    },
    {
      type: "response_item",
      payload: {
        id: "final-message",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "streamed final" }],
      },
    },
  ]);
  const scanner = new SessionReplyScanner(requestId);
  const beforeComplete = scanner.scanFile(file);

  assert.equal(beforeComplete.complete, false);
  assert.deepEqual(beforeComplete.messages, [
    {
      id: "final-message",
      phase: "final_answer",
      text: "streamed final",
    },
  ]);

  fs.appendFileSync(
    file,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        completed_at: 1778447621,
        last_agent_message: "streamed final",
      },
    }),
  );

  const afterComplete = scanner.scanFile(file);

  assert.equal(afterComplete.complete, true);
  assert.equal(afterComplete.completedAt, 1778447621);
  assert.deepEqual(afterComplete.messages, [
    {
      id: "final-message",
      phase: "final_answer",
      text: "streamed final",
    },
  ]);
});

test("uses task_complete final when no final_answer message was seen", () => {
  const requestId = "bb-codex-test-task-complete-only";
  const file = writeSessionLines([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: `[bridge_request_id: ${requestId}]\nhi`,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "fallback final",
      },
    },
  ]);

  const hit = new SessionReplyScanner(requestId).scanFile(file);

  assert.equal(hit.complete, true);
  assert.deepEqual(hit.messages, [
    {
      id: "task_complete",
      phase: "final_answer",
      text: "fallback final",
    },
  ]);
});

test("does not append task_complete final when it repeats prior commentary after attachment", () => {
  const requestId = "bb-codex-test-task-complete-repeats-commentary";
  const file = writeSessionLines([
    {
      type: "session_meta",
      payload: { id: "test-session" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: `[bridge_request_id: ${requestId}]\nmake image`,
      },
    },
    {
      type: "response_item",
      payload: {
        id: "progress-message",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "progress update" }],
      },
    },
    {
      type: "response_item",
      payload: {
        id: "image-call",
        type: "image_generation_call",
        result: Buffer.from("png").toString("base64"),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "progress update",
      },
    },
  ]);

  const hit = new SessionReplyScanner(requestId).scanFile(file);

  assert.equal(hit.complete, true);
  assert.deepEqual(
    hit.messages.map((message) => [message.id, message.phase, message.text]),
    [
      ["progress-message", "commentary", "progress update"],
      ["image-call", "attachment", ""],
    ],
  );
});

test("ignores request id mentions outside the actual user message", () => {
  const requestId = "bb-codex-test-automation-leak";
  const file = writeSessionLines([
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: `memory text mentioned [bridge_request_id: ${requestId}]`,
      },
    },
    {
      type: "response_item",
      payload: {
        id: "automation-commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "automation progress" }],
      },
    },
  ]);

  const hit = new SessionReplyScanner(requestId).scanFile(file);

  assert.equal(hit, null);
});

test("recognizes request id in event user_message entries", () => {
  const requestId = "bb-codex-test-event-user-message";
  const file = writeSessionLines([
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `[bridge_request_id: ${requestId}]\nhello`,
      },
    },
    {
      type: "response_item",
      payload: {
        id: "commentary-message",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "real progress" }],
      },
    },
  ]);

  const hit = new SessionReplyScanner(requestId).scanFile(file);

  assert.equal(hit.complete, false);
  assert.deepEqual(hit.messages, [
    {
      id: "commentary-message",
      phase: "commentary",
      text: "real progress",
    },
  ]);
});

test("thread tail scanner emits assistant messages appended after the saved offset", () => {
  const file = writeSessionLines([
    {
      type: "response_item",
      payload: {
        id: "old-commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "already sent" }],
      },
    },
  ]);
  const offset = fs.statSync(file).size;
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        id: "new-commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "new progress" }],
      },
    })}\n`,
  );

  const hit = new SessionThreadTailScanner({ offset }).scanFile(file);

  assert.deepEqual(hit.messages, [
    {
      id: "new-commentary",
      phase: "commentary",
      text: "new progress",
    },
  ]);
  assert.equal(hit.offset, fs.statSync(file).size);
});

test("thread tail scanner avoids task_complete duplication after final_answer", () => {
  const file = writeSessionLines([]);
  const scanner = new SessionThreadTailScanner({ offset: 0 });
  fs.appendFileSync(
    file,
    [
      {
        type: "response_item",
        payload: {
          id: "final-message",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "done" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: "done",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  const hit = scanner.scanFile(file);

  assert.deepEqual(hit.messages, [
    {
      id: "final-message",
      phase: "final_answer",
      text: "done",
    },
  ]);
});

test("thread tail scanner recognizes EOF task_complete without replaying final_answer", () => {
  const file = writeSessionText(
    [
      {
        type: "response_item",
        payload: {
          id: "final-message",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "done" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          completed_at: 1778447621,
          last_agent_message: "done",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );

  const hit = new SessionThreadTailScanner({ offset: 0 }).scanFile(file);

  assert.equal(hit.complete, true);
  assert.equal(hit.completedAt, 1778447621);
  assert.deepEqual(hit.messages, [
    {
      id: "final-message",
      phase: "final_answer",
      text: "done",
    },
  ]);
});

test("thread tail scanner completes when task_complete is appended without a newline", () => {
  const file = writeSessionLines([
    {
      type: "response_item",
      payload: {
        id: "final-message",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "done" }],
      },
    },
  ]);
  const scanner = new SessionThreadTailScanner({ offset: 0 });
  const beforeComplete = scanner.scanFile(file);

  assert.equal(beforeComplete.complete, false);
  assert.deepEqual(beforeComplete.messages, [
    {
      id: "final-message",
      phase: "final_answer",
      text: "done",
    },
  ]);

  fs.appendFileSync(
    file,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        completed_at: 1778447621,
        last_agent_message: "done",
      },
    }),
  );

  const afterComplete = scanner.scanFile(file);

  assert.equal(afterComplete.complete, true);
  assert.equal(afterComplete.completedAt, 1778447621);
  assert.deepEqual(afterComplete.messages, []);
});

function writeSessionLines(entries) {
  return writeSessionText(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function writeSessionText(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-log-test-"));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, text);
  return file;
}
