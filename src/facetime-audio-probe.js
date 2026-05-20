import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function scheduleFaceTimeAudioProbe({ callUuid, mode }, config, { transcriber } = {}) {
  if (!config.faceTimeAudioProbeEnabled) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  const safeCallUuid = safeSlug(callUuid || "unknown-call");
  const delayMs = Math.max(0, Number(config.faceTimeAudioProbeDelayMs || 0));
  const timer = setTimeout(async () => {
    try {
      const result = await runFaceTimeAudioProbe({ callUuid: safeCallUuid, mode }, config, {
        transcriber,
      });
      console.log(
        `${new Date().toISOString()} facetime audio probe ok ${safeCallUuid} ${formatProbeResult(result)}`,
      );
    } catch (error) {
      console.warn(
        `${new Date().toISOString()} facetime audio probe failed ${safeCallUuid}: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
      );
    }
  }, delayMs);
  timer.unref?.();
  return {
    ok: true,
    scheduled: true,
    callUuid: safeCallUuid,
    delayMs,
    durationSeconds: Number(config.faceTimeAudioProbeDurationSeconds || 0),
    input: config.faceTimeAudioProbeInput,
  };
}

export async function runFaceTimeAudioProbe({ callUuid, mode } = {}, config, { transcriber } = {}) {
  const ffmpeg = config.faceTimeAudioProbeFfmpeg || "ffmpeg";
  const input = config.faceTimeAudioProbeInput || ":0";
  const durationSeconds = Math.max(1, Number(config.faceTimeAudioProbeDurationSeconds || 12));
  const dir =
    config.faceTimeAudioProbeDir ||
    path.join(os.homedir(), ".bluebubbles-codex-bridge", "state", "facetime-audio", "probes");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeCallUuid = safeSlug(callUuid || "manual");
  const outputPath = path.join(dir, `${stamp}-${safeCallUuid}.wav`);

  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "avfoundation",
      "-i",
      input,
      "-t",
      String(durationSeconds),
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    {
      timeout: Math.ceil((durationSeconds + 8) * 1000),
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  const volume = await probeVolume(ffmpeg, outputPath);
  const stat = fs.statSync(outputPath);
  let transcript = null;
  if (config.faceTimeAudioProbeTranscribe && transcriber && volume.hasSignal) {
    transcript = await transcriber.transcribe({
      guid: `facetime-audio-probe:${safeCallUuid}`,
      outputPath,
      transferName: path.basename(outputPath),
      mimeType: "audio/wav",
    });
  }

  return {
    callUuid: safeCallUuid,
    mode: mode || null,
    input,
    outputPath,
    bytes: stat.size,
    durationSeconds,
    volume,
    transcript,
  };
}

async function probeVolume(ffmpeg, filePath) {
  const { stderr } = await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const meanVolume = parseDb(stderr, /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const maxVolume = parseDb(stderr, /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  return {
    meanDb: meanVolume,
    maxDb: maxVolume,
    hasSignal: Number.isFinite(maxVolume) ? maxVolume > -55 : false,
  };
}

function parseDb(text, pattern) {
  const match = String(text || "").match(pattern);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function formatProbeResult(result) {
  const transcriptText =
    result.transcript?.status === "ok" || result.transcript?.status === "cached"
      ? ` transcript=${JSON.stringify(result.transcript.text || "")}`
      : "";
  return [
    `mode=${result.mode || "unknown"}`,
    `input=${result.input}`,
    `file=${result.outputPath}`,
    `bytes=${result.bytes}`,
    `meanDb=${result.volume.meanDb ?? "unknown"}`,
    `maxDb=${result.volume.maxDb ?? "unknown"}`,
    `hasSignal=${result.volume.hasSignal}`,
    transcriptText.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

function safeSlug(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "unknown";
}
