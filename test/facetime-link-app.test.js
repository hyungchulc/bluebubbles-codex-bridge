import test from "node:test";
import assert from "node:assert/strict";
import { extractFaceTimeLink, launchFaceTimeLinkApp } from "../src/facetime-link-app.js";

test("extracts only FaceTime links from BlueBubbles results", () => {
  assert.equal(
    extractFaceTimeLink({
      data: {
        link: "https://facetime.apple.com/join#v=1&p=abc&k=def",
      },
    }),
    "https://facetime.apple.com/join#v=1&p=abc&k=def",
  );
  assert.equal(extractFaceTimeLink({ data: { link: "https://example.com" } }), "");
  assert.equal(extractFaceTimeLink({ status: 201 }), "");
});

test("does not launch when disabled or link is missing", () => {
  assert.deepEqual(
    launchFaceTimeLinkApp({
      link: "https://facetime.apple.com/join#v=1&p=abc&k=def",
      callUuid: "CALL-1",
      config: { faceTimeLinkAppEnabled: false },
    }),
    { ok: false, skipped: true, reason: "disabled" },
  );

  assert.deepEqual(
    launchFaceTimeLinkApp({
      link: "",
      callUuid: "CALL-1",
      config: { faceTimeLinkAppEnabled: true },
    }),
    { ok: false, skipped: true, reason: "missing_link" },
  );
});
