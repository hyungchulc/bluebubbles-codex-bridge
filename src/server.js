import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./env.js";
import { BlueBubblesClient, extractIncomingMessage } from "./bluebubbles.js";
import { CodexDesktopCdp } from "./codex-cdp.js";
import { SessionThreadTailScanner } from "./session-log.js";
import {
  createOutgoingDedupe,
  findRecentOutgoingTextDuplicate,
  isRecentOutgoingTextDuplicate,
} from "./outgoing-dedupe.js";
import { createSequentialTaskQueue } from "./native-link-preview-queue.js";
import {
  addPendingReply,
  getLatestPendingReply,
  getPendingReply,
  listPendingReplies,
  removePendingReply,
} from "./pending.js";
import {
  buildGeneratedRichLinkPayload,
  buildNativeRichLinkPreflightDecision,
  buildUrlOnlyRichLinkPayload,
  chooseTextSendRoute,
  isSingleHttpUrl,
  prepareLinkPreviewText,
  splitTextForLinkPreviewMessages,
} from "./link-preview.js";
import { renderMarkdownRichText } from "./rich-text.js";
import {
  AudioTranscriber,
  transcribeAudioAttachments,
} from "./audio-transcription.js";
import {
  buildCurrentContext,
  formatCurrentContext,
} from "./current-context.js";
import { buildIncomingPrompt } from "./incoming-prompt.js";
import { buildMemoryContext } from "./memory-context.js";
import { getIncomingBundleDelayMs } from "./incoming-bundles.js";
import { IncomingJobStore } from "./incoming-jobs.js";
import {
  parseCodexControlCommand,
  parseCodexRawReasoningCommand,
} from "./codex-control-command.js";
import { updateCodexConfigFile } from "./codex-settings.js";
import {
  buildSteerFallbackIncoming,
  formatSteerNote,
  parseSteerCommand,
} from "./steer-command.js";
import {
  extractFaceTimeCallStatus,
  shouldAutoAnswerFaceTimeCall,
} from "./facetime-auto-answer.js";
import {
  extractFaceTimeLink,
  launchFaceTimeLinkApp,
} from "./facetime-link-app.js";
import {
  runFaceTimeAudioProbe,
  scheduleFaceTimeAudioProbe,
} from "./facetime-audio-probe.js";

const config = getConfig();
const blueBubbles = new BlueBubblesClient({
  baseUrl: config.blueBubblesBaseUrl,
  password: config.blueBubblesPassword,
  sendTextPath: config.blueBubblesSendTextPath,
});
const codex = new CodexDesktopCdp({
  remoteDebugUrl: config.codexRemoteDebugUrl,
  responseTimeoutMs: config.responseTimeoutMs,
  cdpRequestTimeoutMs: config.codexCdpRequestTimeoutMs,
  appPath: config.codexAppPath,
  wakeBeforePrompt: config.codexWakeBeforePrompt,
  wakeAllTargetsBeforePrompt: config.codexWakeAllTargetsBeforePrompt,
  wakeAppBeforePrompt: config.codexWakeAppBeforePrompt,
  bringToFrontBeforePrompt: config.codexBringToFrontBeforePrompt,
  preferredThreadId: config.codexPreferredThreadId,
  preferredThreadTitle: config.codexPreferredThreadTitle,
  preferredThreadTimeoutMs: config.codexPreferredThreadTimeoutMs,
  postRestartThreadDelayMs: config.codexPostRestartThreadDelayMs,
  postRestartReadyTimeoutMs: config.codexPostRestartReadyTimeoutMs,
  readyModelTexts: config.codexReadyModelTexts,
  readyReasoningTexts: config.codexReadyReasoningTexts,
  readyStatePath: config.codexReadyStatePath,
  desiredStatePath: config.codexDesiredStatePath,
});
const audioTranscriber = new AudioTranscriber({
  apiKey: config.openaiApiKey,
  baseUrl: config.openaiBaseUrl,
  model: config.audioTranscriptionModel,
  timeoutMs: config.audioTranscriptionTimeoutMs,
  maxBytes: config.audioTranscriptionMaxBytes,
  maxDurationSeconds: config.audioTranscriptionMaxDurationSeconds,
});
const attachmentRoot = process.env.ATTACHMENT_DIR || path.join(process.cwd(), "attachments");
const stateRoot = process.env.BRIDGE_STATE_DIR || path.join(process.cwd(), "state");
const messageIndexPath =
  process.env.MESSAGE_INDEX_PATH || path.join(stateRoot, "bluebubbles-message-index.jsonl");
const threadRelayStatePath =
  process.env.THREAD_RELAY_STATE_PATH || path.join(stateRoot, "bluebubbles-codex-thread-relay.json");
const incomingDedupeTtlMs = 10 * 60 * 1000;
const incomingBundleDelayMs = Number(process.env.INCOMING_BUNDLE_DELAY_MS || 1800);
const incomingLinkBundleDelayMs = Number(process.env.INCOMING_LINK_BUNDLE_DELAY_MS || 8000);
const threadRelayPollMs = Number(process.env.CODEX_THREAD_RELAY_POLL_MS || 1000);
const seenIncoming = new Map();
const pendingIncomingBundles = new Map();
const activeTypingControllers = new Map();
const activeFaceTimeAnswers = new Map();
const recentMessages = loadRecentMessages();
let threadRelayState = loadThreadRelayState();
let threadRelayScanner = createThreadRelayScanner(threadRelayState);
let threadRelayBusy = false;
let managedCodexStreamCount = 0;
const highRiskOutgoingDedupeTtlMs = 10 * 60 * 1000;
const threadRelayOutgoingDedupeTtlMs = 10 * 60 * 1000;
const ambiguousSendReconcileTimeoutMs = 8 * 1000;
const ambiguousSendReconcilePollMs = 500;
const nativeLinkPreviewSendTimeoutMs = Number(
  process.env.NATIVE_LINK_PREVIEW_SEND_TIMEOUT_MS || 20_000,
);
const nativeLinkPreviewPreflightTimeoutMs = Number(
  process.env.NATIVE_LINK_PREVIEW_PREFLIGHT_TIMEOUT_MS || 10_000,
);
const nativeLinkPreviewQueueSettleMs = Number(
  process.env.NATIVE_LINK_PREVIEW_QUEUE_SETTLE_MS || 150,
);
const outgoingLinkPreviewPartDelayMs = Number(
  process.env.OUTGOING_LINK_PREVIEW_PART_DELAY_MS || 150,
);
const nativeLinkPreviewQueue = createSequentialTaskQueue();
const incomingPromptQueue = createSequentialTaskQueue();
const outgoingDedupe = createOutgoingDedupe({
  ttlMs: config.outgoingDedupeTtlMs,
  ttlMsForClaim: ({ text }) => getOutgoingTextDedupeTtlMs(text),
});
const outgoingAttachmentDedupe = createOutgoingDedupe({
  ttlMs: config.outgoingDedupeTtlMs,
});
const incomingJobs = new IncomingJobStore();

