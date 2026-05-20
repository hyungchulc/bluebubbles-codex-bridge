import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSteerFallbackIncoming,
  formatSteerNote,
  parseSteerCommand,
} from "../src/steer-command.js";

test("parses /steer as a bridge-side steering command", () => {
  assert.deepEqual(parseSteerCommand("/steer keep this focused"), {
    note: "keep this focused",
  });
  assert.equal(parseSteerCommand("keep this focused"), null);
  assert.equal(parseSteerCommand("steer 단어만 있으면 바로 steer로 들어가나"), null);
});

test("formats /steer text as a bridge-side steering note", () => {
  const promptText = formatSteerNote("use page 47 of the 68-page draft");

  assert.equal(promptText, "use page 47 of the 68-page draft");
  assert.equal(formatSteerNote(""), "");
});

test("formats /steer text with downloaded attachments", () => {
  const promptText = formatSteerNote("look at this", {
    downloadedAttachments: [
      {
        transferName: "screenshot.png",
        outputPath: "/example/local-assistant/state/attachments/guid/screenshot.png",
        mimeType: "image/png",
      },
    ],
  });

  assert.match(promptText, /^look at this/);
  assert.match(promptText, /Steer attachments downloaded locally/);
  assert.match(
    promptText,
    /screenshot\.png: \/example\/local-assistant\/state\/attachments\/guid\/screenshot\.png \(image\/png\)/,
  );
});

test("builds a regular-message fallback without the /steer prefix", () => {
  const incoming = {
    guid: "message-guid",
    chatGuid: "any;-;person@example.com",
    text: "/steer look at the screenshot",
    attachments: [{ guid: "attachment-guid" }],
  };
  const fallback = buildSteerFallbackIncoming(incoming, {
    note: "look at the screenshot",
  });

  assert.equal(fallback.guid, incoming.guid);
  assert.equal(fallback.chatGuid, incoming.chatGuid);
  assert.equal(fallback.text, "look at the screenshot");
  assert.deepEqual(fallback.attachments, incoming.attachments);
});
