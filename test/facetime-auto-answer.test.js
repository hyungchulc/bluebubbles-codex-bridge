import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFaceTimeCallStatus,
  getFaceTimeCallerKeys,
  normalizeFaceTimeCaller,
  shouldAutoAnswerFaceTimeCall,
} from "../src/facetime-auto-answer.js";

test("extracts BlueBubbles FaceTime call status events", () => {
  const event = extractFaceTimeCallStatus({
    type: "ft-call-status-changed",
    data: {
      uuid: "CALL-1",
      status: "incoming",
      status_id: 4,
      address: "+1 (555) 000-1234",
      is_outgoing: false,
    },
  });

  assert.equal(event.uuid, "CALL-1");
  assert.equal(event.status, "incoming");
  assert.equal(event.statusId, 4);
  assert.equal(event.address, "+1 (555) 000-1234");
  assert.equal(event.isOutgoing, false);
});

test("ignores non FaceTime events", () => {
  assert.equal(extractFaceTimeCallStatus({ type: "new-message", data: {} }), null);
});

test("requires auto-answer to be enabled and caller allowlisted", () => {
  const event = {
    uuid: "CALL-1",
    status: "incoming",
    statusId: 4,
    address: "+15550001234",
    isOutgoing: false,
  };

  assert.equal(
    shouldAutoAnswerFaceTimeCall(event, {
      enabled: false,
      allowedCallers: new Set(["+15550001234"]),
    }).reason,
    "disabled",
  );
  assert.equal(
    shouldAutoAnswerFaceTimeCall(event, {
      enabled: true,
      allowedCallers: new Set(),
    }).reason,
    "no_allowed_callers",
  );
  assert.deepEqual(
    shouldAutoAnswerFaceTimeCall(event, {
      enabled: true,
      allowedCallers: new Set(["+15550001234"]),
    }),
    { ok: true },
  );
});

test("rejects outgoing and disconnected FaceTime events", () => {
  assert.equal(
    shouldAutoAnswerFaceTimeCall(
      {
        uuid: "CALL-1",
        status: "incoming",
        statusId: 4,
        address: "+15550001234",
        isOutgoing: true,
      },
      { enabled: true, allowedCallers: new Set(["+15550001234"]) },
    ).reason,
    "outgoing_call",
  );
  assert.equal(
    shouldAutoAnswerFaceTimeCall(
      {
        uuid: "CALL-1",
        status: "disconnected",
        statusId: 6,
        address: "+15550001234",
        isOutgoing: false,
      },
      { enabled: true, allowedCallers: new Set(["+15550001234"]) },
    ).reason,
    "not_incoming",
  );
});

test("normalizes caller identifiers", () => {
  assert.equal(normalizeFaceTimeCaller("+1 (555) 000-1234"), "+15550001234");
  assert.equal(normalizeFaceTimeCaller("USER@EXAMPLE.COM"), "user@example.com");
  assert.deepEqual(getFaceTimeCallerKeys("+1 555 000 1234"), [
    "+15550001234",
    "15550001234",
  ]);
});
