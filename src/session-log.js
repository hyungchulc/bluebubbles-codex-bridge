import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

export async function waitForCodexReply({ requestId, sinceMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = listRecentSessionFiles(sinceMs - 60_000);
    for (const file of files) {
      const hit = parseReplyFromFile(file, requestId);
      if (hit) return hit;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for Codex reply for ${requestId}`);
}

export async function waitForCodexReplies({ requestId, sinceMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = listRecentSessionFiles(sinceMs - 60_000);
    for (const file of files) {
      const hit = parseRepliesFromFile(file, requestId);
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
  const sent = new Set();
  let lastHit = null;

  while (Date.now() < deadline) {
    const files = listRecentSessionFiles(sinceMs - 60_000);
    for (const file of files) {
      const hit = parseRepliesFromFile(file, requestId);
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
  const hit = parseRepliesFromFile(file, requestId);
  if (!hit || hit.messages.length === 0) return null;
  return {
    file,
    text: hit.messages.at(-1).text,
    completedAt: hit.completedAt,
  };
}

function parseRepliesFromFile(file, requestId) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(requestId)) return null;

  let seenRequest = false;
  let complete = false;
  let completedAt = null;
  let sessionId = null;
  const messages = [];
  const seenMessageKeys = new Set();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session_meta" && entry.payload?.id) {
      sessionId = entry.payload.id;
    }

    const serialized = JSON.stringify(entry);
    if (serialized.includes(requestId)) seenRequest = true;
    if (!seenRequest) continue;

    const payload = entry.payload;
    if (
      entry.type === "response_item" &&
      payload?.type === "message" &&
      payload?.role === "assistant"
    ) {
      const text = extractMessageText(payload);
      if (text) {
        const key = payload.id || `${payload.phase || "assistant"}:${text}`;
        if (!seenMessageKeys.has(key)) {
          seenMessageKeys.add(key);
          messages.push({
            id: payload.id || null,
            phase: payload.phase || "assistant",
            text,
          });
        }
      }
    }
    if (entry.type === "response_item" && payload?.type === "image_generation_call") {
      const attachment = imageAttachmentFromCall({ sessionId, payload });
      if (attachment) {
        const key = payload.id || `${attachment.filePath}:${attachment.name}`;
        if (!seenMessageKeys.has(key)) {
          seenMessageKeys.add(key);
          messages.push({
            id: payload.id || null,
            phase: "attachment",
            text: "",
            attachments: [attachment],
          });
        }
      }
    }
    if (entry.type === "event_msg" && payload?.type === "task_complete") {
      complete = true;
      completedAt = payload.completed_at || null;
      const finalAnswer = payload.last_agent_message || null;
      if (finalAnswer) {
        const last = messages.at(-1);
        if (!last || last.text !== finalAnswer) {
          messages.push({
            id: "task_complete",
            phase: "final_answer",
            text: finalAnswer,
          });
        }
      }
    }
  }

  return messages.length > 0
    ? { file, messages, complete, completedAt }
    : null;
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
        "Aria",
        "state",
        "generated-images",
        sessionId,
        `${payload.id}.png`,
      )
    : path.join(os.homedir(), "Aria", "state", "generated-images", `${payload.id}.png`);
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
