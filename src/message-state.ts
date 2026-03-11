const DEFAULT_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_DEDUP_MAX_SIZE = 1000;

const dedupBuckets = new Map<string, Map<string, number>>();
const rateLimitBuckets = new Map<string, number[]>();

export function tryRecordMessage(params: {
  accountId: string;
  messageId: string;
  dedupWindowMs?: number;
  dedupMaxSize?: number;
}): boolean {
  const {
    accountId,
    messageId,
    dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS,
    dedupMaxSize = DEFAULT_DEDUP_MAX_SIZE,
  } = params;

  const now = Date.now();
  const bucket = dedupBuckets.get(accountId) ?? new Map<string, number>();
  dedupBuckets.set(accountId, bucket);

  for (const [id, ts] of bucket) {
    if (now - ts > dedupWindowMs) {
      bucket.delete(id);
    }
  }

  if (bucket.has(messageId)) {
    return false;
  }

  if (bucket.size >= dedupMaxSize) {
    const oldest = bucket.keys().next().value;
    if (oldest) {
      bucket.delete(oldest);
    }
  }

  bucket.set(messageId, now);
  return true;
}

export function tryConsumeRateLimit(params: {
  scopeKey: string;
  limit?: number;
  windowMs?: number;
}): boolean {
  const { scopeKey, limit, windowMs = 60_000 } = params;
  if (!limit || limit <= 0) {
    return true;
  }

  const now = Date.now();
  const bucket = rateLimitBuckets.get(scopeKey) ?? [];
  const fresh = bucket.filter((ts) => now - ts < windowMs);
  if (fresh.length >= limit) {
    rateLimitBuckets.set(scopeKey, fresh);
    return false;
  }

  fresh.push(now);
  rateLimitBuckets.set(scopeKey, fresh);
  return true;
}
