// TTL-based idempotency guard for webhook callbacks. Meta delivers both
// inbound messages and delivery statuses at-least-once, so each webhook
// consumer needs its own dedup window to avoid double-processing (double
// replies, duplicated error handling / DB writes).
export function createTtlDedup(
  ttlMs: number
): (id: string | undefined) => boolean {
  const seen = new Map<string, number>();

  // Returns true when the id was already seen within the TTL (duplicate).
  return (id: string | undefined): boolean => {
    if (id == null) return false;

    const now = Date.now();

    // prune entries older than the TTL to avoid unbounded growth
    for (const [knownId, timestamp] of Array.from(seen)) {
      if (now - timestamp > ttlMs) {
        seen.delete(knownId);
      }
    }

    if (seen.has(id)) {
      return true;
    }

    seen.set(id, now);
    return false;
  };
}
