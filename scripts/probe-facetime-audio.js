#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AudioTranscriber } from "../src/audio-transcription.js";
import { loadDotEnv } from "../src/env.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
loadDotEnv(path.join(repoRoot, ".env"));

const seconds = Number(process.argv[2] || process.env.FACETIME_AUDIO_PROBE_SECONDS || 4);
const device = process.argv[3] || process.env.FACETIME_AUDIO_DEVICE || "0";
const outputDir =
  process.env.FACETIME_AUDIO_PROBE_DIR ||
  path.join(os.homedir(), ".bluebubbles-codex-bridge", "state", "facetime-audio");
const outputPath = path.join(
  outputDir,
  `facetime-audio-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
);

fs.mkdirSync(outputDir, { recursive: true });

const ffmpegArgs = [
  "-hide_banner",
  "-loglevel",
  "warning",
  "-y",
  "-f",
  "avfoundation",
  "-i",
  `:${device}`,
  "-t",
  String(seconds),
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "pcm_s16le",
  outputPath,
];

await run("ffmpeg", ffmpegArgs);

const transcriber = new AudioTranscriber({
  apiKey: process.env.OPENAI_API_KEY || "",
  baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
  model: process.env.AUDIO_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
  timeoutMs: Number(process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS || 60_000),
  maxDurationSeconds: Math.max(seconds + 5, 15),
});

const result = await transcriber.transcribe({
  outputPath,
  transferName: path.basename(outputPath),
  mimeType: "audio/wav",
});

console.log(
  JSON.stringify(
    {
      ok: result.status === "ok" || result.status === "cached",
      device,
      seconds,
      outputPath,
      result,
    },
    null,
    2,
  ),
);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} exited ${code}: ${stderr || stdout}`);
      error.code = code;
      error.stderr = stderr;
      error.stdout = stdout;
      reject(error);
    });
  });
}
