import fs from "node:fs";
import path from "node:path";

export class BlueBubblesClient {
  constructor({ baseUrl, password, sendTextPath }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.password = password;
    this.sendTextPath = sendTextPath.startsWith("/")
      ? sendTextPath
      : `/${sendTextPath}`;
  }

  authUrl(path) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (this.password) url.searchParams.set("guid", this.password);
    return url;
  }

  async ping() {
    const response = await fetch(this.authUrl("/api/v1/ping"));
    return {
      ok: response.ok,
      status: response.status,
      body: await readJsonOrText(response),
    };
  }

  async serverInfo() {
    return this.requestJson("GET", "/api/v1/server/info", {});
  }

  async createFaceTimeSession() {
    return this.postJson("/api/v1/facetime/session", {});
  }

  async answerFaceTimeCall(callUuid) {
    if (!callUuid) throw new Error("answerFaceTimeCall requires callUuid");
    return this.postJson(`/api/v1/facetime/answer/${encodeURIComponent(callUuid)}`, {});
  }

  async answerFaceTimeCallRaw(callUuid) {
    if (!callUuid) throw new Error("answerFaceTimeCallRaw requires callUuid");
    return this.postJson(`/api/v1/facetime/answer-raw/${encodeURIComponent(callUuid)}`, {});
  }

  async generateFaceTimeLink(callUuid) {
    if (!callUuid) throw new Error("generateFaceTimeLink requires callUuid");
    return this.postJson(`/api/v1/facetime/link/${encodeURIComponent(callUuid)}`, {});
  }

  async getFaceTimeActiveLinks() {
    return this.postJson("/api/v1/facetime/active-links", {});
  }

  async admitFaceTimeSelf(callUuid, { lookbackMs = 30_000 } = {}) {
    if (!callUuid) throw new Error("admitFaceTimeSelf requires callUuid");
    return this.postJson(`/api/v1/facetime/admit-self/${encodeURIComponent(callUuid)}`, {
      lookbackMs,
    });
  }

  async admitFaceTimeParticipant({ conversationUuid, handleUuid }) {
    if (!conversationUuid) {
      throw new Error("admitFaceTimeParticipant requires conversationUuid");
    }
    if (!handleUuid) {
      throw new Error("admitFaceTimeParticipant requires handleUuid");
    }
    return this.postJson("/api/v1/facetime/admit", {
      conversationUuid,
      handleUuid,
    });
  }

  async leaveFaceTimeCall(callUuid) {
    if (!callUuid) throw new Error("leaveFaceTimeCall requires callUuid");
    return this.postJson(`/api/v1/facetime/leave/${encodeURIComponent(callUuid)}`, {});
  }

  async sendText({
    chatGuid,
    address,
    text,
    method = "apple-script",
    attributedBody = null,
    selectedMessageGuid = null,
    partIndex = 0,
    ddScan = null,
    payloadData = null,
    balloonBundleId = null,
    timeoutMs = null,
  }) {
    if (!this.password) {
      throw new Error("BLUEBUBBLES_PASSWORD is required to send messages");
    }
    if (!text || typeof text !== "string") {
      throw new Error("sendText requires non-empty text");
    }
    if (!chatGuid && !address) {
      throw new Error("sendText requires chatGuid or address");
    }

    const body = chatGuid
      ? { chatGuid, message: text, method, tempGuid: makeTempGuid() }
      : { address, message: text, method, tempGuid: makeTempGuid() };
    if (attributedBody) body.attributedBody = attributedBody;
    if (selectedMessageGuid) body.selectedMessageGuid = selectedMessageGuid;
    if (selectedMessageGuid || partIndex) body.partIndex = partIndex;
    if (typeof ddScan === "boolean") body.ddScan = ddScan;
    if (payloadData) body.payloadData = payloadData;
    if (balloonBundleId) body.balloonBundleId = balloonBundleId;

    const controller = timeoutMs ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs)))
      : null;
    timeout?.unref?.();
    let response;
    try {
      response = await fetch(this.authUrl(this.sendTextPath), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(`BlueBubbles send timed out after ${timeoutMs}ms`);
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const data = await readJsonOrText(response);
    if (!response.ok) {
      const error = new Error(
        `BlueBubbles send failed (${response.status}): ${JSON.stringify(data)}`,
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async markRead(chatGuid, messageGuid = null) {
    return this.postJson(`/api/v1/chat/${encodeURIComponent(chatGuid)}/read`, {
      ...(messageGuid ? { messageGuid } : {}),
    });
  }

  async markPlayed(chatGuid, messageGuid) {
    if (!messageGuid) {
      throw new Error("markPlayed requires messageGuid");
    }
    return this.postJson(`/api/v1/chat/${encodeURIComponent(chatGuid)}/played`, {
      messageGuid,
    });
  }

  async markUnread(chatGuid) {
    return this.postJson(`/api/v1/chat/${encodeURIComponent(chatGuid)}/unread`, {});
  }

  async startTyping(chatGuid) {
    return this.postJson(`/api/v1/chat/${encodeURIComponent(chatGuid)}/typing`, {});
  }

  async stopTyping(chatGuid) {
    return this.requestJson("DELETE", `/api/v1/chat/${encodeURIComponent(chatGuid)}/typing`, {});
  }

  async sendReaction({ chatGuid, selectedMessageGuid, reaction, partIndex = 0 }) {
    if (!chatGuid || !selectedMessageGuid || !reaction) {
      throw new Error("sendReaction requires chatGuid, selectedMessageGuid, and reaction");
    }
    return this.postJson("/api/v1/message/react", {
      chatGuid,
      selectedMessageGuid,
      reaction,
      partIndex,
    });
  }

  async sendAttachment({
    chatGuid,
    filePath,
    name = null,
    isAudioMessage = false,
    method = "apple-script",
    selectedMessageGuid = null,
    partIndex = 0,
  }) {
    if (!chatGuid || !filePath) {
      throw new Error("sendAttachment requires chatGuid and filePath");
    }
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.set("chatGuid", chatGuid);
    form.set("name", name || path.basename(filePath));
    form.set("method", method);
    form.set("tempGuid", makeTempGuid());
    form.set("isAudioMessage", String(Boolean(isAudioMessage)));
    if (selectedMessageGuid) form.set("selectedMessageGuid", selectedMessageGuid);
    if (partIndex) form.set("partIndex", String(partIndex));
    form.set("attachment", new Blob([bytes]), name || path.basename(filePath));

    const response = await fetch(this.authUrl("/api/v1/message/attachment"), {
      method: "POST",
      body: form,
    });
    const data = await readJsonOrText(response);
    if (!response.ok) {
      const error = new Error(
        `BlueBubbles attachment send failed (${response.status}): ${JSON.stringify(data)}`,
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async uploadAttachment({ filePath, name = null }) {
    if (!filePath) {
      throw new Error("uploadAttachment requires filePath");
    }
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.set("attachment", new Blob([bytes]), name || path.basename(filePath));
    const response = await fetch(this.authUrl("/api/v1/attachment/upload"), {
      method: "POST",
      body: form,
    });
    const data = await readJsonOrText(response);
    if (!response.ok) {
      const error = new Error(
        `BlueBubbles attachment upload failed (${response.status}): ${JSON.stringify(data)}`,
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async sendMultipart({
    chatGuid,
    parts,
    ddScan = null,
    payloadData = null,
    balloonBundleId = null,
  }) {
    if (!chatGuid) {
      throw new Error("sendMultipart requires chatGuid");
    }
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error("sendMultipart requires parts");
    }
    const body = { chatGuid, parts, tempGuid: makeTempGuid() };
    if (typeof ddScan === "boolean") body.ddScan = ddScan;
    if (payloadData) body.payloadData = payloadData;
    if (balloonBundleId) body.balloonBundleId = balloonBundleId;
    return this.postJson("/api/v1/message/multipart", body);
  }

  async sendRichLink({
    chatGuid,
    text,
    payloadData,
    balloonBundleId,
    attachmentFilePath = null,
    attachmentName = null,
  }) {
    if (!attachmentFilePath) {
      return this.sendText({
        chatGuid,
        text,
        method: "private-api",
        ddScan: false,
        payloadData,
        balloonBundleId,
      });
    }
    const uploadResult = await this.uploadAttachment({
      filePath: attachmentFilePath,
      name: attachmentName || path.basename(attachmentFilePath),
    });
    const uploadPath = uploadResult?.data?.path;
    if (!uploadPath) {
      throw new Error(`BlueBubbles upload response did not include a path: ${JSON.stringify(uploadResult)}`);
    }
    return this.sendMultipart({
      chatGuid,
      parts: [
        { partIndex: 0, text },
        { partIndex: 1, attachment: uploadPath, name: attachmentName || path.basename(attachmentFilePath) },
      ],
      ddScan: false,
      payloadData,
      balloonBundleId,
    });
  }

  async downloadAttachment({ guid, outputPath = null, force = false }) {
    if (!guid) throw new Error("downloadAttachment requires guid");
    const suffix = force ? "/download/force" : "/download";
    const response = await fetch(
      this.authUrl(`/api/v1/attachment/${encodeURIComponent(guid)}${suffix}`),
    );
    if (!response.ok) {
      const data = await readJsonOrText(response);
      throw new Error(
        `BlueBubbles attachment download failed (${response.status}): ${JSON.stringify(data)}`,
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buffer);
    }
    return {
      bytes: buffer.length,
      outputPath,
      contentType: response.headers.get("content-type"),
    };
  }

  async postJson(path, body) {
    return this.requestJson("POST", path, body);
  }

  async requestJson(method, path, body) {
    if (!this.password) {
      throw new Error("BLUEBUBBLES_PASSWORD is required");
    }
    const response = await fetch(this.authUrl(path), {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
    const data = await readJsonOrText(response);
    if (!response.ok) {
      const error = new Error(
        `BlueBubbles ${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`,
      );
      error.status = response.status;
      error.data = data;
      error.method = method;
      error.path = path;
      throw error;
    }
    return data;
  }
}

function makeTempGuid() {
  return crypto.randomUUID().toUpperCase();
}

export function extractIncomingMessage(payload) {
  const data = payload?.data ?? payload?.message ?? payload;
  const text =
    firstString(
      data?.text,
      data?.message,
      data?.body,
      data?.attributedBody,
      payload?.text,
      payload?.body,
    ) || "";
  const chatGuid = firstString(
    data?.chatGuid,
    data?.chat?.guid,
    data?.chat?.chatGuid,
    data?.chats?.[0]?.guid,
    data?.chats?.[0]?.chatGuid,
    payload?.chatGuid,
    payload?.chat?.guid,
  );
  const handle = firstString(
    data?.handle,
    data?.handleAddress,
    data?.sender,
    data?.from,
    data?.address,
    data?.handle?.address,
    payload?.sender,
    payload?.from,
  );
  const isFromMe = Boolean(
    data?.isFromMe ??
      data?.fromMe ??
      data?.message?.isFromMe ??
      payload?.isFromMe ??
      payload?.fromMe,
  );
  const event = firstString(payload?.type, payload?.event, data?.type);
  const guid = firstString(data?.guid, data?.message?.guid, payload?.guid);
  const associatedMessageGuid = normalizeReplyGuid(
    firstString(data?.associatedMessageGuid, data?.associated_message_guid),
  );
  const replyToGuid = normalizeReplyGuid(
    firstString(data?.replyToGuid, data?.reply_to_guid),
  );
  const threadOriginatorGuid = normalizeReplyGuid(
    firstString(data?.threadOriginatorGuid, data?.thread_originator_guid),
  );
  const subjectGuid = normalizeReplyGuid(firstString(data?.subject));
  const replyTargetGuid =
    replyToGuid || threadOriginatorGuid || associatedMessageGuid || subjectGuid;

  return {
    event,
    guid,
    text: normalizeBody(text),
    attachments: Array.isArray(data?.attachments) ? data.attachments : [],
    chatGuid,
    handle,
    isFromMe,
    partIndex: Number.isFinite(Number(data?.partIndex)) ? Number(data.partIndex) : 0,
    replyContext: {
      targetGuid: replyTargetGuid,
      replyToGuid,
      threadOriginatorGuid,
      associatedMessageGuid,
      associatedMessageType: data?.associatedMessageType ?? null,
      subjectGuid,
    },
    raw: payload,
  };
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeBody(text) {
  return String(text || "")
    .replace(/\uFFFC/g, "")
    .trim();
}

function normalizeReplyGuid(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^p:\d+\//, "");
}
