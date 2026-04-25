export function createOutgoingDedupe({
  ttlMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const claims = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, claimedAt] of claims.entries()) {
      if (claimedAt < cutoff) claims.delete(key);
    }
  }

  return {
    claim({ chatGuid, address, text }) {
      prune();
      const key = outgoingDedupeKey({ chatGuid, address, text });
      if (!key) return { ok: true, key: null };
      if (claims.has(key)) {
        return { ok: false, key, claimedAt: claims.get(key) };
      }
      claims.set(key, now());
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

function outgoingDedupeKey({ chatGuid, address, text }) {
  const target = normalizeTarget(chatGuid || address);
  const body = normalizeText(text);
  if (!target || !body) return null;
  return `${target}\u0000${body}`;
}

function normalizeTarget(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}
