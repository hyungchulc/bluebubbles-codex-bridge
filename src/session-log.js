import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const DEFAULT_INITIAL_SCAN_BYTES = 16 * 1024 * 1024;
const INITIAL_SCAN_BYTES = Number(
  process.env.CODEX_SESSION_INITIAL_SCAN_BYTES || DEFAULT_INITIAL_SCAN_BYTES,
);

export async function waitForCodexReply({ requestId, sinceMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const scanner = new SessionReplyScanner(requestId);
  while (Date.now() < deadline) {
    const files = listRecentSessionFiles(sinceMs - 60_000);
    for (const file of files) {
      const hit = scanner.scanFile(file);
      if (hit) return hit;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for Codex reply for ${requestId}`);
}

export async function waitForCodexReplies({ requestId, sinceMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const scanner = new SessionReplyScanner(requestId);
  while (Date.now() < deadline) {
    const files = listRecentSessionFiles(sinceMs - 60_000);
    for (const file of files) {
      const hit = scanner.scanFile(file);
      if (hit?.complete && hit.messages.length > 0) return hit;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for Codex replies for ${requestId}`);
}

export async function streamCodexReplies({
  requestId,
  sinceMs,
  timeoutMs,
  onMessage,
}) {
  const deadline = Date.now() + timeoutMs;
  const scanner = new SessionReplyScanner(requestId);
  const sent = new Set();
  let lastHit = null;

  while (Date.now() < deadline) {
    const files = listRecentSessionFiles(sinceMs - 60_000);
    for (const file of files) {
      const hit = scanner.scanFile(file);
      if (!hit) continue;
      lastHit = hit;
      for (const message of hit.messages) {
        const key = message.id || `${message.phase}:${message.text}`;
        if (sent.has(key)) continue;
        sent.add(key);
        await onMessage({ ...message, file });
      }
      if (hit.complete) return hit;
    }
    await sleep(500);
  }

  throw new Error(
    lastHit
      ? `Timed out waiting for final Codex reply for ${requestId}`
      : `Timed out waiting for Codex replies for ${requestId}`,
  );
}

export function listRecentSessionFiles(sinceMs) {
  const files = [];
  walk(SESSIONS_DIR, files);
  return files
    .map((file) => {
      const stat = fs.statSync(file);
      return { file, mtimeMs: stat.mtimeMs };
    })
    .filter(({ mtimeMs }) => mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ file }) => file);
}

function parseReplyFromFile(file, requestId) {
  const scanner = new SessionReplyScanner(requestId, { initialScanBytes: Infinity });
  const hit = scanner.scanFile(file);
  if (!hit || hit.messages.length === 0) return null;
  return {
    file,
    text: hit.messages.at(-1).text,
    completedAt: hit.completedAt,
  };
}

export class SessionReplyScanner {
  constructor(requestId, { initialScanBytes = INITIAL_SCAN_BYTES } = {}) {
    this.requestId = requestId;
    this.initialScanBytes = initialScanBytes;
    this.files = new Map();
  }

  scanFile(file) {
    const state = this.stateForFile(file);
    const text = this.readNewText(file, state);
    if (!text) return state.messages.length > 0 ? this.hit(file, state) : null;

    consumeJsonlText(state, text, (line) => this.parseLine(state, line));
    return state.messages.length > 0 ? this.hit(file, state) : null;
  }

  stateForFile(file) {
    let state = this.files.get(file);
    if (state) return state;
    state = {
      offset: null,
      carry: "",
      seenRequest: false,
      complete: false,
      completedAt: null,
      sessionId: null,
      messages: [],
      seenMessageKeys: new Set(),
    };
    this.files.set(file, state);
    return state;
  }

  readNewText(file, state) {
    const stat = fs.statSync(file);
    let startedMidFile = false;
    if (state.offset === null || stat.size < state.offset) {
      const windowSize = Number.isFinite(this.initialScanBytes)
        ? Math.max(0, Math.min(stat.size, this.initialScanBytes))
        : stat.size;
      state.offset = stat.size - windowSize;
      state.carry = "";
      startedMidFile = state.offset > 0;
    }
    if (stat.size <= state.offset) return "";

    const length = stat.size - state.offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
    state.offset = stat.size;
    const text = buffer.toString("utf8");
    if (!startedMidFile) return text;
    const newline = text.search(/\r?\n/);
    return newline >= 0 ? text.slice(newline + 1) : "";
  }

