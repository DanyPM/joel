import { describe, it, expect, vi, afterEach } from "vitest";
import { createTtlDedup } from "../utils/webhookDedup.ts";

const TTL_MS = 5 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe("createTtlDedup", () => {
  it("lets a first-seen id through and blocks its redelivery", () => {
    const seen = createTtlDedup(TTL_MS);
    expect(seen("msg-1")).toBe(false);
    expect(seen("msg-1")).toBe(true);
  });

  it("lets distinct keys through (same message id, different statuses)", () => {
    const seen = createTtlDedup(TTL_MS);
    expect(seen("msg-1:sent")).toBe(false);
    expect(seen("msg-1:delivered")).toBe(false);
    expect(seen("msg-1:read")).toBe(false);
    // Redelivery of an already-seen transition is blocked.
    expect(seen("msg-1:delivered")).toBe(true);
  });

  it("never dedups an undefined id", () => {
    const seen = createTtlDedup(TTL_MS);
    expect(seen(undefined)).toBe(false);
    expect(seen(undefined)).toBe(false);
  });

  it("forgets ids past the TTL", () => {
    vi.useFakeTimers();
    const seen = createTtlDedup(TTL_MS);
    expect(seen("msg-1")).toBe(false);

    vi.advanceTimersByTime(TTL_MS + 1);
    // The entry aged out: the same id is treated as new again.
    expect(seen("msg-1")).toBe(false);
  });

  it("keeps ids within the TTL", () => {
    vi.useFakeTimers();
    const seen = createTtlDedup(TTL_MS);
    expect(seen("msg-1")).toBe(false);

    vi.advanceTimersByTime(TTL_MS - 1);
    expect(seen("msg-1")).toBe(true);
  });

  it("instances are independent (inbound vs status windows)", () => {
    const inbound = createTtlDedup(TTL_MS);
    const status = createTtlDedup(TTL_MS);
    expect(inbound("id-1")).toBe(false);
    expect(status("id-1")).toBe(false);
  });
});
