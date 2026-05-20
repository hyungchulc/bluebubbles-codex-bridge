export function createOutgoingDedupe({
  ttlMs = 60_000,
  ttlMsForClaim = () => ttlMs,
  now = () => Date.now(),
} = {}) {
  const claims = new Map();

  function prune() {
    const currentTime = now();
    for (const [key, claim] of claims.entries()) {
      if (claim.expiresAt <= currentTime) claims.delete(key);
    }
  }

  return {
    claim({ chatGuid, address, text }) {
      prune();
      const key = outgoingDedupeKey({ chatGuid, address, text });
      if (!key) return { ok: true, key: null };
      if (claims.has(key)) {
        return { ok: false, key, claimedAt: claims.get(key).claimedAt };
      }
      const claimedAt = now();
      const claimTtlMs = Number(ttlMsForClaim({ chatGuid, address, text }) ?? ttlMs);
      claims.set(key, {
        claimedAt,
        expiresAt: claimedAt + Math.max(0, claimTtlMs),
      });
      return { ok: true, key };
    },

    release(key) {
      if (key) claims.delete(key);
    },

    size() {
      prune();
      return claims.size;
    },
  };
}

export function isRecentOutgoingTextDuplicate({
  records = [],
  chatGuid,
  address,
  text,
  ttlMs = 60_000,
  now = Date.now(),
} = {}) {
  return Boolean(
    findRecentOutgoingTextDuplicate({
      records,
      chatGuid,
      address,
      text,
      ttlMs,
      now,
    }),
  );
}

export function findRecentOutgoingTextDuplicate({
  records = [],
  chatGuid,
  address,
  text,
  ttlMs = 60_000,
  now = Date.now(),
} = {}) {
  const targets = normalizeOutgoingDedupeTargets([chatGuid, address]);
  const body = normalizeOutgoingDedupeText(text);
  if (targets.size === 0 || !body) return null;

  const currentTime = typeof now === "function" ? Number(now()) : Number(now);
  const duplicateWindowMs = Math.max(0, Number(ttlMs) || 0);
  for (const record of records) {
    if (!record?.isFromMe) continue;
    const recordTargets = normalizeOutgoingDedupeTargets([record.chatGuid, record.handle]);
    if (!hasSharedTarget(targets, recordTargets)) continue;
    if (normalizeOutgoingDedupeText(record.text) !== body) continue;

    const seenAt = Date.parse(record.seenAt || "");
    if (!Number.isFinite(seenAt)) continue;
    if (seenAt > currentTime + 5_000) continue;
    if (currentTime - seenAt <= duplicateWindowMs) return record;
  }
  return null;
}

function outgoingDedupeKey({ chatGuid, address, text }) {
  const target = normalizeOutgoingDedupeTarget(chatGuid || address);
  const body = normalizeOutgoingDedupeText(text);
  if (!target || !body) return null;
  return `${target}\u0000${body}`;
}

export function normalizeOutgoingDedupeTarget(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeOutgoingDedupeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function normalizeOutgoingDedupeTargets(values) {
  const targets = new Set();
  for (const value of values) {
    const target = normalizeOutgoingDedupeTarget(value);
    if (target) targets.add(target);
  }
  return targets;
}

function hasSharedTarget(left, right) {
  for (const target of left) {
    if (right.has(target)) return true;
  }
  return false;
}
