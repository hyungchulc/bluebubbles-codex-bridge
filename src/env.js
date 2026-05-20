import fs from "node:fs";
import os from "node:os";
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
  const dataDir =
    process.env.BRIDGE_DATA_DIR ||
    path.join(os.homedir(), ".bluebubbles-codex-bridge");
  const stateDir = process.env.BRIDGE_STATE_DIR || path.join(dataDir, "state");
  const logDir = process.env.BRIDGE_LOG_DIR || path.join(dataDir, "logs");
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
    faceTimeAutoAnswer: parseBool(process.env.FACETIME_AUTO_ANSWER, false),
    faceTimeAutoAnswerAllowedCallers: parseList(
      process.env.FACETIME_AUTO_ANSWER_ALLOWED_CALLERS,
      normalizeFaceTimeCallerForConfig,
    ),
    faceTimeAutoAnswerTimeoutMs: Number(
      process.env.FACETIME_AUTO_ANSWER_TIMEOUT_MS || 60_000,
    ),
    faceTimeLinkAppEnabled: parseBool(
      process.env.FACETIME_LINK_APP_ENABLED,
      false,
    ),
    faceTimeLinkAppScript: process.env.FACETIME_LINK_APP_SCRIPT || "",
    faceTimeLinkAppPython:
      process.env.FACETIME_LINK_APP_PYTHON || "/usr/bin/python3",
    faceTimeLinkAppLogDir:
      process.env.FACETIME_LINK_APP_LOG_DIR ||
      path.join(logDir, "facetime-link-app"),
    faceTimeLinkAppDebugPort: Number(
      process.env.FACETIME_LINK_APP_DEBUG_PORT || 9333,
    ),
    faceTimeLinkAppJoinName:
      process.env.FACETIME_LINK_APP_JOIN_NAME || "Assistant",
    faceTimeLinkAdmitTimeoutMs: Number(
      process.env.FACETIME_LINK_ADMIT_TIMEOUT_MS || 30_000,
    ),
    faceTimeLinkJoinTimeoutMs: Number(
      process.env.FACETIME_LINK_JOIN_TIMEOUT_MS || 35_000,
    ),
    faceTimeAudioProbeEnabled: parseBool(
      process.env.FACETIME_AUDIO_PROBE_ENABLED,
      false,
    ),
    faceTimeAudioProbeFfmpeg:
      process.env.FACETIME_AUDIO_PROBE_FFMPEG || "ffmpeg",
    faceTimeAudioProbeInput:
      process.env.FACETIME_AUDIO_PROBE_INPUT || ":0",
    faceTimeAudioProbeDir:
      process.env.FACETIME_AUDIO_PROBE_DIR ||
      path.join(stateDir, "facetime-audio", "probes"),
    faceTimeAudioProbeDelayMs: Number(
      process.env.FACETIME_AUDIO_PROBE_DELAY_MS || 1500,
    ),
    faceTimeAudioProbeDurationSeconds: Number(
      process.env.FACETIME_AUDIO_PROBE_DURATION_SECONDS || 12,
    ),
    faceTimeAudioProbeTranscribe: parseBool(
      process.env.FACETIME_AUDIO_PROBE_TRANSCRIBE,
      false,
    ),
    codexRemoteDebugUrl:
      process.env.CODEX_REMOTE_DEBUG_URL || "http://127.0.0.1:9229",
    codexAppPath: process.env.CODEX_APP_PATH || "/Applications/Codex.app",
    codexWakeBeforePrompt: parseBool(process.env.CODEX_WAKE_BEFORE_PROMPT, true),
    codexWakeAllTargetsBeforePrompt: parseBool(
      process.env.CODEX_WAKE_ALL_TARGETS_BEFORE_PROMPT,
      false,
    ),
    codexWakeAppBeforePrompt: parseBool(
      process.env.CODEX_WAKE_APP_BEFORE_PROMPT,
      false,
    ),
    codexBringToFrontBeforePrompt: parseBool(
      process.env.CODEX_BRING_TO_FRONT_BEFORE_PROMPT,
      false,
    ),
    codexRendererKeepAliveMs: Number(
      process.env.CODEX_RENDERER_KEEPALIVE_MS || 0,
    ),
    codexPreferredThreadId: process.env.CODEX_PREFERRED_THREAD_ID || "",
    codexPreferredThreadTitle: process.env.CODEX_PREFERRED_THREAD_TITLE || "",
    codexPreferredThreadTimeoutMs: Number(
      process.env.CODEX_PREFERRED_THREAD_TIMEOUT_MS || 60_000,
    ),
    codexPostRestartThreadDelayMs: Number(
      process.env.CODEX_POST_RESTART_THREAD_DELAY_MS || 30_000,
    ),
    codexPostRestartReadyTimeoutMs: Number(
      process.env.CODEX_POST_RESTART_READY_TIMEOUT_MS ||
        process.env.CODEX_POST_RESTART_THREAD_DELAY_MS ||
        60_000,
    ),
    codexReadyModelTexts: parseList(process.env.CODEX_READY_MODEL_TEXT || "5.5"),
    codexReadyReasoningTexts: parseList(
      process.env.CODEX_READY_REASONING_TEXT || "High",
    ),
    codexReadyStatePath:
      process.env.CODEX_READY_STATE_PATH ||
      path.join(stateDir, "codex-ui-ready-state.json"),
    codexDesiredStatePath:
      process.env.CODEX_DESIRED_STATE_PATH ||
      path.join(stateDir, "codex-ui-desired-state.json"),
    codexConfigPath:
      process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), ".codex", "config.toml"),
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
    memoryContextEnabled: parseBool(
      process.env.MEMORY_CONTEXT_ENABLED,
      Boolean(process.env.MEMORY_CONTEXT_SCRIPT),
    ),
    memoryContextPython:
      process.env.MEMORY_CONTEXT_PYTHON || "python3",
    memoryContextScript: process.env.MEMORY_CONTEXT_SCRIPT || "",
    memoryContextLimit: Number(process.env.MEMORY_CONTEXT_LIMIT || 4),
    memoryContextClip: Number(process.env.MEMORY_CONTEXT_CLIP || 220),
    memoryContextTimeoutMs: Number(process.env.MEMORY_CONTEXT_TIMEOUT_MS || 2500),
    memoryContextMinScore: Number(process.env.MEMORY_CONTEXT_MIN_SCORE || 35),
    currentContextTimeZone:
      process.env.CURRENT_CONTEXT_TIME_ZONE || "",
    currentLocationEnabled: parseBool(
      process.env.CURRENT_LOCATION_ENABLED,
      false,
    ),
    currentLocationTokenPath: process.env.CURRENT_LOCATION_TOKEN_PATH || "",
    currentLocationRefreshUrl:
      process.env.CURRENT_LOCATION_REFRESH_URL ||
      "http://127.0.0.1:43123/refresh",
    currentLocationCurrentUrl:
      process.env.CURRENT_LOCATION_CURRENT_URL ||
      "http://127.0.0.1:43123/current",
    currentLocationTimeoutMs: Number(
      process.env.CURRENT_LOCATION_TIMEOUT_MS || 35_000,
    ),
    currentLocationStopBin: process.env.CURRENT_LOCATION_STOP_BIN || "",
    currentLocationTimeZoneDbPath:
      process.env.CURRENT_LOCATION_TIME_ZONE_DB_PATH ||
      "/usr/share/zoneinfo/zone.tab",
  };
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseList(value, normalize = (item) => item) {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim())
      .map((item) => normalize(item))
      .filter(Boolean),
  );
}

function normalizeFaceTimeCallerForConfig(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("@")) return text;
  return text.replace(/[\s().-]/g, "");
}
