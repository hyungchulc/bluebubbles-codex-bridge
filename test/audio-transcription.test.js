import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AudioTranscriber,
  formatAudioTranscripts,
  isAudioAttachment,
} from "../src/audio-transcription.js";

test("detects audio attachments by mime type or extension", () => {
  assert.equal(isAudioAttachment({ mimeType: "audio/mp3" }), true);
  assert.equal(isAudioAttachment({ transferName: "voice.m4a" }), true);
  assert.equal(isAudioAttachment({ outputPath: "/tmp/voice.mp3" }), true);
  assert.equal(isAudioAttachment({ transferName: "photo.jpg", mimeType: "image/jpeg" }), false);
});

test("skips transcription when OpenAI API key is missing", async () => {
  const transcriber = new AudioTranscriber({ apiKey: "" });

  const result = await transcriber.transcribe({
    outputPath: "/tmp/missing.mp3",
    transferName: "missing.mp3",
    mimeType: "audio/mpeg",
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "missing_openai_api_key");
});

test("posts audio to OpenAI transcription API", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-audio-test-"));
  const filePath = path.join(dir, "voice.mp3");
  fs.writeFileSync(filePath, "fake audio");
  const calls = [];
  const transcriber = new AudioTranscriber({
    apiKey: "test-key",
    cachePath: path.join(dir, "cache.json"),
    probeDurationImpl: async () => 4.38,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Bearer test-key");
      assert.equal(options.body.get("model"), "gpt-4o-mini-transcribe");
      assert.equal(options.body.get("response_format"), "json");
      assert.equal(options.body.get("file").type, "audio/mpeg");
      return new Response(JSON.stringify({ text: "오케이 알겠어" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await transcriber.transcribe({
    outputPath: filePath,
    transferName: "voice.mp3",
    mimeType: "audio/mpeg",
  });

  assert.equal(calls.length, 1);
  assert.equal(result.status, "ok");
  assert.equal(result.text, "오케이 알겠어");
  assert.equal(result.durationSeconds, 4.38);

  const cached = await transcriber.transcribe({
    outputPath: filePath,
    transferName: "voice.mp3",
    mimeType: "audio/mpeg",
  });
  assert.equal(calls.length, 1);
  assert.equal(cached.status, "cached");
  assert.equal(cached.text, "오케이 알겠어");
});

test("skips long audio before calling OpenAI", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-audio-test-"));
  const filePath = path.join(dir, "long.mp3");
  fs.writeFileSync(filePath, "fake long audio");
  let called = false;
  const transcriber = new AudioTranscriber({
    apiKey: "test-key",
    maxDurationSeconds: 60,
    cachePath: path.join(dir, "cache.json"),
    probeDurationImpl: async () => 61.2,
    fetchImpl: async () => {
      called = true;
      return new Response(JSON.stringify({ text: "should not happen" }), { status: 200 });
    },
  });

  const result = await transcriber.transcribe({
    outputPath: filePath,
    transferName: "long.mp3",
    mimeType: "audio/mpeg",
  });

  assert.equal(called, false);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "duration_too_long");
  assert.equal(result.durationSeconds, 61.2);
  assert.equal(result.maxDurationSeconds, 60);
});

test("formats transcripts for Codex prompt", () => {
  assert.equal(
    formatAudioTranscripts([
      {
        status: "ok",
        text: "오케이 알겠어",
        attachment: { transferName: "Audio Message.mp3" },
      },
      {
        status: "skipped",
        reason: "duration_too_long",
        durationSeconds: 61.2,
        maxDurationSeconds: 60,
        attachment: { transferName: "Long Audio.mp3" },
      },
    ]),
    [
      "- Audio Message.mp3: 오케이 알겠어",
      "- Long Audio.mp3: [not transcribed: duration 61.2s > 60s]",
    ].join("\n"),
  );
});
