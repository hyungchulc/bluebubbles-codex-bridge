export function parseSteerCommand(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const match = trimmed.match(/^\/steer(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    note: String(match[1] || "").trim(),
  };
}

export function formatSteerNote(note, { downloadedAttachments = [] } = {}) {
  const body = String(note || "").trim();
  const attachments = formatSteerAttachments(downloadedAttachments);
  return [body, attachments].filter(Boolean).join("\n\n");
}

export function buildSteerFallbackIncoming(incoming, steerCommand) {
  return {
    ...incoming,
    text: String(steerCommand?.note || "").trim(),
  };
}

function formatSteerAttachments(downloadedAttachments) {
  if (!Array.isArray(downloadedAttachments) || downloadedAttachments.length === 0) return "";
  const lines = downloadedAttachments
    .map((item) => {
      const label = item?.transferName || item?.guid || "attachment";
      const location = item?.outputPath || "[download failed]";
      const mimeType = item?.mimeType || "unknown";
      const suffix = item?.error ? `; download error: ${item.error}` : "";
      return `- ${label}: ${location} (${mimeType}${suffix})`;
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return [
    "Steer attachments downloaded locally. If the steer request depends on an image or file, inspect it before answering:",
    ...lines,
  ].join("\n");
}
