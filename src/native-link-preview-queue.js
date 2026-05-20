export function createSequentialTaskQueue() {
  let tail = Promise.resolve();

  return {
    run(task) {
      const run = tail.catch(() => null).then(task);
      tail = run.catch(() => null);
      return run;
    },
  };
}

export function isLinkPreviewMaterializedRecord(record) {
  return Boolean(
    record?.hasPayloadData ||
      (Array.isArray(record?.attachments) && record.attachments.length > 0),
  );
}

export async function waitForLinkPreviewMaterialization({
  getRecord,
  timeoutMs,
  pollMs,
  sleep = defaultSleep,
}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const intervalMs = Math.max(100, Number(pollMs) || 500);
  do {
    const record = getRecord();
    if (isLinkPreviewMaterializedRecord(record)) return record;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  } while (Date.now() <= deadline);
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