  parseLine(state, line) {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.type === "session_meta" && entry.payload?.id) {
      state.sessionId = entry.payload.id;
    }

    if (entryContainsUserRequest(entry, this.requestId)) {
      state.seenRequest = true;
    }
    if (!state.seenRequest) return;

    const payload = entry.payload;
    if (
      entry.type === "response_item" &&
      payload?.type === "message" &&
      payload?.role === "assistant"
    ) {
      const text = extractMessageText(payload);
      if (text) {
        const key = payload.id || `${payload.phase || "assistant"}:${text}`;
        if (!state.seenMessageKeys.has(key)) {
          state.seenMessageKeys.add(key);
          state.messages.push({
            id: payload.id || null,
            phase: payload.phase || "assistant",
            text,
          });
        }
      }
    }
    if (entry.type === "response_item" && payload?.type === "image_generation_call") {
      const attachment = imageAttachmentFromCall({ sessionId: state.sessionId, payload });
      if (attachment) {
        const key = payload.id || `${attachment.filePath}:${attachment.name}`;
        if (!state.seenMessageKeys.has(key)) {
          state.seenMessageKeys.add(key);
          state.messages.push({
            id: payload.id || null,
            phase: "attachment",
            text: "",
            attachments: [attachment],
          });
        }
      }
    }
    if (entry.type === "event_msg" && payload?.type === "task_complete") {
      state.complete = true;
      state.completedAt = payload.completed_at || null;
      const finalAnswer = payload.last_agent_message || null;
      if (finalAnswer) {
        const last = state.messages.at(-1);
        const hasPriorFinalAnswer = state.messages.some(
          (message) => message.phase === "final_answer" && message.id !== "task_complete",
        );
        const hasPriorSameText = state.messages.some(
          (message) => message.text === finalAnswer,
        );
        if (!hasPriorFinalAnswer && !hasPriorSameText && (!last || last.text !== finalAnswer)) {
          state.messages.push({
            id: "task_complete",
            phase: "final_answer",
            text: finalAnswer,
          });
        }
      }
    }
  }

  hit(file, state) {
    return {
      file,
      messages: state.messages,
      complete: state.complete,
      completedAt: state.completedAt,
    };
  }
}

export class SessionThreadTailScanner {
  constructor({ offset = null } = {}) {
    this.initialOffset = Number.isFinite(Number(offset)) ? Number(offset) : null;
    this.files = new Map();
  }

  scanFile(file) {
    const state = this.stateForFile(file);
    const text = this.readNewText(file, state);
    const messages = [];
    if (text) {
      consumeJsonlText(state, text, (line) => this.parseLine(state, line, messages));
    }
    return {
      file,
      messages,
      offset: state.offset,
      complete: state.complete,
      completedAt: state.completedAt,
    };
  }

  stateForFile(file) {
    let state = this.files.get(file);
    if (state) return state;
    state = {
      offset: this.initialOffset,
      carry: "",
      complete: false,
      completedAt: null,
      sessionId: null,
      seenMessageKeys: new Set(),
      seenTexts: new Set(),
      seenFinalAnswer: false,
    };
    this.files.set(file, state);
    return state;
  }

  readNewText(file, state) {
    const stat = fs.statSync(file);
    if (state.offset === null || stat.size < state.offset) {
      state.offset = stat.size;
      state.carry = "";
    }
    if (stat.size <= state.offset) return "";

    const length = stat.size - state.offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
    state.offset = stat.size;
    return buffer.toString("utf8");
  }

  parseLine(state, line, messages) {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.type === "session_meta" && entry.payload?.id) {
      state.sessionId = entry.payload.id;
    }

    const payload = entry.payload;
    if (
      entry.type === "response_item" &&
      payload?.type === "message" &&
      payload?.role === "assistant"
    ) {
      const text = extractMessageText(payload);
      if (!text) return;
      const key = payload.id || `${payload.phase || "assistant"}:${text}`;
      if (state.seenMessageKeys.has(key)) return;
      state.seenMessageKeys.add(key);
      state.seenTexts.add(text);
      if (payload.phase === "final_answer") state.seenFinalAnswer = true;
      const message = {
        id: payload.id || null,
        phase: payload.phase || "assistant",
        text,
      };
      messages.push(message);
      return;
    }

