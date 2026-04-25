const pending = new Map();

export function addPendingReply(reply) {
  pending.set(reply.id, reply);
  return reply;
}

export function listPendingReplies() {
  return Array.from(pending.values());
}

export function getPendingReply(id) {
  return pending.get(id) || null;
}

export function getLatestPendingReply() {
  const replies = Array.from(pending.values());
  return replies.at(-1) || null;
}

export function removePendingReply(id) {
  pending.delete(id);
}
