import assert from "node:assert/strict";
import test from "node:test";

import { createOutgoingDedupe } from "../src/outgoing-dedupe.js";

test("claims one identical outgoing text per target within the TTL", () => {
  let currentTime = 1_000;
  const dedupe = createOutgoingDedupe({
    ttlMs: 60_000,
    now: () => currentTime,
  });

  const first = dedupe.claim({
    chatGuid: "chat-1",
    text: "same reply",
  });
  const second = dedupe.claim({
    chatGuid: "chat-1",
    text: "same reply",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);

  currentTime += 60_001;
  assert.equal(
    dedupe.claim({
      chatGuid: "chat-1",
      text: "same reply",
    }).ok,
    true,
  );
});

test("allows the same outgoing text for different targets", () => {
  const dedupe = createOutgoingDedupe({ ttlMs: 60_000 });

  assert.equal(dedupe.claim({ chatGuid: "chat-1", text: "same reply" }).ok, true);
  assert.equal(dedupe.claim({ chatGuid: "chat-2", text: "same reply" }).ok, true);
});

test("release allows a failed send to be retried", () => {
  const dedupe = createOutgoingDedupe({ ttlMs: 60_000 });

  const claim = dedupe.claim({ chatGuid: "chat-1", text: "same reply" });
  assert.equal(claim.ok, true);

  dedupe.release(claim.key);

  assert.equal(dedupe.claim({ chatGuid: "chat-1", text: "same reply" }).ok, true);
});
