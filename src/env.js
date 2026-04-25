import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function getConfig() {
  loadDotEnv();
  const bridgeStateDir =
    process.env.BRIDGE_STATE_DIR || path.resolve(process.cwd(), "state");
  return {
    bridgeHost: process.env.BRIDGE_HOST || "127.0.0.1",
    bridgePort: Number(process.env.BRIDGE_PORT || 3099),
    blueBubblesBaseUrl:
      process.env.BLUEBUBBLES_BASE_URL || "http://127.0.0.1:1234",
    blueBubblesPassword: process.env.BLUEBUBBLES_PASSWORD || "",
    blueBubblesSendTextPath:
      process.env.BLUEBUBBLES_SEND_TEXT_PATH || "/api/v1/message/text",
    blueBubblesThreadedReplies: parseBool(
      process.env.BLUEBUBBLES_THREADED_REPLIES,
      false,
    ),
    codexRemoteDebugUrl:
      process.env.CODEX_REMOTE_DEBUG_URL || "http://127.0.0.1:9229",
    codexAppPath: process.env.CODEX_APP_PATH || "/Applications/Codex.app",
    codexWakeBeforePrompt: parseBool(process.env.CODEX_WAKE_BEFORE_PROMPT, true),
    codexWakeAppBeforePrompt: parseBool(
      process.env.CODEX_WAKE_APP_BEFORE_PROMPT,
      false,
    ),
    codexBringToFrontBeforePrompt: parseBool(
      process.env.CODEX_BRING_TO_FRONT_BEFORE_PROMPT,
      false,
    ),
    codexCdpRequestTimeoutMs: Number(
      process.env.CODEX_CDP_REQUEST_TIMEOUT_MS || 60_000,
    ),
    autoSend: parseBool(process.env.BRIDGE_AUTO_SEND, false),
    outgoingDedupeTtlMs: Number(process.env.OUTGOING_DEDUPE_TTL_MS || 60_000),
    typingIndicatorsEnabled: parseBool(
      process.env.TYPING_INDICATORS_ENABLED,
      false,
    ),
    responseTimeoutMs: Number(process.env.CODEX_RESPONSE_TIMEOUT_MS || 900000),
    allowedChatGuids: parseList(process.env.ALLOWED_CHAT_GUIDS),
    allowedHandles: parseList(process.env.ALLOWED_HANDLES),
    bridgeSystemPrompt: process.env.BRIDGE_SYSTEM_PROMPT || "",
    bridgeSystemPromptFile: process.env.BRIDGE_SYSTEM_PROMPT_FILE || "",
    bridgeStateDir,
    attachmentRoot:
      process.env.ATTACHMENT_DIR || path.join(bridgeStateDir, "attachments"),
    messageIndexPath:
      process.env.MESSAGE_INDEX_PATH ||
      path.join(bridgeStateDir, "bluebubbles-message-index.jsonl"),
    incomingJobLogPath:
      process.env.INCOMING_JOB_LOG_PATH ||
      path.join(bridgeStateDir, "bluebubbles-incoming-jobs.jsonl"),
    audioTranscriptCachePath:
      process.env.AUDIO_TRANSCRIPT_CACHE_PATH ||
      path.join(bridgeStateDir, "audio-transcripts.json"),
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(
      /\/+$/,
      "",
    ),
    audioTranscriptionEnabled: parseBool(
      process.env.AUDIO_TRANSCRIPTION_ENABLED,
      true,
    ),
    audioTranscriptionModel:
      process.env.AUDIO_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
    audioTranscriptionTimeoutMs: Number(
      process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS || 60_000,
    ),
    audioTranscriptionMaxBytes: Number(
      process.env.AUDIO_TRANSCRIPTION_MAX_BYTES || 25 * 1024 * 1024,
    ),
    audioTranscriptionMaxDurationSeconds: Number(
      process.env.AUDIO_TRANSCRIPTION_MAX_DURATION_SECONDS || 60,
    ),
  };
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseList(value) {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}
