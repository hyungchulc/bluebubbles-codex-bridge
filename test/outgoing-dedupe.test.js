import assert from "node:assert/strict";
import test from "node:test";

import {
  createOutgoingDedupe,
  findRecentOutgoingTextDuplicate,
  isRecentOutgoingTextDuplicate,
} from "../src/outgoing-dedupe.js";

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

test("supports longer TTLs for high-risk outgoing text", () => {
  let currentTime = 1_000;
  const dedupe = createOutgoingDedupe({
    ttlMs: 60_000,
    ttlMsForClaim: ({ text }) => (text.startsWith("Hourly Market Now") ? 600_000 : 60_000),
    now: () => currentTime,
  });

  assert.equal(
    dedupe.claim({ chatGuid: "chat-1", text: "Hourly Market Now - sample" }).ok,
    true,
  );

  currentTime += 120_000;
  assert.equal(
    dedupe.claim({ chatGuid: "chat-1", text: "Hourly Market Now - sample" }).ok,
    false,
  );

  currentTime += 480_001;
  assert.equal(
    dedupe.claim({ chatGuid: "chat-1", text: "Hourly Market Now - sample" }).ok,
    true,
  );
});

test("detects duplicate outgoing text from recent delivered message records", () => {
  const records = [
    {
      guid: "sent-1",
      chatGuid: "chat-1",
      handle: "user@example.com",
      text: "Hourly Market Now - sample\n\nsame body",
      isFromMe: true,
      seenAt: "2026-05-08T14:02:36.500Z",
    },
  ];

  assert.equal(
    isRecentOutgoingTextDuplicate({
      records,
      chatGuid: "chat-1",
      text: "Hourly Market Now - sample\r\n\r\nsame body",
      ttlMs: 600_000,
      now: Date.parse("2026-05-08T14:04:13.000Z"),
    }),
    true,
  );
  assert.equal(
    findRecentOutgoingTextDuplicate({
      records,
      chatGuid: "chat-1",
      text: "Hourly Market Now - sample\r\n\r\nsame body",
      ttlMs: 600_000,
      now: Date.parse("2026-05-08T14:04:13.000Z"),
    })?.guid,
    "sent-1",
  );
});

test("detects short exact duplicates when caller chooses a recent-delivery window", () => {
  const records = [
    {
      chatGuid: "chat-1",
      text: "short progress update",
      isFromMe: true,
      seenAt: "2026-05-08T14:25:51.000Z",
    },
  ];

  assert.equal(
    isRecentOutgoingTextDuplicate({
      records,
      chatGuid: "chat-1",
      text: "short progress update",
      ttlMs: 600_000,
      now: Date.parse("2026-05-08T14:26:01.000Z"),
    }),
    true,
  );
});

test("matches recent outgoing records when only handle or chatGuid survives restart", () => {
  const records = [
    {
      guid: "sent-with-handle-only",
      chatGuid: null,
      handle: "user@example.com",
      text: "progress update",
      isFromMe: true,
      seenAt: "2026-05-08T14:25:51.000Z",
    },
    {
      guid: "sent-with-chat-only",
      chatGuid: "chat-1",
      handle: null,
      text: "other progress update",
      isFromMe: true,
      seenAt: "2026-05-08T14:25:52.000Z",
    },
  ];

  assert.equal(
    isRecentOutgoingTextDuplicate({
      records,
      chatGuid: "chat-1",
      address: "user@example.com",
      text: "progress update",
      ttlMs: 600_000,
      now: Date.parse("2026-05-08T14:26:01.000Z"),
    }),
    true,
  );
  assert.equal(
    isRecentOutgoingTextDuplicate({
      records,
      chatGuid: "chat-1",
      address: "user@example.com",
      text: "other progress update",
      ttlMs: 600_000,
      now: Date.parse("2026-05-08T14:26:01.000Z"),
    }),
    true,
  );
});

test("uses Date.now by default for recent delivered message records", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-05-08T14:26:01.000Z");
  try {
    assert.equal(
      isRecentOutgoingTextDuplicate({
        records: [
          {
            chatGuid: "chat-1",
            text: "short progress update",
            isFromMe: true,
            seenAt: "2026-05-08T14:25:51.000Z",
          },
        ],
        chatGuid: "chat-1",
        text: "short progress update",
        ttlMs: 600_000,
      }),
      true,
    );
  } finally {
    Date.now = originalNow;
  }
});

test("ignores expired or different-target outgoing message records", () => {
  const records = [
    {
      chatGuid: "chat-1",
      text: "same body",
      isFromMe: true,
      seenAt: "2026-05-08T14:02:36.500Z",
    },
  ];

  assert.equal(
    isRecentOutgoingTextDuplicate({
      records,
      chatGuid: "chat-1",
      text: "same body",
      ttlMs: 60_000,
      now: Date.parse("2026-05-08T14:04:13.000Z"),
    }),
    false,
  );
  assert.equal(
    isRecentOutgoingTextDuplicate({
      records,
      chatGuid: "chat-2",
      text: "same body",
      ttlMs: 600_000,
      now: Date.parse("2026-05-08T14:04:13.000Z"),
    }),
    false,
  );
});
