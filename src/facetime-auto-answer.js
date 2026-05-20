export const FACETIME_INCOMING_STATUS_ID = 4;

export function extractFaceTimeCallStatus(payload) {
  if (!payload || payload.type !== "ft-call-status-changed") return null;
  const data = payload.data || {};
  const uuid = firstString(data.uuid, data.call_uuid, data.callUuid);
  const address = firstString(data.address, data.handle?.address, data.handle?.value);
  const status = firstString(data.status);
  const statusId = Number(data.status_id ?? data.statusId ?? data.call_status);
  return {
    uuid,
    address,
    status,
    statusId: Number.isFinite(statusId) ? statusId : null,
    isOutgoing: Boolean(data.is_outgoing ?? data.isOutgoing),
    raw: data,
  };
}

export function shouldAutoAnswerFaceTimeCall(event, { enabled, allowedCallers }) {
  if (!event) return { ok: false, reason: "not_facetime_event" };
  if (!enabled) return { ok: false, reason: "disabled" };
  if (!event.uuid) return { ok: false, reason: "missing_uuid" };
  if (event.isOutgoing) return { ok: false, reason: "outgoing_call" };
  if (!isIncomingFaceTimeStatus(event)) {
    return { ok: false, reason: "not_incoming", status: event.status, statusId: event.statusId };
  }
  if (!allowedCallers || allowedCallers.size === 0) {
    return { ok: false, reason: "no_allowed_callers" };
  }
  if (!isAllowedFaceTimeCaller(event.address, allowedCallers)) {
    return { ok: false, reason: "caller_not_allowed" };
  }
  return { ok: true };
}

export function isIncomingFaceTimeStatus(event) {
  return (
    event?.statusId === FACETIME_INCOMING_STATUS_ID ||
    String(event?.status || "").toLowerCase() === "incoming"
  );
}

export function isAllowedFaceTimeCaller(address, allowedCallers) {
  const keys = getFaceTimeCallerKeys(address);
  for (const key of keys) {
    if (allowedCallers.has(key)) return true;
  }
  return false;
}

export function normalizeFaceTimeCaller(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("@")) return text;
  return text.replace(/[\s().-]/g, "");
}

export function getFaceTimeCallerKeys(value) {
  const normalized = normalizeFaceTimeCaller(value);
  if (!normalized) return [];
  const keys = new Set([normalized]);
  if (normalized.startsWith("+")) keys.add(normalized.slice(1));
  return [...keys];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
