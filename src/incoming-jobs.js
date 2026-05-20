import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOG_PATH = path.join(
  process.env.BRIDGE_STATE_DIR || path.join(os.homedir(), ".bluebubbles-codex-bridge", "state"),
  "bluebubbles-incoming-jobs.jsonl",
);
const DEFAULT_OPEN_JOB_MAX_AGE_MS = Number(
  process.env.INCOMING_JOB_OPEN_MAX_AGE_MS || 30 * 60 * 1000,
);

export class IncomingJobStore {
  constructor({ logPath = DEFAULT_LOG_PATH, now = () => new Date() } = {}) {
    this.logPath = logPath;
    this.now = now;
  }

  start({ incoming, prompt }) {
    const id = incoming?.guid || `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.append({
      type: "started",
      id,
      ts: this.now().toISOString(),
      incoming: summarizeIncoming(incoming),
      prompt,
    });
    return id;
  }

  mark(id, type, extra = {}) {
    this.append({
      type,
      id,
      ts: this.now().toISOString(),
      ...extra,
    });
  }

  listOpen({ maxAgeMs = DEFAULT_OPEN_JOB_MAX_AGE_MS } = {}) {
    const open = new Map();
    const minStartedAtMs = this.now().getTime() - maxAgeMs;
    for (const event of this.readEvents()) {
      if (!event?.id || !event?.type) continue;
      if (event.type === "started") {
        const startedAtMs = Date.parse(event.ts || "");
        if (Number.isFinite(startedAtMs) && startedAtMs < minStartedAtMs) {
          open.delete(event.id);
          continue;
        }
        open.set(event.id, { ...event, status: "started" });
        continue;
      }
      const job = open.get(event.id);
      if (!job) continue;
      job.status = event.type;
      job.lastEvent = event;
      if (["sent", "queued", "ignored", "failed"].includes(event.type)) {
        open.delete(event.id);
      }
    }
    return Array.from(open.values());
  }

  append(event) {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
  }

  readEvents() {
    try {
      if (!fs.existsSync(this.logPath)) return [];
      return fs
        .readFileSync(this.logPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

function summarizeIncoming(incoming) {
  return {
    guid: incoming?.guid || null,
    chatGuid: incoming?.chatGuid || null,
    handle: incoming?.handle || null,
    text: incoming?.text || "",
    attachmentCount: Array.isArray(incoming?.attachments) ? incoming.attachments.length : 0,
    attachments: Array.isArray(incoming?.attachments)
      ? incoming.attachments.map((item) => ({
          guid: item?.guid || item?.originalGuid || null,
          transferName: item?.transferName || null,
          mimeType: item?.mimeType || null,
        }))
      : [],
  };
}