    if (entry.type === "response_item" && payload?.type === "image_generation_call") {
      const attachment = imageAttachmentFromCall({ sessionId: state.sessionId, payload });
      if (!attachment) return;
      const key = payload.id || `${attachment.filePath}:${attachment.name}`;
      if (state.seenMessageKeys.has(key)) return;
      state.seenMessageKeys.add(key);
      messages.push({
        id: payload.id || null,
        phase: "attachment",
        text: "",
        attachments: [attachment],
      });
      return;
    }

    if (entry.type === "event_msg" && payload?.type === "task_complete") {
      state.complete = true;
      state.completedAt = payload.completed_at || null;
      const finalAnswer = payload.last_agent_message || null;
      if (!finalAnswer) return;
      const key = `task_complete:${state.completedAt || finalAnswer}`;
      if (
        state.seenMessageKeys.has(key) ||
        state.seenFinalAnswer ||
        state.seenTexts.has(finalAnswer)
      ) {
        return;
      }
      state.seenMessageKeys.add(key);
      state.seenTexts.add(finalAnswer);
      state.seenFinalAnswer = true;
      messages.push({
        id: "task_complete",
        phase: "final_answer",
        text: finalAnswer,
      });
    }
  }
}

function consumeJsonlText(state, text, parseLine) {
  const lines = `${state.carry}${text}`.split(/\r?\n/);
  state.carry = lines.pop() || "";
  for (const line of lines) {
    parseLine(line);
  }
  flushCompleteCarry(state, parseLine);
}

function flushCompleteCarry(state, parseLine) {
  if (!state.carry) return;
  if (!state.carry.trim()) {
    state.carry = "";
    return;
  }
  if (!isCompleteJsonLine(state.carry)) return;
  const line = state.carry;
  state.carry = "";
  parseLine(line);
}

function isCompleteJsonLine(line) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function extractMessageText(payload) {
  if (typeof payload?.content === "string") return payload.content;
  if (Array.isArray(payload?.content)) {
    return payload.content
      .map((item) => item.text || item.output_text || "")
      .join("")
      .trim();
  }
  return null;
}

function entryContainsUserRequest(entry, requestId) {
  if (!requestId) return false;
  const payload = entry?.payload;
  if (
    entry?.type === "response_item" &&
    payload?.type === "message" &&
    payload?.role === "user"
  ) {
    return extractMessageText(payload).includes(requestId);
  }
  if (entry?.type === "event_msg" && payload?.type === "user_message") {
    return String(payload.message || "").includes(requestId);
  }
  return false;
}

function imageAttachmentFromCall({ sessionId, payload }) {
  if (!payload?.id || !payload?.result) return null;

  const generatedPath = sessionId
    ? path.join(
        os.homedir(),
        ".codex",
        "generated_images",
        sessionId,
        `${payload.id}.png`,
      )
    : null;
  if (generatedPath && fs.existsSync(generatedPath)) {
    return {
      type: "image",
      filePath: generatedPath,
      name: `${payload.id}.png`,
      mimeType: "image/png",
    };
  }

  if (typeof payload.result !== "string") return null;
  const fallbackPath = sessionId
    ? path.join(
        os.homedir(),
        ".bluebubbles-codex-bridge",
        "state",
        "generated-images",
        sessionId,
        `${payload.id}.png`,
      )
    : path.join(
        os.homedir(),
        ".bluebubbles-codex-bridge",
        "state",
        "generated-images",
        `${payload.id}.png`,
      );
  fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
  if (!fs.existsSync(fallbackPath)) {
    fs.writeFileSync(fallbackPath, Buffer.from(payload.result, "base64"));
  }
  return {
    type: "image",
    filePath: fallbackPath,
    name: `${payload.id}.png`,
    mimeType: "image/png",
  };
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
    } else if (entry.isFile() && entry.name.startsWith("rollout-")) {
      out.push(fullPath);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
