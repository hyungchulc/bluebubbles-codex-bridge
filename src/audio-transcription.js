import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
]);

export class AudioTranscriber {
  constructor({
    apiKey,
    baseUrl = "https://api.openai.com",
    model = "gpt-4o-mini-transcribe",
    timeoutMs = 60_000,
    maxBytes = 25 * 1024 * 1024,
    maxDurationSeconds = 60,
    cachePath = path.resolve(process.cwd(), "state/audio-transcripts.json"),
    fetchImpl = fetch,
    probeDurationImpl = probeAudioDurationSeconds,
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxDurationSeconds = maxDurationSeconds;
    this.cachePath = cachePath;
    this.fetchImpl = fetchImpl;
    this.probeDurationImpl = probeDurationImpl;
    this.cache = loadCache(cachePath);
  }

  async transcribe(downloadedAttachment) {
    if (!this.apiKey) {
      return {
        status: "skipped",
        reason: "missing_openai_api_key",
        attachment: summarizeAttachment(downloadedAttachment),
      };
    }
    if (!isAudioAttachment(downloadedAttachment)) {
      return {
        status: "skipped",
        reason: "not_audio",
        attachment: summarizeAttachment(downloadedAttachment),
      };
    }
    if (downloadedAttachment.error) {
      return {
        status: "skipped",
        reason: "download_failed",
        attachment: summarizeAttachment(downloadedAttachment),
      };
    }
    const filePath = downloadedAttachment.outputPath;
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        status: "skipped",
        reason: "missing_file",
        attachment: summarizeAttachment(downloadedAttachment),
      };
    }

    const stat = fs.statSync(filePath);
    if (stat.size > this.maxBytes) {
      return {
        status: "skipped",
        reason: "file_too_large",
        bytes: stat.size,
        maxBytes: this.maxBytes,
        attachment: summarizeAttachment(downloadedAttachment),
      };
    }

    const durationSeconds = await this.probeDurationImpl(filePath);
    if (
      Number.isFinite(durationSeconds) &&
      this.maxDurationSeconds > 0 &&
      durationSeconds > this.maxDurationSeconds
    ) {
      return {
        status: "skipped",
        reason: "duration_too_long",
        durationSeconds,
        maxDurationSeconds: this.maxDurationSeconds,
        attachment: summarizeAttachment(downloadedAttachment),
      };
    }

    const cacheKey = cacheKeyForFile(filePath, stat);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        status: "cached",
        attachment: summarizeAttachment(downloadedAttachment),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const bytes = fs.readFileSync(filePath);
      const form = new FormData();
      form.set("model", this.model);
      form.set("file", new Blob([bytes], { type: mimeTypeForPath(filePath) }), path.basename(filePath));
      form.set("response_format", "json");

      const response = await this.fetchImpl(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });
      const data = await readJsonOrText(response);
      if (!response.ok) {
        return {
          status: "error",
          error: `OpenAI transcription failed (${response.status})`,
          detail: safeErrorDetail(data),
          attachment: summarizeAttachment(downloadedAttachment),
        };
      }
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      const result = {
        status: "ok",
        model: this.model,
        text,
        bytes: stat.size,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      };
      this.cache.set(cacheKey, result);
      saveCache(this.cachePath, this.cache);
      return {
        ...result,
        attachment: summarizeAttachment(downloadedAttachment),
      };
    } catch (error) {
      return {
        status: "error",
        error:
          error?.name === "AbortError"
            ? `OpenAI transcription timed out after ${this.timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error),
        attachment: summarizeAttachment(downloadedAttachment),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function isAudioAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || "").toLowerCase();
  if (mimeType.startsWith("audio/")) return true;
  const name = String(attachment?.transferName || attachment?.outputPath || "");
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export async function transcribeAudioAttachments(attachments, transcriber) {
  const results = [];
  for (const attachment of attachments) {
    if (!isAudioAttachment(attachment)) continue;
    results.push(await transcriber.transcribe(attachment));
  }
  return results;
}

export function formatAudioTranscripts(transcripts) {
  const usable = transcripts.filter((item) => item.status === "ok" || item.status === "cached");
  const failed = transcripts.filter((item) => item.status === "error");
  const skipped = transcripts.filter((item) => item.status === "skipped");
  const lines = [];
  for (const item of usable) {
    lines.push(
      `- ${item.attachment.transferName || item.attachment.guid || "audio"}: ${item.text || "[empty transcript]"}`,
    );
  }
  for (const item of failed) {
    lines.push(
      `- ${item.attachment.transferName || item.attachment.guid || "audio"}: [transcription failed: ${item.error}]`,
    );
  }
  for (const item of skipped) {
    lines.push(
      `- ${item.attachment.transferName || item.attachment.guid || "audio"}: [not transcribed: ${formatSkipReason(item)}]`,
    );
  }
  return lines.join("\n");
}

export async function probeAudioDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nk=1:nw=1",
      filePath,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

function summarizeAttachment(attachment) {
  return {
    guid: attachment?.guid || null,
    outputPath: attachment?.outputPath || null,
    transferName: attachment?.transferName || null,
    mimeType: attachment?.mimeType || null,
  };
}

function cacheKeyForFile(filePath, stat) {
  const hash = crypto.createHash("sha256");
  hash.update(filePath);
  hash.update(String(stat.size));
  hash.update(String(stat.mtimeMs));
  return hash.digest("hex");
}

function loadCache(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return new Map();
    const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(Object.fromEntries(cache), null, 2)}\n`);
}

function mimeTypeForPath(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
    case ".mpga":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    default:
      return "application/octet-stream";
  }
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function safeErrorDetail(data) {
  if (!data) return null;
  if (typeof data === "string") return data.slice(0, 500);
  const message = data?.error?.message || data?.message;
  return typeof message === "string" ? message.slice(0, 500) : null;
}

function formatSkipReason(item) {
  if (item.reason === "duration_too_long") {
    return `duration ${formatSeconds(item.durationSeconds)} > ${formatSeconds(item.maxDurationSeconds)}`;
  }
  if (item.reason === "file_too_large") {
    return `file too large ${item.bytes} > ${item.maxBytes} bytes`;
  }
  return item.reason || "skipped";
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) return "unknown";
  return `${Math.round(value * 10) / 10}s`;
}