const server = http.createServer(async (request, response) => {
  try {
    console.log(`${new Date().toISOString()} ${request.method} ${request.url}`);
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, await health());
    }
    if (request.method === "POST" && url.pathname === "/ask") {
      const body = await readJson(request);
      return sendJson(response, 200, await ask(body?.text));
    }
    if (request.method === "POST" && url.pathname === "/webhook/bluebubbles") {
      const body = await readJson(request);
      return sendJson(response, 202, await handleBlueBubblesWebhook(body));
    }
    if (request.method === "GET" && url.pathname === "/pending") {
      return sendJson(response, 200, { data: listPendingReplies() });
    }
    if (request.method === "GET" && url.pathname === "/incoming-jobs/open") {
      return sendJson(response, 200, { data: incomingJobs.listOpen() });
    }
    if (request.method === "GET" && url.pathname === "/codex/thread-relay") {
      return sendJson(response, 200, publicThreadRelayState());
    }
    if (request.method === "POST" && url.pathname === "/codex/thread-relay/arm") {
      const body = await readJson(request);
      return sendJson(response, 200, armThreadRelayFromBody(body));
    }
    if (request.method === "POST" && url.pathname === "/codex/thread-relay/disable") {
      threadRelayState = {
        ...threadRelayState,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      saveThreadRelayState(threadRelayState);
      return sendJson(response, 200, publicThreadRelayState());
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/read") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.markRead(required(body?.chatGuid, "chatGuid"), body?.messageGuid),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/played") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.markPlayed(
          required(body?.chatGuid, "chatGuid"),
          required(body?.messageGuid, "messageGuid"),
        ),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/unread") {
      const body = await readJson(request);
      return sendJson(response, 200, await blueBubbles.markUnread(required(body?.chatGuid, "chatGuid")));
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/typing/start") {
      const body = await readJson(request);
      if (!config.typingIndicatorsEnabled) {
        return sendJson(response, 200, {
          status: "disabled",
          message: "Typing indicators are disabled for the bridge.",
        });
      }
      return sendJson(response, 200, await blueBubbles.startTyping(required(body?.chatGuid, "chatGuid")));
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/typing/stop") {
      const body = await readJson(request);
      return sendJson(response, 200, await blueBubbles.stopTyping(required(body?.chatGuid, "chatGuid")));
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/session") {
      return sendJson(response, 200, await blueBubbles.createFaceTimeSession());
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/answer") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.answerFaceTimeCall(required(body?.callUuid, "callUuid")),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/answer/raw") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.answerFaceTimeCallRaw(required(body?.callUuid, "callUuid")),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/link") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.generateFaceTimeLink(required(body?.callUuid, "callUuid")),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/active-links") {
      return sendJson(response, 200, await blueBubbles.getFaceTimeActiveLinks());
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/admit-self") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.admitFaceTimeSelf(required(body?.callUuid, "callUuid"), {
          lookbackMs: Number(body?.lookbackMs || 30_000),
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/admit") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.admitFaceTimeParticipant({
          conversationUuid: required(body?.conversationUuid, "conversationUuid"),
          handleUuid: required(body?.handleUuid, "handleUuid"),
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/audio/probe") {
      const body = await readJson(request);
      const probeConfig = {
        ...config,
        faceTimeAudioProbeDurationSeconds: Number(
          body?.durationSeconds || config.faceTimeAudioProbeDurationSeconds,
        ),
        faceTimeAudioProbeInput: body?.input || config.faceTimeAudioProbeInput,
        faceTimeAudioProbeTranscribe: body?.transcribe ?? config.faceTimeAudioProbeTranscribe,
      };
      return sendJson(
        response,
        200,
        await runFaceTimeAudioProbe(
          { callUuid: body?.callUuid || "manual", mode: "manual" },
          probeConfig,
          { transcriber: audioTranscriber },
        ),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/facetime/leave") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.leaveFaceTimeCall(required(body?.callUuid, "callUuid")),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/react") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.sendReaction({
          chatGuid: required(body?.chatGuid, "chatGuid"),
          selectedMessageGuid: required(body?.selectedMessageGuid, "selectedMessageGuid"),
          reaction: required(body?.reaction, "reaction"),
          partIndex: body?.partIndex ?? 0,
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/reply/send") {
      const body = await readJson(request);
      const text = required(body?.text, "text");
      const ddScan = body?.ddScan ?? isSingleHttpUrl(text);
      return sendJson(
        response,
        200,
        await blueBubbles.sendText({
          chatGuid: required(body?.chatGuid, "chatGuid"),
          text: ddScan ? prepareLinkPreviewText(text) : text,
          method: body?.method || "private-api",
          selectedMessageGuid: required(body?.selectedMessageGuid, "selectedMessageGuid"),
          partIndex: body?.partIndex ?? 0,
          ddScan,
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/text/send") {
      const body = await readJson(request);
      const rendered = body?.richText
        ? renderMarkdownRichText(required(body?.text, "text"))
        : { text: required(body?.text, "text"), attributedBody: body?.attributedBody || null };
      const results = await sendTextPartsWithLinkPreviews({
        chatGuid: required(body?.chatGuid, "chatGuid"),
        address: body?.address || null,
        text: rendered.text,
        attributedBody: rendered.attributedBody,
        selectedMessageGuid: body?.selectedMessageGuid || null,
        partIndex: body?.partIndex ?? 0,
      });
      return sendJson(
        response,
        200,
        results.length === 1 ? results[0] : { status: "sent_parts", data: results },
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/attachment/send") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await sendDedupedAttachment({
          chatGuid: required(body?.chatGuid, "chatGuid"),
          filePath: required(body?.filePath, "filePath"),
          name: body?.name || null,
          isAudioMessage: Boolean(body?.isAudioMessage),
          selectedMessageGuid: body?.selectedMessageGuid || null,
          partIndex: body?.partIndex ?? 0,
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/voice/send") {
      const body = await readJson(request);
      const method = body?.method || "private-api";
      const params = {
        chatGuid: required(body?.chatGuid, "chatGuid"),
        filePath: required(body?.filePath, "filePath"),
        name: body?.name || null,
        isAudioMessage: true,
        selectedMessageGuid: body?.selectedMessageGuid || null,
        partIndex: body?.partIndex ?? 0,
      };
      let result;
      try {
        result = await blueBubbles.sendAttachment({
          ...params,
          method,
        });
      } catch (error) {
        if (method === "private-api" && isTimeoutLike(error)) {
          console.warn(
            `${new Date().toISOString()} voice private-api timed out after likely send; not falling back: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return sendJson(response, 202, {
            status: "private_api_timeout_assumed_sent",
            method,
            filePath: params.filePath,
            name: params.name,
            warning: error instanceof Error ? error.message : String(error),
          });
        }
        if (body?.fallbackOnPrivateApiFailure !== true || method !== "private-api") {
          throw error;
        }
        console.warn(
          `${new Date().toISOString()} voice private-api failed, falling back to apple-script attachment: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        result = await blueBubbles.sendAttachment({
          ...params,
          method: "apple-script",
        });
      }
      return sendJson(
        response,
        200,
        result,
      );
    }
    if (request.method === "POST" && url.pathname === "/bluebubbles/attachment/download") {
      const body = await readJson(request);
      return sendJson(
        response,
        200,
        await blueBubbles.downloadAttachment({
          guid: required(body?.guid, "guid"),
          outputPath: body?.outputPath || null,
          force: Boolean(body?.force),
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/audio/transcribe") {
      const body = await readJson(request);
      const filePath = required(body?.filePath, "filePath");
      return sendJson(
        response,
        200,
        await audioTranscriber.transcribe({
          guid: body?.guid || null,
          outputPath: filePath,
          transferName: body?.transferName || path.basename(filePath),
          mimeType: body?.mimeType || null,
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/pending/latest/send") {
      const body = await readJson(request);
      return sendJson(response, 200, await sendLatestPending(body));
    }
    const sendMatch = url.pathname.match(/^\/pending\/([^/]+)\/send$/);
    if (request.method === "POST" && sendMatch) {
      const body = await readJson(request);
      return sendJson(response, 200, await sendPending(sendMatch[1], body));
    }
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(
      `${new Date().toISOString()} request failed ${request.method} ${request.url}: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }`,
    );
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(config.bridgePort, config.bridgeHost, () => {
  console.log(
    `bluebubbles-codex-bridge listening on http://${config.bridgeHost}:${config.bridgePort}`,
  );
  startThreadRelayLoop();
  startCodexRendererKeepAliveLoop();
});

function startCodexRendererKeepAliveLoop() {
  const intervalMs = Number(config.codexRendererKeepAliveMs || 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  const timer = setInterval(() => {
    codex.keepAliveRenderer().catch((error) => {
      console.warn(
        `${new Date().toISOString()} codex renderer keepalive failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, Math.max(5000, intervalMs));
  timer.unref?.();
}

async function health() {
  let codexHealth;
  try {
    codexHealth = await codex.health();
  } catch (error) {
    codexHealth = { ok: false, error: error.message };
  }
  let blueBubblesHealth;
  try {
    blueBubblesHealth = await blueBubbles.ping();
  } catch (error) {
    blueBubblesHealth = { ok: false, error: error.message };
  }
  const openIncomingJobs = incomingJobs.listOpen();
  return {
    ok: Boolean(codexHealth.ok),
    codex: codexHealth,
    blueBubbles: blueBubblesHealth,
    audioTranscription: {
      enabled: config.audioTranscriptionEnabled,
      configured: Boolean(config.openaiApiKey),
      model: config.audioTranscriptionModel,
      maxDurationSeconds: config.audioTranscriptionMaxDurationSeconds,
    },
    faceTimeAutoAnswer: {
      enabled: config.faceTimeAutoAnswer,
      allowedCallersCount: config.faceTimeAutoAnswerAllowedCallers.size,
      activeAnswersCount: activeFaceTimeAnswers.size,
    },
    faceTimeLinkApp: {
      enabled: config.faceTimeLinkAppEnabled,
      script: config.faceTimeLinkAppScript,
      debugPort: config.faceTimeLinkAppDebugPort,
      joinName: config.faceTimeLinkAppJoinName,
    },
    autoSend: config.autoSend,
    threadRelay: publicThreadRelayState(),
    pendingCount: listPendingReplies().length,
    incomingJobsOpenCount: openIncomingJobs.length,
  };
}

function loadThreadRelayState() {
  try {
    if (!fs.existsSync(threadRelayStatePath)) {
      return {
        enabled: false,
        route: null,
        sessionFile: null,
        offset: null,
        updatedAt: null,
      };
    }
    const parsed = JSON.parse(fs.readFileSync(threadRelayStatePath, "utf8"));
    return {
      enabled: Boolean(parsed.enabled),
      route: parsed.route || null,
      sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : null,
      offset: Number.isFinite(Number(parsed.offset)) ? Number(parsed.offset) : null,
      updatedAt: parsed.updatedAt || null,
      reason: parsed.reason || null,
    };
  } catch (error) {
    console.warn(
      `${new Date().toISOString()} failed to load thread relay state: ${formatErrorBrief(error)}`,
    );
    return {
      enabled: false,
      route: null,
      sessionFile: null,
      offset: null,
      updatedAt: null,
      error: formatErrorBrief(error),
    };
  }
}

function saveThreadRelayState(state) {
  fs.mkdirSync(path.dirname(threadRelayStatePath), { recursive: true });
  fs.writeFileSync(threadRelayStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

function createThreadRelayScanner(state) {
  return new SessionThreadTailScanner({ offset: state?.offset ?? null });
}

function publicThreadRelayState() {
  return {
    enabled: Boolean(threadRelayState.enabled),
    chatGuid: threadRelayState.route?.chatGuid || null,
    handle: threadRelayState.route?.handle || null,
    sessionFile: threadRelayState.sessionFile || null,
    offset: threadRelayState.offset ?? null,
    updatedAt: threadRelayState.updatedAt || null,
    reason: threadRelayState.reason || null,
    statePath: threadRelayStatePath,
  };
}

function rememberThreadRelayRoute(incoming) {
  const route = threadRelayRouteFromIncoming(incoming);
  if (!route) return;
  const sessionFile =
    threadRelayState.sessionFile && fs.existsSync(threadRelayState.sessionFile)
      ? threadRelayState.sessionFile
      : null;
  const offset = sessionFile ? fs.statSync(sessionFile).size : null;
  threadRelayState = {
    enabled: Boolean(sessionFile),
    route,
    sessionFile,
    offset,
    updatedAt: new Date().toISOString(),
    reason: sessionFile ? "latest-incoming-route-tail-reset" : "latest-incoming-route",
  };
  threadRelayScanner = createThreadRelayScanner(threadRelayState);
  saveThreadRelayState(threadRelayState);
}

function threadRelayRouteFromIncoming(incoming) {
  const chatGuid =
    incoming?.chatGuid ||
    incoming?.raw?.data?.chats?.[0]?.guid ||
    incoming?.raw?.message?.chats?.[0]?.guid ||
    null;
  const handle = incoming?.handle || null;
  if (!chatGuid && !handle) return null;
  return {
    chatGuid,
    handle,
    partIndex: Number.isFinite(Number(incoming?.partIndex))
      ? Number(incoming.partIndex)
      : 0,
  };
}

function incomingFromThreadRelayRoute(route) {
  return {
    chatGuid: route?.chatGuid || null,
    handle: route?.handle || null,
    partIndex: Number.isFinite(Number(route?.partIndex)) ? Number(route.partIndex) : 0,
    replyContext: {},
    raw: {
      data: route?.chatGuid ? { chats: [{ guid: route.chatGuid }] } : {},
    },
  };
}

function armThreadRelayFromSessionFile({ incoming = null, sessionFile, reason }) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;
  const route = incoming ? threadRelayRouteFromIncoming(incoming) : threadRelayState.route;
  if (!route) return null;
  const offset = fs.statSync(sessionFile).size;
  threadRelayState = {
    enabled: true,
    route,
    sessionFile,
    offset,
    updatedAt: new Date().toISOString(),
    reason,
  };
  threadRelayScanner = createThreadRelayScanner(threadRelayState);
  saveThreadRelayState(threadRelayState);
  console.log(
    `${new Date().toISOString()} thread-relay armed ${sessionFile} offset=${offset} reason=${reason}`,
  );
  return publicThreadRelayState();
}

function armThreadRelayFromBody(body) {
  const sessionFile = required(body?.sessionFile, "sessionFile");
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`sessionFile does not exist: ${sessionFile}`);
  }
  const route = {
    chatGuid: body?.chatGuid || threadRelayState.route?.chatGuid || null,
    handle: body?.handle || body?.address || threadRelayState.route?.handle || null,
    partIndex: Number.isFinite(Number(body?.partIndex)) ? Number(body.partIndex) : 0,
  };
  if (!route.chatGuid && !route.handle) {
    throw new Error("thread relay arm requires chatGuid or handle");
  }
  const offset =
    body?.offset === "start"
      ? 0
      : Number.isFinite(Number(body?.offset))
        ? Number(body.offset)
        : fs.statSync(sessionFile).size;
  threadRelayState = {
    enabled: true,
    route,
    sessionFile,
    offset,
    updatedAt: new Date().toISOString(),
    reason: body?.reason || "manual-arm",
  };
  threadRelayScanner = createThreadRelayScanner(threadRelayState);
  saveThreadRelayState(threadRelayState);
  return publicThreadRelayState();
}

function startThreadRelayLoop() {
  const timer = setInterval(() => {
    pollThreadRelay().catch((error) => {
      console.error(
        `${new Date().toISOString()} thread-relay poll failed: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
      );
    });
  }, Math.max(250, threadRelayPollMs));
  timer.unref?.();
}

async function pollThreadRelay() {
  if (
    threadRelayBusy ||
    managedCodexStreamCount > 0 ||
    !threadRelayState.enabled ||
    !threadRelayState.route ||
    !threadRelayState.sessionFile
  ) {
    return;
  }
  if (!fs.existsSync(threadRelayState.sessionFile)) return;
  threadRelayBusy = true;
  try {
    const hit = threadRelayScanner.scanFile(threadRelayState.sessionFile);
    if (!hit.messages.length) {
      if (hit.offset !== threadRelayState.offset) {
        threadRelayState = {
          ...threadRelayState,
          offset: hit.offset,
          updatedAt: new Date().toISOString(),
          reason: "thread-relay-offset-advanced",
        };
        saveThreadRelayState(threadRelayState);
      }
      return;
    }
    const incoming = incomingFromThreadRelayRoute(threadRelayState.route);
    for (const message of hit.messages) {
      if (
        isRecentOutgoingTextDuplicate({
          records: recentMessages.values(),
          chatGuid: threadRelayState.route.chatGuid,
          address: threadRelayState.route.handle,
          text: message.text,
          ttlMs: threadRelayOutgoingDedupeTtlMs,
        })
      ) {
        console.warn(
          `${new Date().toISOString()} thread-relay skipped recent duplicate ${
            message.phase || "assistant"
          } ${message.id || ""}`,
        );
        continue;
      }
      const sent = await sendReply({
        id: `thread-relay-${Date.now()}`,
        incoming,
        messages: [message],
        text: message.text,
      });
      console.log(
        `${new Date().toISOString()} thread-relay sent ${message.phase || "assistant"} ${
          message.id || ""
        }`,
      );
      void sent;
    }
    threadRelayState = {
      ...threadRelayState,
      offset: hit.offset,
      updatedAt: new Date().toISOString(),
      reason: "thread-relay-sent",
    };
    saveThreadRelayState(threadRelayState);
  } finally {
    threadRelayBusy = false;
  }
}

async function withManagedCodexStream(fn) {
  managedCodexStreamCount += 1;
  try {
    return await fn();
  } finally {
    managedCodexStreamCount -= 1;
  }
}

async function ask(text) {
  if (!text || typeof text !== "string") {
    throw new Error("POST /ask requires JSON body { text: string }");
  }
  const result = await codex.ask(text);
  return {
    requestId: result.requestId,
    reply: result.reply.messages.map((message) => message.text),
    sessionFile: result.reply.file,
  };
}

async function handleBlueBubblesWebhook(payload) {
  console.log(
    `${new Date().toISOString()} webhook payload ${JSON.stringify(payload).slice(0, 1000)}`,
  );
  const faceTimeResult = handleFaceTimeCallStatus(payload);
  if (faceTimeResult) return faceTimeResult;
  const faceTimeAudioRouteResult = handleFaceTimeAudioRoute(payload);
  if (faceTimeAudioRouteResult) return faceTimeAudioRouteResult;

  const incoming = extractIncomingMessage(payload);
  recordMessage(incoming, { source: "webhook" });
  if (!incoming.text && incoming.attachments.length === 0) {
    return { status: "ignored", reason: "empty_message" };
  }
  if (incoming.isFromMe) return { status: "ignored", reason: "from_me" };
  if (incoming.event && incoming.event !== "new-message") {
    return { status: "ignored", reason: "non_new_message_event", event: incoming.event };
  }
  if (!isAllowed(incoming)) {
    return { status: "ignored", reason: "not_allowlisted", incoming };
  }
  const dedupeKey = getIncomingDedupeKey(incoming);
  if (dedupeKey && hasSeenIncoming(dedupeKey)) {
    return { status: "ignored", reason: "duplicate_incoming", dedupeKey };
  }
  if (dedupeKey) rememberIncoming(dedupeKey);

  await markIncomingRead(incoming);
  if (shouldProcessIncomingImmediately(incoming)) {
    console.log(
      `${new Date().toISOString()} incoming ${incoming.guid || "<unknown>"} bypassing bundle queue`,
    );
    return processIncomingBundle([incoming]);
  }
  return enqueueIncomingBundle(incoming);
}

function handleFaceTimeAudioRoute(payload) {
  if (!payload || payload.type !== "ft-audio-route") return null;
  const data = payload.data || {};
  console.log(
    `${new Date().toISOString()} facetime audio route ${data.phase || "unknown"} ${JSON.stringify(data).slice(0, 8000)}`,
  );
  return {
    status: "facetime_audio_route_logged",
    phase: data.phase || null,
  };
}

function handleFaceTimeCallStatus(payload) {
  const event = extractFaceTimeCallStatus(payload);
  if (!event) return null;
  const decision = shouldAutoAnswerFaceTimeCall(event, {
    enabled: config.faceTimeAutoAnswer,
    allowedCallers: config.faceTimeAutoAnswerAllowedCallers,
  });
  if (!decision.ok) {
    return {
      status: "ignored",
      scope: "facetime",
      reason: decision.reason,
      callUuid: event.uuid || null,
      callStatus: event.status || null,
      callStatusId: event.statusId,
    };
  }
  if (activeFaceTimeAnswers.has(event.uuid)) {
    return {
      status: "ignored",
      scope: "facetime",
      reason: "answer_already_in_progress",
      callUuid: event.uuid,
    };
  }

  const answerPromise = answerFaceTimeCallFromWebhook(event);
  activeFaceTimeAnswers.set(event.uuid, answerPromise);
  answerPromise.then(
    () => activeFaceTimeAnswers.delete(event.uuid),
    () => activeFaceTimeAnswers.delete(event.uuid),
  );
  return {
    status: "facetime_auto_answer_started",
    callUuid: event.uuid,
    address: redactCaller(event.address),
  };
}

async function answerFaceTimeCallFromWebhook(event) {
  console.log(
    `${new Date().toISOString()} facetime auto-answer start ${event.uuid} ${redactCaller(event.address)}`,
  );
  if (config.faceTimeLinkAppEnabled) {
    try {
      return await answerFaceTimeCallWithLinkApp(event);
    } catch (error) {
      console.warn(
        `${new Date().toISOString()} facetime link-app answer failed ${event.uuid}, falling back to raw: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
      );
    }
  }
  try {
    const rawResult = await withTimeout(
      blueBubbles.answerFaceTimeCallRaw(event.uuid),
      config.faceTimeAutoAnswerTimeoutMs,
      `Timed out answering FaceTime call ${event.uuid} with raw endpoint`,
    );
    scheduleCallAudioProbe(event, "raw");
    console.log(
      `${new Date().toISOString()} facetime auto-answer ok ${event.uuid} mode=raw ${summarizeFaceTimeAnswer(rawResult)}`,
    );
    return { mode: "raw", result: rawResult };
  } catch (error) {
    if (isFaceTimeRawEndpointUnsupported(error)) {
      console.warn(
        `${new Date().toISOString()} facetime auto-answer raw unsupported ${event.uuid}, falling back to standard: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        const result = await withTimeout(
          blueBubbles.answerFaceTimeCall(event.uuid),
          config.faceTimeAutoAnswerTimeoutMs,
          `Timed out answering FaceTime call ${event.uuid}`,
        );
        scheduleCallAudioProbe(event, "standard");
        console.log(
          `${new Date().toISOString()} facetime auto-answer ok ${event.uuid} mode=standard ${summarizeFaceTimeAnswer(result)}`,
        );
        return { mode: "standard", result };
      } catch (fallbackError) {
        console.warn(
          `${new Date().toISOString()} facetime auto-answer failed ${event.uuid}: ${
            fallbackError instanceof Error
              ? fallbackError.stack || fallbackError.message
              : String(fallbackError)
          }`,
        );
        throw fallbackError;
      }
    }
    console.warn(
      `${new Date().toISOString()} facetime auto-answer failed ${event.uuid}: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }`,
    );
    throw error;
  }
}

async function answerFaceTimeCallWithLinkApp(event) {
  const answerResult = await withTimeout(
    blueBubbles.answerFaceTimeCall(event.uuid),
    config.faceTimeAutoAnswerTimeoutMs,
    `Timed out answering FaceTime call ${event.uuid} with standard endpoint`,
  );
  const link = extractFaceTimeLink(answerResult);
  if (!link) {
    throw new Error(`FaceTime link missing after standard answer for ${event.uuid}`);
  }

  const linkAppResult = launchFaceTimeLinkApp({
    link,
    callUuid: event.uuid,
    config,
  });
  const joinResult = await waitForFaceTimeLinkAppResult(
    linkAppResult,
    config.faceTimeLinkJoinTimeoutMs,
  );

  const admit = await admitFaceTimeLinkParticipant({ event, link });
  const connectResult = await waitForFaceTimeLinkConnected(joinResult, {
    timeoutMs: 15_000,
  });
  scheduleCallAudioProbe(event, "link_app_standard");

  console.log(
    `${new Date().toISOString()} facetime auto-answer ok ${event.uuid} mode=link_app_standard ${summarizeFaceTimeAnswer(answerResult)} link_generated link_app=${summarizeFaceTimeLinkApp(linkAppResult)} join=${summarizeFaceTimeLinkJoin(joinResult)} admit=${summarizeFaceTimeDirectAdmit(admit)} connect=${summarizeFaceTimeLinkConnect(connectResult)}`,
  );
  return {
    mode: "link_app_standard",
    answerResult,
    linkAppResult,
    joinResult,
    admitResult: admit.result,
    admitConversationUuid: admit.conversationUuid,
    admitAttemptCount: admit.attempts,
    admittedCount: admit.admittedCount,
    admitApprovedMembers: admit.approvedMembers,
    admitActiveConversations: admit.activeConversations,
    connectResult,
  };
}

function scheduleCallAudioProbe(event, mode) {
  const scheduled = scheduleFaceTimeAudioProbe(
    { callUuid: event.uuid, mode },
    config,
    { transcriber: audioTranscriber },
  );
  if (scheduled.ok) {
    console.log(
      `${new Date().toISOString()} facetime audio probe scheduled ${event.uuid} mode=${mode} input=${scheduled.input} delayMs=${scheduled.delayMs} durationSeconds=${scheduled.durationSeconds}`,
    );
  }
  return scheduled;
}

async function admitFaceTimeLinkParticipant({ event, link }) {
  const timeoutMs = Math.max(config.faceTimeLinkAdmitTimeoutMs, 20_000);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let activeLink = null;
  let activeLinksError = null;
  let lastAdmitResult = null;
  let lastAdmitError = null;
  let firstPositiveAdmit = null;

  while (Date.now() < deadline) {
    attempts += 1;
    let conversationUuid = "__ANY__";

    try {
      const activeLinksResult = await withTimeout(
        blueBubbles.getFaceTimeActiveLinks(),
        Math.min(5_000, Math.max(1_000, deadline - Date.now())),
        `Timed out reading active FaceTime links for ${event.uuid}`,
      );
      activeLink = findFaceTimeActiveLink(activeLinksResult, link);
      conversationUuid = getFaceTimeActiveLinkConversationUuid(activeLink) || "__ANY__";
    } catch (error) {
      activeLinksError = error;
    }

    try {
      lastAdmitResult = await withTimeout(
        blueBubbles.admitFaceTimeParticipant({
          conversationUuid,
          handleUuid: "__ANY__",
        }),
        Math.min(5_000, Math.max(1_000, deadline - Date.now())),
        `Timed out admitting FaceTime pending participant for ${event.uuid}`,
      );
      const admittedCount = getFaceTimeAdmittedCount(lastAdmitResult);
      if (admittedCount > 0) {
        firstPositiveAdmit ||= {
          result: lastAdmitResult,
          conversationUuid,
          activeLink,
          attempts,
          admittedCount,
          approvedMembers: getFaceTimeApprovedMembers(lastAdmitResult),
          activeConversations: getFaceTimeActiveConversations(lastAdmitResult),
        };
      }

      const conversation = getFaceTimeAdmitConversation(lastAdmitResult, conversationUuid);
      if (firstPositiveAdmit && conversation && Number(conversation.pending_count) === 0) {
        return {
          result: lastAdmitResult,
          conversationUuid,
          activeLink,
          attempts,
          admittedCount: firstPositiveAdmit.admittedCount,
          approvedMembers: firstPositiveAdmit.approvedMembers,
          activeConversations: getFaceTimeActiveConversations(lastAdmitResult),
          settled: true,
        };
      }
    } catch (error) {
      lastAdmitError = error;
    }

    await delay(750);
  }

  const parts = [
    `Timed out admitting FaceTime pending participant for ${event.uuid}`,
    `attempts=${attempts}`,
  ];
  if (activeLink) {
    parts.push(`conversation=${getFaceTimeActiveLinkConversationUuid(activeLink) || "unknown"}`);
  }
  if (activeLinksError) {
    parts.push(`active_links_error=${formatErrorBrief(activeLinksError)}`);
  }
  if (lastAdmitError) {
    parts.push(`last_admit_error=${formatErrorBrief(lastAdmitError)}`);
  } else if (lastAdmitResult) {
    parts.push(`last_admit_count=${getFaceTimeAdmittedCount(lastAdmitResult) ?? "unknown"}`);
    const conversation = getFaceTimeAdmitConversation(
      lastAdmitResult,
      activeLink ? getFaceTimeActiveLinkConversationUuid(activeLink) : "__ANY__",
    );
    if (conversation) {
      parts.push(`pending=${conversation.pending_count ?? "unknown"}`);
      parts.push(`state=${conversation.state ?? "unknown"}`);
    }
  }
  if (firstPositiveAdmit) {
    parts.push(`first_positive_count=${firstPositiveAdmit.admittedCount}`);
  }
  throw new Error(parts.join(" "));
}

function isFaceTimeRawEndpointUnsupported(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.status === 404 || error?.status === 405 || /answer-raw.*failed \((404|405)\)/i.test(message);
}

function enqueueIncomingBundle(incoming) {
  const key = getIncomingBundleKey(incoming);
  if (!key) {
    return processIncomingBundleInOrder([incoming]);
  }
  let bundle = pendingIncomingBundles.get(key);
  if (!bundle) {
    bundle = { items: [], timer: null, promise: null };
    pendingIncomingBundles.set(key, bundle);
  }
  bundle.items.push(incoming);
  if (bundle.timer) clearTimeout(bundle.timer);
  const delayMs = getIncomingBundleDelayMs(bundle.items, {
    defaultDelayMs: incomingBundleDelayMs,
    linkDelayMs: incomingLinkBundleDelayMs,
  });
  bundle.promise = new Promise((resolve) => {
    bundle.timer = setTimeout(async () => {
      pendingIncomingBundles.delete(key);
      const items = bundle.items;
      try {
        resolve(await processIncomingBundleInOrder(items));
      } catch (error) {
        console.error(
          `${new Date().toISOString()} bundled incoming processing failed: ${
            error instanceof Error ? error.stack || error.message : String(error)
          }`,
        );
        resolve({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delayMs);
    bundle.timer.unref?.();
  });
  return {
    status: "queued_for_bundle",
    bundleKey: key,
    count: bundle.items.length,
    delayMs,
  };
}

function shouldProcessIncomingImmediately(incoming) {
  return Boolean(parseSteerCommand(incoming?.text));
}

function processIncomingBundleInOrder(items) {
  return incomingPromptQueue.run(() => processIncomingBundle(items));
}

function takePendingIncomingBundleItems(key) {
  if (!key) return [];
  const bundle = pendingIncomingBundles.get(key);
  if (!bundle) return [];
  pendingIncomingBundles.delete(key);
  if (bundle.timer) clearTimeout(bundle.timer);
  return Array.isArray(bundle.items) ? bundle.items : [];
}

async function processPriorIncomingItemsForOrder(items, requestId) {
  if (!Array.isArray(items) || items.length === 0) return null;
  console.log(
    `${new Date().toISOString()} steer ${requestId} flushing ${items.length} pending incoming item(s) before fallback`,
  );
  try {
    return await processIncomingBundle(items);
  } catch (error) {
    console.error(
      `${new Date().toISOString()} steer ${requestId} pending incoming flush failed before fallback: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }`,
    );
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function processIncomingBundle(items) {
  const incoming = mergeIncomingMessages(items);
  rememberThreadRelayRoute(incoming);
  const downloadedAttachments = await downloadIncomingAttachments(incoming);
  const audioTranscripts = config.audioTranscriptionEnabled
    ? await transcribeAudioAttachments(downloadedAttachments, audioTranscriber)
    : [];
  await markIncomingAudioPlayed(incoming, audioTranscripts);
  const replyContext = buildReplyContext(incoming);
  const rawReasoningCommand = parseCodexRawReasoningCommand(incoming.text);
  if (rawReasoningCommand) {
    const jobId = incomingJobs.start({
      incoming,
      prompt: `[codex-raw-reasoning-command]\n${rawReasoningCommand.prompt}`,
    });
    const stopTypingNow = startTypingController(incoming);
    try {
      await stopTypingNow();
      const result = await codex.setReasoningLevel(rawReasoningCommand.reasoningText);
      const desiredState = codex.setDesiredReadyState({
        reasoningText: result?.readyState?.reasoningText || rawReasoningCommand.reasoningText,
      });
      const text = `Codex reasoning ${rawReasoningCommand.reasoningText}로 바꿨어.`;
      const sent = await sendReply({
        id: `codex-raw-reasoning-${Date.now()}`,
        incoming,
        messages: [{ phase: "final_answer", text }],
        text,
      });
      const response = {
        status: "codex_raw_reasoning_submitted",
        reasoningText: rawReasoningCommand.reasoningText,
        desiredState,
        result,
        sent,
      };
      incomingJobs.mark(jobId, "sent", response);
      return response;
    } catch (error) {
      const response = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      incomingJobs.mark(jobId, "failed", response);
      if (config.autoSend) {
        await sendReply({
          incoming,
          messages: [],
          text: `reasoning 변경 실패: ${response.error}`,
        });
      }
      return response;
    } finally {
      await stopTypingNow();
    }
  }
  const codexControlCommand = parseCodexControlCommand(incoming.text);
  if (codexControlCommand) {
    const jobId = incomingJobs.start({ incoming, prompt: "[codex-control-command]" });
    const stopTypingNow = startTypingController(incoming);
    try {
      await stopTypingNow();
      const desiredState = codex.setDesiredReadyState(codexControlCommand);
      const configUpdate = updateCodexConfigFile(config.codexConfigPath, codexControlCommand);
      const text = formatCodexControlReply(desiredState, configUpdate);
      const sent = await sendReply({
        id: `codex-control-${Date.now()}`,
        incoming,
        messages: [{ phase: "final_answer", text }],
        text,
      });
      const response = {
        status: "codex_control_updated",
        desiredState,
        configUpdate,
        sent,
      };
      incomingJobs.mark(jobId, "sent", response);
      return response;
    } catch (error) {
      incomingJobs.mark(jobId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await stopTypingNow();
    }
  }
  const steerCommand = parseSteerCommand(incoming.text);

  if (steerCommand) {
    const steerPrompt = formatSteerNote(steerCommand.note, { downloadedAttachments });
    const jobId = incomingJobs.start({
      incoming,
      prompt: `[steer-command]\n${steerPrompt}`,
    });
    try {
      const result = await codex.submitSteer(steerPrompt);
      if (result.status === "ignored") {
        const response = {
          status: "ignored",
          reason: result.reason,
          requestId: result.requestId,
          fallback: "regular_message_ordered",
        };
        incomingJobs.mark(jobId, "ignored", response);
        console.log(
          `${new Date().toISOString()} steer ${result.requestId} ignored; queueing regular incoming fallback in order`,
        );
        const fallbackIncoming = buildSteerFallbackIncoming(incoming, steerCommand);
        const replyContextText = replyContext ? formatReplyContext(replyContext) : null;
        const pendingItems = takePendingIncomingBundleItems(getIncomingBundleKey(incoming));
        const fallbackResponse = await incomingPromptQueue.run(async () => {
          await processPriorIncomingItemsForOrder(pendingItems, result.requestId);
          return submitRegularIncoming({
            incoming: fallbackIncoming,
            downloadedAttachments,
            audioTranscripts,
            replyContextText,
          });
        });
        return {
          status: "fallback_sent",
          steer: response,
          fallback: fallbackResponse,
        };
      }
      const response = {
        status: "steered",
        requestId: result.requestId,
      };
      incomingJobs.mark(jobId, "sent", response);
      return response;
    } catch (error) {
      const response = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      incomingJobs.mark(jobId, "failed", response);
      if (config.autoSend) {
        await sendReply({
          incoming,
          messages: [],
          text: `steer 전달 실패: ${response.error}`,
        });
      }
      return response;
    }
  }

  const replyContextText = replyContext ? formatReplyContext(replyContext) : null;
  return submitRegularIncoming({
    incoming,
    downloadedAttachments,
    audioTranscripts,
    replyContextText,
  });
}

async function submitRegularIncoming({
  incoming,
  downloadedAttachments,
  audioTranscripts,
  replyContextText,
}) {
  const currentContext = await buildCurrentContext({ config });
  const currentContextText = formatCurrentContext(currentContext);
  const memoryContextText = await buildMemoryContext({
    incoming,
    audioTranscripts,
    replyContextText,
    config,
  });

  const prompt = buildIncomingPrompt({
    incoming,
    downloadedAttachments,
    audioTranscripts,
    replyContextText,
    memoryContextText,
    currentContextText,
  });

  const jobId = incomingJobs.start({ incoming, prompt });
  const stopTypingNow = startTypingController(incoming);

  if (config.autoSend) {
    const sentMessages = [];
    try {
      const result = await withManagedCodexStream(() =>
        codex.askWithMessages(prompt, {
          onMessage: async (message) => {
            if (shouldStopTypingBeforeSend(message)) {
              await stopTypingNow();
            }
            const reply = {
              id: `${resultIdPrefix(message)}-${sentMessages.length}`,
              incoming,
              messages: [message],
              text: message.text,
            };
            const sent = await sendReply(reply);
            sentMessages.push({ message, sent });
            console.log(
              `${new Date().toISOString()} auto-sent ${message.phase || "assistant"} ${message.id || ""}`,
            );
          },
        }),
      );
      armThreadRelayFromSessionFile({
        incoming,
        sessionFile: result.reply?.file,
        reason: "managed-ask-complete",
      });
      const response = {
        status: "sent",
        requestId: result.requestId,
        sentCount: sentMessages.length,
        sessionFile: result.reply.file,
      };
      incomingJobs.mark(jobId, "sent", response);
      return response;
    } catch (error) {
      incomingJobs.mark(jobId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await stopTypingNow();
    }
  }

  try {
    const result = await codex.ask(prompt);
    armThreadRelayFromSessionFile({
      incoming,
      sessionFile: result.reply?.file,
      reason: "managed-ask-queued",
    });
    const pendingReply = addPendingReply({
      id: result.requestId,
      createdAt: new Date().toISOString(),
      incoming,
      messages: result.reply.messages,
      text: result.reply.messages.at(-1)?.text || "",
      sessionFile: result.reply.file,
    });
    incomingJobs.mark(jobId, "queued", {
      requestId: result.requestId,
      sessionFile: result.reply.file,
    });
    return { status: "queued", pendingReply };
  } catch (error) {
    incomingJobs.mark(jobId, "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await stopTypingNow();
  }
}

function formatCodexControlReply(desiredState, configUpdate) {
  const parts = [];
  if (desiredState?.modelText) parts.push(`model ${desiredState.modelText}`);
  if (desiredState?.reasoningText) parts.push(`reasoning ${desiredState.reasoningText}`);
  const target = parts.join(", ") || "no target";
  const configChanged = configUpdate?.changed
    ? "config.toml도 업데이트했어"
    : "config.toml은 이미 같은 값이었어";
  return `Codex 목표값 저장했어: ${target}. ${configChanged}. 재시작 이후에는 이 값이 UI에 보일 때까지 확인하고 들어가게 돼.`;
}

function getIncomingBundleKey(incoming) {
  const chatOrHandle = incoming.chatGuid || incoming.handle;
  if (!chatOrHandle) return null;
  return `${chatOrHandle}|${incoming.handle || ""}`;
}

function mergeIncomingMessages(items) {
  if (!Array.isArray(items) || items.length <= 1) return items[0];
  const base = items[items.length - 1];
  const text = items
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n\n");
  const attachments = items.flatMap((item) => item.attachments || []);
  return {
    ...base,
    guid: base.guid || items.find((item) => item.guid)?.guid || null,
    text,
    attachments,
    raw: {
      type: "bundled-message",
      data: {
        ...((base.raw?.data ?? base.raw?.message ?? base.raw) || {}),
        text,
        attachments,
      },
      bundled: items.map((item) => item.raw),
    },
    bundledMessages: items.map((item) => ({
      guid: item.guid || null,
      text: item.text || "",
      attachments: item.attachments || [],
    })),
  };
}

async function downloadIncomingAttachments(incoming) {
  const out = [];
  for (const attachment of incoming.attachments) {
    const guid = attachment?.guid || attachment?.originalGuid;
    if (!guid) continue;
    const safeName = sanitizeFileName(
      attachment.transferName || `${guid}.bin`,
    );
    const outputPath = path.join(attachmentRoot, guid, safeName);
    try {
      const result = await blueBubbles.downloadAttachment({
        guid,
        outputPath,
        force: false,
      });
      out.push({
        guid,
        outputPath,
        transferName: attachment.transferName || null,
        mimeType: attachment.mimeType || null,
        bytes: result.bytes,
      });
      console.log(`${new Date().toISOString()} attachment downloaded ${guid} ${outputPath}`);
    } catch (error) {
      console.warn(
        `${new Date().toISOString()} attachment download failed ${guid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      out.push({
        guid,
        outputPath,
        transferName: attachment.transferName || null,
        mimeType: attachment.mimeType || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

function sanitizeFileName(name) {
  return String(name).replace(/[/:\\]/g, "_").slice(0, 180) || "attachment.bin";
}

function buildReplyContext(incoming) {
  const targetGuid = incoming.replyContext?.targetGuid;
  if (!targetGuid) return null;
  return {
    targetGuid,
    currentMessageGuid: incoming.guid || null,
    fields: incoming.replyContext,
    targetMessage: recentMessages.get(targetGuid) || null,
  };
}

function formatReplyContext(context) {
  const lines = [
    `- currentMessageGuid: ${context.currentMessageGuid || "unknown"}`,
    `- targetGuid: ${context.targetGuid}`,
  ];
  if (context.fields?.threadOriginatorGuid) {
    lines.push(`- threadOriginatorGuid: ${context.fields.threadOriginatorGuid}`);
  }
  if (context.fields?.associatedMessageGuid) {
    lines.push(`- associatedMessageGuid: ${context.fields.associatedMessageGuid}`);
  }
  if (context.targetMessage) {
    lines.push(
      `- target sender: ${context.targetMessage.isFromMe ? "aria/self" : context.targetMessage.handle || "unknown"}`,
    );
    lines.push(`- target text: ${context.targetMessage.text || "[no text]"}`);
    if (context.targetMessage.attachments?.length) {
      lines.push(
        `- target attachments: ${context.targetMessage.attachments
          .map((item) => item.transferName || item.guid || item.mimeType || "attachment")
          .join(", ")}`,
      );
    }
  } else {
    lines.push("- target message: not found in bridge recent-message index");
  }
  return lines.join("\n");
}

function getOutgoingThreadTarget(incoming) {
  if (!config.blueBubblesThreadedReplies) return null;
  if (!incoming.replyContext?.targetGuid) return null;
  return incoming.guid || incoming.replyContext.targetGuid;
}

function recordMessage(incoming, { source } = {}) {
  const data = incoming?.raw?.data ?? incoming?.raw?.message ?? incoming?.raw ?? {};
  const guid = incoming?.guid || data?.guid;
  if (!guid) return;
  const hasContent =
    Boolean(incoming?.text) ||
    (Array.isArray(incoming?.attachments) && incoming.attachments.length > 0);
  if (!hasContent) return;
  const record = {
    guid,
    chatGuid: incoming.chatGuid || null,
    handle: incoming.handle || null,
    text: incoming.text || "",
    isFromMe: Boolean(incoming.isFromMe),
    attachments: Array.isArray(incoming.attachments)
      ? incoming.attachments.map((item) => ({
          guid: item?.guid || item?.originalGuid || null,
          transferName: item?.transferName || null,
          mimeType: item?.mimeType || null,
          totalBytes: Number.isFinite(Number(item?.totalBytes))
            ? Number(item.totalBytes)
            : null,
        }))
      : [],
    hasPayloadData: Boolean(data?.hasPayloadData || data?.payloadData),
    hasDdResults: Boolean(data?.hasDdResults),
    balloonBundleId: data?.balloonBundleId || null,
    isDelivered:
      typeof data?.isDelivered === "boolean" ? data.isDelivered : null,
    replyTargetGuid: incoming.replyContext?.targetGuid || null,
    source: source || "unknown",
    seenAt: new Date().toISOString(),
  };
  const merged = mergeMessageRecord(recentMessages.get(guid), record);
  recentMessages.set(guid, merged);
  appendMessageRecord(merged);
}

function recordBlueBubblesResult(result, fallback = {}) {
  const data = result?.data ?? result;
  if (!data?.guid) return;
  const incomingLike = extractIncomingMessage({
    type: "sent-message",
    data: {
      ...data,
      text: data.text || fallback.text || "",
      chatGuid: data.chatGuid || fallback.chatGuid,
      handle: data.handle || { address: fallback.address || "" },
      isFromMe: true,
      attachments: Array.isArray(data.attachments) ? data.attachments : [],
    },
  });
  recordMessage(incomingLike, { source: "send-result" });
}

function appendMessageRecord(record) {
  try {
    fs.mkdirSync(path.dirname(messageIndexPath), { recursive: true });
    fs.appendFileSync(messageIndexPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.warn(
      `${new Date().toISOString()} message index append failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function loadRecentMessages() {
  const map = new Map();
  try {
    if (!fs.existsSync(messageIndexPath)) return map;
    const lines = fs.readFileSync(messageIndexPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-2000)) {
      try {
        const record = JSON.parse(line);
        if (record?.guid) {
          map.set(record.guid, mergeMessageRecord(map.get(record.guid), record));
        }
      } catch {
        // Ignore malformed historical lines.
      }
    }
  } catch (error) {
    console.warn(
      `${new Date().toISOString()} message index load failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return map;
}

function mergeMessageRecord(previous, next) {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    chatGuid: next.chatGuid || previous.chatGuid || null,
    handle: next.handle || previous.handle || null,
    text: next.text || previous.text || "",
    attachments:
      Array.isArray(next.attachments) && next.attachments.length > 0
        ? next.attachments
        : previous.attachments || [],
    hasPayloadData: Boolean(next.hasPayloadData || previous.hasPayloadData),
    hasDdResults: Boolean(next.hasDdResults || previous.hasDdResults),
    balloonBundleId: next.balloonBundleId || previous.balloonBundleId || null,
    isDelivered:
      typeof next.isDelivered === "boolean" ? next.isDelivered : previous.isDelivered ?? null,
    replyTargetGuid: next.replyTargetGuid || previous.replyTargetGuid || null,
    isFromMe:
      typeof next.isFromMe === "boolean" ? next.isFromMe : Boolean(previous.isFromMe),
  };
}

function getIncomingDedupeKey(incoming) {
  const guid =
    incoming.guid ||
    incoming.raw?.data?.guid ||
    incoming.raw?.message?.guid ||
    incoming.raw?.guid ||
    null;
  if (guid) return `guid:${guid}`;
  const attachmentKeys = incoming.attachments
    .map((attachment) => attachment?.guid || attachment?.originalGuid || attachment?.transferName)
    .filter(Boolean)
    .join(",");
  const fallback = [
    incoming.chatGuid || "",
    incoming.handle || "",
    incoming.text || "",
    attachmentKeys,
  ].join("|");
  return fallback.trim() ? `fallback:${fallback}` : null;
}

function hasSeenIncoming(key) {
  pruneSeenIncoming();
  return seenIncoming.has(key);
}

function rememberIncoming(key) {
  pruneSeenIncoming();
  seenIncoming.set(key, Date.now());
}

function pruneSeenIncoming() {
  const cutoff = Date.now() - incomingDedupeTtlMs;
  for (const [key, seenAt] of seenIncoming.entries()) {
    if (seenAt < cutoff) seenIncoming.delete(key);
  }
}

function resultIdPrefix(message) {
  return `stream-${message.id || Date.now()}`;
}

function shouldStopTypingBeforeSend(message) {
  return Boolean(message?.text) && message.phase === "final_answer";
}

async function bestEffortBlueBubbles(label, incoming, fn) {
  try {
    const result = await fn();
    if (result) {
      console.log(`${new Date().toISOString()} bluebubbles ${label} ok ${incoming.chatGuid || ""}`);
    }
  } catch (error) {
    console.warn(
      `${new Date().toISOString()} bluebubbles ${label} skipped/failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function markIncomingRead(incoming) {
  await bestEffortBlueBubbles("mark-read", incoming, () =>
    incoming.chatGuid ? blueBubbles.markRead(incoming.chatGuid) : null,
  );
}

async function markIncomingAudioPlayed(incoming, audioTranscripts) {
  const usableAudio = audioTranscripts.filter(
    (item) => item?.status === "ok" || item?.status === "cached",
  );
  if (usableAudio.length === 0) return;

  const messageGuids = getAudioMessageGuids(incoming, usableAudio);
  if (messageGuids.length === 0) {
    console.warn(`${new Date().toISOString()} bluebubbles mark-played skipped: missing message guid`);
    return;
  }

  for (const messageGuid of messageGuids) {
    await bestEffortBlueBubbles(`mark-played ${messageGuid}`, incoming, () =>
      incoming.chatGuid ? blueBubbles.markPlayed(incoming.chatGuid, messageGuid) : null,
    );
  }
}

function getAudioMessageGuids(incoming, audioTranscripts) {
  const audioAttachmentGuids = new Set(
    audioTranscripts
      .map((item) => item?.attachment?.guid)
      .filter(Boolean),
  );
  const out = new Set();

  for (const item of incoming.bundledMessages || []) {
    if (!item.guid) continue;
    const hasMatchingAudio = (item.attachments || []).some((attachment) =>
      audioAttachmentGuids.has(attachment?.guid || attachment?.originalGuid),
    );
    if (hasMatchingAudio) out.add(item.guid);
  }

  if (out.size === 0 && incoming.guid) out.add(incoming.guid);
  return [...out];
}

async function stopTypingRepeated(incoming, { immediateOnly = false } = {}) {
  if (!incoming.chatGuid) return;
  const delays = immediateOnly ? [0] : [0, 2000, 6000];
  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await bestEffortBlueBubbles(`typing-stop-${delayMs}`, incoming, () =>
      blueBubbles.stopTyping(incoming.chatGuid),
    );
  }
}

function startTypingController(incoming) {
  const chatGuid = incoming.chatGuid;
  if (!chatGuid) return async () => {};
  if (!config.typingIndicatorsEnabled) {
    return async () => {};
  }

  const previous = activeTypingControllers.get(chatGuid);
  if (previous) {
    previous.stop({ reason: "superseded" }).catch(() => {});
  }

  let stopped = false;
  let keepAliveTimer = null;
  let followUpTimers = [];
  const controller = {
    stop: async ({ reason = "done", followUp = false } = {}) => {
      if (stopped) return;
      stopped = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      for (const timer of followUpTimers) clearTimeout(timer);
      followUpTimers = [];
      if (activeTypingControllers.get(chatGuid) === controller) {
        activeTypingControllers.delete(chatGuid);
      }
      await stopTypingRepeated(incoming, { immediateOnly: true });
      if (followUp) scheduleTypingStopFollowUps(incoming, reason);
    },
  };

  activeTypingControllers.set(chatGuid, controller);

  bestEffortBlueBubbles("typing-start", incoming, () =>
    blueBubbles.startTyping(chatGuid),
  ).catch(() => {});

  keepAliveTimer = setInterval(() => {
    if (stopped || activeTypingControllers.get(chatGuid) !== controller) return;
    bestEffortBlueBubbles("typing-keepalive", incoming, () =>
      blueBubbles.startTyping(chatGuid),
    ).catch(() => {});
  }, 12000);
  keepAliveTimer.unref?.();

  return async () => {
    await controller.stop({ reason: "final", followUp: true });
  };
}

function scheduleTypingStopFollowUps(incoming, reason) {
  for (const delayMs of [1500, 4000, 9000, 15000]) {
    const timer = setTimeout(() => {
      bestEffortBlueBubbles(`typing-stop-followup-${reason}-${delayMs}`, incoming, () =>
        incoming.chatGuid ? blueBubbles.stopTyping(incoming.chatGuid) : null,
      ).catch(() => {});
    }, delayMs);
    timer.unref?.();
  }
}

async function sendPending(id, body) {
  if (!body?.confirm) {
    throw new Error("Sending requires JSON body { confirm: true }");
  }
  const reply = getPendingReply(id);
  if (!reply) throw new Error(`No pending reply ${id}`);
  const result = await sendReply(reply);
  removePendingReply(id);
  return { status: "sent", result };
}

async function sendLatestPending(body) {
  if (!body?.confirm) {
    throw new Error("Sending requires JSON body { confirm: true }");
  }
  const reply = getLatestPendingReply();
  if (!reply) throw new Error("No pending replies");
  const result = await sendReply(reply);
  removePendingReply(reply.id);
  return { status: "sent", id: reply.id, text: reply.text, result };
}

async function sendReply(reply) {
  const messages =
    Array.isArray(reply.messages) && reply.messages.length > 0
      ? reply.messages
      : [{ text: reply.text }];
  const results = [];
  const chatGuid =
    reply.incoming.chatGuid ||
    reply.incoming.raw?.data?.chats?.[0]?.guid ||
    reply.incoming.raw?.message?.chats?.[0]?.guid;
  for (const message of messages) {
    const text = typeof message === "string" ? message : message.text;
    const selectedMessageGuid = getOutgoingThreadTarget(reply.incoming);
    if (text) {
      const rendered = renderMarkdownRichText(text);
      results.push(
        ...(await sendTextPartsWithLinkPreviews({
          chatGuid,
          address: reply.incoming.handle,
          text: rendered.text,
          attributedBody: rendered.attributedBody,
          selectedMessageGuid,
          partIndex: reply.incoming.partIndex || 0,
        })),
      );
    }
    const attachments = Array.isArray(message?.attachments)
      ? message.attachments
      : [];
    for (const attachment of attachments) {
      const result = await sendDedupedAttachment({
        chatGuid: required(chatGuid, "chatGuid"),
        filePath: required(attachment.filePath, "attachment.filePath"),
        name: attachment.name || null,
        isAudioMessage: attachment.type === "audio",
        method: selectedMessageGuid ? "private-api" : "apple-script",
        selectedMessageGuid,
        partIndex: reply.incoming.partIndex || 0,
      });
      recordBlueBubblesResult(result, {
        chatGuid,
        address: reply.incoming.handle,
      });
      results.push(result);
    }
  }
  return results;
}

async function sendTextPartsWithLinkPreviews({
  chatGuid,
  address,
  text,
  attributedBody = null,
  selectedMessageGuid = null,
  partIndex = 0,
}) {
  const results = [];
  const textParts = splitTextForLinkPreviewMessages(text);
  if (shouldScheduleLinkPreviewParts(textParts)) {
    scheduleLinkPreviewTextParts({
      chatGuid,
      address,
      textParts,
      attributedBody,
      selectedMessageGuid,
      partIndex,
    });
    return textParts.map((part, index) => ({
      status: "link_preview_part_send_scheduled",
      chatGuid,
      address,
      text: part.text,
      partNumber: index + 1,
      partCount: textParts.length,
    }));
  }
  for (const [index, part] of textParts.entries()) {
    const result = await sendDedupedTextWithReplyFallback({
      chatGuid,
      address,
      text: part.text,
      attributedBody: textParts.length === 1 ? attributedBody : null,
      selectedMessageGuid,
      partIndex,
    });
    if (result?.status !== "skipped_duplicate_outgoing") {
      recordBlueBubblesResult(result, {
        chatGuid,
        address,
        text: part.text,
      });
    }
    results.push(result);
    const nextPart = textParts[index + 1];
    if (nextPart && (part.urlOnly || nextPart.urlOnly)) {
      await delay(outgoingLinkPreviewPartDelayMs);
    }
  }
  return results;
}

function shouldScheduleLinkPreviewParts(textParts) {
  return textParts.length > 1 && textParts.some((part) => part.urlOnly);
}

function scheduleLinkPreviewTextParts({
  chatGuid,
  address,
  textParts,
  attributedBody,
  selectedMessageGuid,
  partIndex,
}) {
  (async () => {
    for (const [index, part] of textParts.entries()) {
      console.log(
        `${new Date().toISOString()} link preview part send scheduled start ${index + 1}/${
          textParts.length
        } text=${part.text}`,
      );
      let richLinkDecision = null;
      if (chatGuid && !selectedMessageGuid && part.urlOnly) {
        const outboundText = prepareLinkPreviewText(part.text);
        richLinkDecision = await buildPreflightRichLinkDecisionWithTimeout(outboundText).catch(
          (error) => {
            console.warn(
              `${new Date().toISOString()} link preview preflight failed ${index + 1}/${
                textParts.length
              }: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { route: "none", reason: "preflight_error_plain", payload: null };
          },
        );
      }
      const result = await sendDedupedTextWithReplyFallback({
        chatGuid,
        address,
        text: part.text,
        attributedBody: textParts.length === 1 ? attributedBody : null,
        selectedMessageGuid,
        partIndex,
        richLinkDecision,
        awaitNativeSendForOrder: true,
      });
      if (result?.status !== "skipped_duplicate_outgoing") {
        recordBlueBubblesResult(result, {
          chatGuid,
          address,
          text: part.text,
        });
      }
      console.log(
        `${new Date().toISOString()} link preview part send completed ${index + 1}/${
          textParts.length
        } status=${result?.status || "ok"}`,
      );
      const nextPart = textParts[index + 1];
      if (nextPart && (part.urlOnly || nextPart.urlOnly)) {
        await delay(outgoingLinkPreviewPartDelayMs);
      }
    }
  })().catch((error) => {
    console.warn(
      `${new Date().toISOString()} link preview scheduled sequence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

async function sendDedupedAttachment({
  chatGuid,
  filePath,
  name = null,
  isAudioMessage = false,
  method = "apple-script",
  selectedMessageGuid = null,
  partIndex = 0,
}) {
  const dedupeClaim = outgoingAttachmentDedupe.claim({
    chatGuid,
    text: [
      "attachment",
      filePath,
      name || "",
      selectedMessageGuid || "",
      partIndex || 0,
    ].join("\u0000"),
  });
  if (!dedupeClaim.ok) {
    console.warn(
      `${new Date().toISOString()} skipped duplicate outgoing attachment ${
        chatGuid || ""
      } ${name || filePath}`,
    );
    return { status: "skipped_duplicate_outgoing_attachment" };
  }
  try {
    return await blueBubbles.sendAttachment({
      chatGuid,
      filePath,
      name,
      isAudioMessage,
      method,
      selectedMessageGuid,
      partIndex,
    });
  } catch (error) {
    outgoingAttachmentDedupe.release(dedupeClaim.key);
    throw error;
  }
}

async function sendDedupedTextWithReplyFallback({
  chatGuid,
  address,
  text,
  attributedBody = null,
  selectedMessageGuid,
  partIndex = 0,
  richLinkDecision = null,
  awaitNativeSendForOrder = false,
}) {
  if (!attributedBody) {
    const rendered = renderMarkdownRichText(text);
    text = rendered.text;
    attributedBody = rendered.attributedBody;
  }
  if (
    isHighRiskDuplicateText(text) &&
    isRecentOutgoingTextDuplicate({
      records: recentMessages.values(),
      chatGuid,
      address,
      text,
      ttlMs: getOutgoingTextDedupeTtlMs(text),
    })
  ) {
    console.warn(
      `${new Date().toISOString()} skipped duplicate outgoing text from recent delivery ${
        chatGuid || address || ""
      }`,
    );
    return { status: "skipped_duplicate_outgoing" };
  }
  const dedupeClaim = outgoingDedupe.claim({ chatGuid, address, text });
  if (!dedupeClaim.ok) {
    console.warn(
      `${new Date().toISOString()} skipped duplicate outgoing text ${chatGuid || address || ""}`,
    );
    return { status: "skipped_duplicate_outgoing" };
  }
  try {
    return await sendTextWithReplyFallback({
      chatGuid,
      address,
      text,
      attributedBody,
      selectedMessageGuid,
      partIndex,
      richLinkDecision,
      awaitNativeSendForOrder,
    });
  } catch (error) {
    if (!isHighRiskDuplicateText(text)) {
      outgoingDedupe.release(dedupeClaim.key);
    }
    throw error;
  }
}

function getOutgoingTextDedupeTtlMs(text) {
  if (isHighRiskDuplicateText(text)) {
    return Math.max(config.outgoingDedupeTtlMs, highRiskOutgoingDedupeTtlMs);
  }
  return config.outgoingDedupeTtlMs;
}

function isHighRiskDuplicateText(text) {
  const normalized = String(text || "").trim();
  return normalized.startsWith("Hourly Market Now") || normalized.length >= 1000;
}

async function sendTextWithReplyFallback({
  chatGuid,
  address,
  text,
  attributedBody = null,
  selectedMessageGuid,
  partIndex = 0,
  richLinkDecision: precomputedRichLinkDecision = null,
  awaitNativeSendForOrder = false,
}) {
  const richText = Boolean(attributedBody && chatGuid);
  const route = chooseTextSendRoute({ chatGuid, text, richText, selectedMessageGuid });
  if (!selectedMessageGuid && !richText && !route.ddScan && !route.generatedLinkPreview) {
    return blueBubbles.sendText({ chatGuid, address, text, method: "apple-script" });
  }
  const linkPreviewAttempt = route.ddScan || route.generatedLinkPreview;
  const outboundText = linkPreviewAttempt ? prepareLinkPreviewText(text) : text;
  try {
    if (linkPreviewAttempt) {
      const richLinkDecision = route.generatedLinkPreview
        ? precomputedRichLinkDecision || (await buildPreflightRichLinkDecisionWithTimeout(outboundText))
        : { route: "native", reason: "explicit_native_ddscan", payload: null };
      console.log(
        `${new Date().toISOString()} link preview route ${richLinkDecision.route} reason=${
          richLinkDecision.reason || ""
        } text=${outboundText}`,
      );
      if (richLinkDecision.route === "generated" && richLinkDecision.payload) {
        return sendGeneratedRichLink({
          chatGuid,
          address,
          text: outboundText,
          payload: richLinkDecision.payload,
          selectedMessageGuid,
          partIndex,
        });
      }
      if (route.ddScan || richLinkDecision.route === "native") {
        return await sendQueuedLinkPreview({
          chatGuid,
          address,
          text: outboundText,
          method: route.method,
          attributedBody: richText ? attributedBody : null,
          selectedMessageGuid,
          partIndex,
          awaitSend: awaitNativeSendForOrder,
        });
      }
      return await blueBubbles.sendText({
        chatGuid,
        address,
        text: outboundText,
        method: route.method,
        attributedBody: richText ? attributedBody : null,
        selectedMessageGuid,
        partIndex,
        ddScan: false,
      });
    }
    return await blueBubbles.sendText({
      chatGuid,
      address,
      text: outboundText,
      method: route.method,
      attributedBody: richText ? attributedBody : null,
      selectedMessageGuid,
      partIndex,
      ddScan: route.ddScan,
    });
  } catch (error) {
    if (isAmbiguousBlueBubblesSendError(error) || linkPreviewAttempt) {
      const delivered = await waitForRecentOutgoingTextDelivery({
        chatGuid,
        address,
        text: outboundText,
        timeoutMs: ambiguousSendReconcileTimeoutMs,
        pollMs: ambiguousSendReconcilePollMs,
      });
      if (delivered) {
        console.warn(
          `${new Date().toISOString()} ambiguous BlueBubbles send timeout reconciled with delivered message ${
            delivered.guid || ""
          }`,
        );
        return blueBubblesSendResultFromRecentRecord(delivered, { chatGuid, address });
      }
    }
    if (linkPreviewAttempt && isRecoverableNativeLinkPreviewSendError(error)) {
      const fallbackRichLinkPayload = await buildGeneratedRichLinkPayload(outboundText);
      if (fallbackRichLinkPayload) {
        console.warn(
          `${new Date().toISOString()} native link preview send failed, falling back to generated rich link: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return sendGeneratedRichLink({
          chatGuid,
          address,
          text: outboundText,
          selectedMessageGuid,
          partIndex,
          payload: fallbackRichLinkPayload,
        });
      }
    }
    console.warn(
      `${new Date().toISOString()} rich/threaded text reply failed, falling back to plain text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return blueBubbles.sendText({ chatGuid, address, text, method: "apple-script" });
  }
}

async function buildPreflightRichLinkDecisionWithTimeout(text) {
  if (nativeLinkPreviewPreflightTimeoutMs <= 0) {
    return { route: "none", reason: "preflight_disabled", payload: null };
  }
  let timer = null;
  try {
    const decision = await Promise.race([
      buildNativeRichLinkPreflightDecision(text, {
        timeoutMs: nativeLinkPreviewPreflightTimeoutMs,
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, nativeLinkPreviewPreflightTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (decision?.route === "native") return decision;
    if (decision?.route === "none") return decision;
    if (decision?.route === "generated" && decision.payload) return decision;
    const generatedDefault = decision?.reason === "generated_default";
    const generatedPayload = await buildGeneratedRichLinkPayload(text, {
      assetMode: generatedDefault ? "image-preferred" : "icon-only",
      skipLinkPresentation: !generatedDefault,
    }).catch(() => null);
    if (generatedPayload?.previewKind === "apple_maps_directions") {
      return {
        route: "generated",
        reason: "apple_maps_directions_payload",
        payload: generatedPayload,
      };
    }
    const fallbackPayload =
      generatedPayload || buildUrlOnlyRichLinkPayload(text);
    const baseReason = decision?.reason || "preflight_timeout";
    return {
      route: "generated",
      reason: `${baseReason}_${
        fallbackPayload?.attachmentRole === "image"
          ? "image_fallback"
          : fallbackPayload?.attachmentFilePath
            ? "favicon_fallback"
            : "url_fallback"
      }`,
      payload: fallbackPayload,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendQueuedLinkPreview({
  chatGuid,
  address,
  text,
  method,
  attributedBody = null,
  selectedMessageGuid = null,
  partIndex = 0,
  awaitSend = false,
}) {
  return nativeLinkPreviewQueue.run(async () => {
    const send = async () => {
      console.log(`${new Date().toISOString()} native link preview send started ${text}`);
      const result = await blueBubbles.sendText({
        chatGuid,
        address,
        text,
        method,
        attributedBody,
        selectedMessageGuid,
        partIndex,
        ddScan: true,
        timeoutMs: nativeLinkPreviewSendTimeoutMs,
      });
      recordBlueBubblesResult(result, { chatGuid, address, text });
      const guid = blueBubblesResultGuid(result);
      console.log(
        `${new Date().toISOString()} native link preview send completed ${guid || ""}`,
      );
      return result;
    };
    if (awaitSend) {
      return send();
    }
    const timer = setTimeout(() => {
      send().catch((error) => {
        console.warn(
          `${new Date().toISOString()} native link preview send failed async: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, 0);
    timer.unref?.();
    if (nativeLinkPreviewQueueSettleMs > 0) {
      await sleep(nativeLinkPreviewQueueSettleMs);
    }
    return {
      status: "native_link_preview_send_started",
      chatGuid,
      address,
      text,
      ddScan: true,
    };
  });
}

function blueBubblesResultGuid(result) {
  return result?.data?.guid || result?.guid || "";
}

function sendGeneratedRichLink({
  chatGuid,
  address,
  text,
  payload,
  selectedMessageGuid = null,
  partIndex = 0,
}) {
  if (payload?.attachmentFilePath && chatGuid && !selectedMessageGuid && !partIndex) {
    return blueBubbles.sendRichLink({
      chatGuid,
      text,
      payloadData: payload.payloadData,
      balloonBundleId: payload.balloonBundleId,
      attachmentFilePath: payload.attachmentFilePath,
      attachmentName: payload.attachmentName,
    });
  }
  return blueBubbles.sendText({
    chatGuid,
    address,
    text,
    method: "private-api",
    selectedMessageGuid,
    partIndex,
    ddScan: false,
    payloadData: payload?.payloadData,
    balloonBundleId: payload?.balloonBundleId,
  });
}

function isAmbiguousBlueBubblesSendError(error) {
  const message = error instanceof Error ? error.message : String(error);
  let data = "";
  try {
    data = JSON.stringify(error?.data ?? error?.body ?? "");
  } catch {
    data = "";
  }
  return /Transaction timeout|Message send timeout/i.test(`${message} ${data}`);
}

function isRecoverableNativeLinkPreviewSendError(error) {
  const message = error instanceof Error ? error.message : String(error);
  let data = "";
  try {
    data = JSON.stringify(error?.data ?? error?.body ?? "");
  } catch {
    data = "";
  }
  return (
    isTimeoutLike(error) ||
    isAmbiguousBlueBubblesSendError(error) ||
    /BlueBubbles send timed out|fetch failed|Failed to send message|Message Send Error/i.test(
      `${message} ${data}`,
    )
  );
}

async function waitForRecentOutgoingTextDelivery({
  chatGuid,
  address,
  text,
  timeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const intervalMs = Math.max(100, Number(pollMs) || 500);
  do {
    const delivered = findRecentOutgoingTextDuplicate({
      records: recentMessages.values(),
      chatGuid,
      address,
      text,
      ttlMs: getOutgoingTextDedupeTtlMs(text),
    });
    if (delivered) return delivered;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  } while (Date.now() <= deadline);
  return null;
}

function blueBubblesSendResultFromRecentRecord(record, { chatGuid, address } = {}) {
  return {
    status: "sent_after_ambiguous_timeout",
    data: {
      guid: record?.guid || "",
      chatGuid: record?.chatGuid || chatGuid || "",
      handle: { address: record?.handle || address || "" },
      text: record?.text || "",
      isFromMe: true,
      attachments: record?.attachments || [],
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutLike(error) {
  return (
    error?.status === 504 ||
    /timed?-?out|timeout|Gateway Timeout/i.test(
      error instanceof Error ? error.message : String(error),
    )
  );
}

function isAllowed(incoming) {
  if (
    config.allowedChatGuids.size > 0 &&
    (!incoming.chatGuid || !config.allowedChatGuids.has(incoming.chatGuid))
  ) {
    return false;
  }
  if (
    config.allowedHandles.size > 0 &&
    (!incoming.handle || !config.allowedHandles.has(incoming.handle))
  ) {
    return false;
  }
  return true;
}

function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactCaller(address) {
  const text = String(address || "");
  if (!text) return "unknown";
  if (text.includes("@")) {
    const [name, domain] = text.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  const compact = text.replace(/\D/g, "");
  if (compact.length <= 4) return "***";
  return `+***${compact.slice(-4)}`;
}

async function waitForFaceTimeLinkAppResult(linkAppResult, timeoutMs) {
  if (!linkAppResult?.ok || !linkAppResult.resultPath) {
    return { ok: false, skipped: true, reason: "link_app_not_started" };
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(linkAppResult.resultPath)) {
      try {
        return JSON.parse(fs.readFileSync(linkAppResult.resultPath, "utf8"));
      } catch (error) {
        return {
          ok: false,
          reason: "invalid_json",
          error: error instanceof Error ? error.message : String(error),
          resultPath: linkAppResult.resultPath,
        };
      }
    }
    await delay(500);
  }
  return { ok: false, reason: "timeout", resultPath: linkAppResult.resultPath };
}

async function waitForFaceTimeLinkConnected(joinResult, { timeoutMs = 15_000 } = {}) {
  const debugUrl = joinResult?.remoteDebuggingUrl;
  if (!debugUrl) {
    return { ok: false, skipped: true, reason: "missing_debug_url" };
  }
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastState = await getFaceTimeLinkPageState(debugUrl);
      if (lastState.connected) {
        return { ok: true, state: lastState };
      }
      if (lastState.unavailable) {
        return { ok: false, reason: "unavailable", state: lastState };
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  return {
    ok: false,
    reason: lastState?.waiting ? "still_waiting" : "timeout",
    state: lastState,
    error: lastError ? formatErrorBrief(lastError) : null,
  };
}

async function getFaceTimeLinkPageState(debugUrl) {
  const pages = await fetchJsonWithTimeout(debugUrl, 2_000);
  const page = Array.isArray(pages)
    ? pages.find((item) => String(item.url || "").includes("facetime.apple.com"))
    : null;
  if (!page?.webSocketDebuggerUrl) {
    return { connected: false, waiting: false, unavailable: false, reason: "no_facetime_page" };
  }
  const value = await evaluateChromePage(page.webSocketDebuggerUrl, `(() => {
    const text = document.body?.innerText || "";
    const waiting = /Waiting to be let in/i.test(text);
    const unavailable = /call is not available|not available/i.test(text);
    const connected = !waiting && !unavailable && /FaceTime Call/i.test(text) && /Leave/i.test(text);
    return {
      connected,
      waiting,
      unavailable,
      title: document.title,
      url: location.href,
      text: text.slice(0, 1200),
    };
  })()`);
  return value || { connected: false, waiting: false, unavailable: false, reason: "empty_state" };
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function evaluateChromePage(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const open = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  async function send(method, params = {}) {
    await open;
    return await new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id !== id) return;
        socket.removeEventListener("message", onMessage);
        if (data.error) {
          reject(new Error(`${method} failed: ${JSON.stringify(data.error)}`));
        } else {
          resolve(data.result);
        }
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  try {
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    return result.result?.value;
  } finally {
    socket.close();
  }
}

function findFaceTimeActiveLink(result, link) {
  const links = result?.data?.links || result?.data?.data?.links || result?.links || [];
  if (!Array.isArray(links)) return null;
  return links.find((item) => item?.url === link) || null;
}

function getFaceTimeActiveLinkConversationUuid(activeLink) {
  if (!activeLink) return null;
  return (
    activeLink.group_uuid ||
    activeLink.groupUUID ||
    activeLink.groupUuid ||
    activeLink.conversation_uuid ||
    activeLink.conversationUUID ||
    null
  );
}

function getFaceTimeAdmittedCount(result) {
  return findNumericProperty(result, "admittedCount");
}

function getFaceTimeAdmitPayload(result) {
  if (result?.data?.data && typeof result.data.data === "object") {
    return result.data.data;
  }
  if (result?.data && typeof result.data === "object") {
    return result.data;
  }
  return result && typeof result === "object" ? result : {};
}

function getFaceTimeApprovedMembers(result) {
  const payload = getFaceTimeAdmitPayload(result);
  return Array.isArray(payload.approvedMembers) ? payload.approvedMembers : [];
}

function getFaceTimeActiveConversations(result) {
  const payload = getFaceTimeAdmitPayload(result);
  return Array.isArray(payload.activeConversations) ? payload.activeConversations : [];
}

function getFaceTimeAdmitConversation(result, conversationUuid) {
  const conversations = getFaceTimeActiveConversations(result);
  if (conversations.length === 0) return null;
  if (!conversationUuid || conversationUuid === "__ANY__") return conversations[0];
  return (
    conversations.find(
      (item) =>
        item?.group_uuid === conversationUuid ||
        item?.groupUUID === conversationUuid ||
        item?.uuid === conversationUuid,
    ) || null
  );
}

function summarizeFaceTimeDirectAdmit(admit) {
  if (!admit) return "unknown";
  const count = admit.admittedCount ?? "unknown";
  const approvedCount = Array.isArray(admit.approvedMembers) ? admit.approvedMembers.length : "unknown";
  const conversations = Array.isArray(admit.activeConversations) ? admit.activeConversations : [];
  const conversation = conversations.find(
    (item) =>
      item?.group_uuid === admit.conversationUuid ||
      item?.groupUUID === admit.conversationUuid ||
      item?.uuid === admit.conversationUuid,
  );
  const state = conversation
    ? ` state=${conversation.state ?? "unknown"} joined=${conversation.has_joined ?? "unknown"} pending=${conversation.pending_count ?? "unknown"} remote=${conversation.remote_count ?? "unknown"} active_remote=${conversation.active_remote_count ?? "unknown"}`
    : "";
  const settled = admit.settled ? " settled=true" : "";
  return `direct:conversation=${admit.conversationUuid || "unknown"} count=${count} approved=${approvedCount} attempts=${admit.attempts || 0}${settled}${state}`;
}

function summarizeFaceTimeLinkConnect(result) {
  if (!result) return "unknown";
  if (result.ok) return "connected";
  if (result.skipped) return `skipped:${result.reason || "unknown"}`;
  const state = result.state;
  const waiting = state?.waiting ? " waiting=true" : "";
  const unavailable = state?.unavailable ? " unavailable=true" : "";
  return `not_connected:${result.reason || "unknown"}${waiting}${unavailable}`;
}

function summarizeFaceTimeAnswer(result) {
  const link = result?.data?.link;
  if (link) return "link_generated";
  return `status=${result?.status ?? "unknown"}`;
}

function summarizeFaceTimeLinkApp(result) {
  if (!result) return "not_run";
  if (result.skipped) return `skipped:${result.reason}`;
  if (result.ok) return `started:${result.pid}`;
  return `failed:${result.reason || "unknown"}`;
}

function summarizeFaceTimeLinkJoin(result) {
  if (!result) return "unknown";
  if (result.autojoin?.ok) return "joined";
  if (result.ok) return `opened:${result.pid || "unknown"}`;
  return `failed:${result.reason || result.autojoin?.reason || "unknown"}`;
}

function formatErrorBrief(error) {
  if (!error) return "unknown";
  return error instanceof Error ? error.message : String(error);
}

function findNumericProperty(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (Number.isFinite(value[key])) return value[key];
  for (const child of Object.values(value)) {
    const found = findNumericProperty(child, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body, null, 2));
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
