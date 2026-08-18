import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { postSpy } = vi.hoisted(() => ({ postSpy: vi.fn() }));

vi.mock("axios", () => ({
  default: { create: () => ({ post: postSpy }) },
  isAxiosError: () => true
}));

const savedNodeEnv = process.env.NODE_ENV;
// logInternal short-circuits under test and development; exercise the send path.
process.env.NODE_ENV = "production";
process.env.UMAMI_HOST = "umami.example";
process.env.UMAMI_ID = "site-id";

const { logAsyncVerified } = await import("../utils/umami.ts");

beforeEach(() => {
  vi.clearAllMocks();
  // Re-applied per test: logInternal reads NODE_ENV at call time and
  // short-circuits under "test".
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  vi.useRealTimers();
  process.env.NODE_ENV = savedNodeEnv;
});

// Delivery is retried with a back-off, so drive the clock rather than waiting.
const send = async () => {
  vi.useFakeTimers();
  const pending = logAsyncVerified({ event: "/stats", messageApp: "Telegram" });
  await vi.runAllTimersAsync();
  return await pending;
};

describe("logAsyncVerified", () => {
  it("reports success on the first attempt", async () => {
    postSpy.mockResolvedValue({ data: "ok" });
    await expect(send()).resolves.toBe(true);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("retries a failed send and reports success when it lands", async () => {
    postSpy
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ data: "ok" });

    await expect(send()).resolves.toBe(true);
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  it("reports failure once the attempts are exhausted", async () => {
    postSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(send()).resolves.toBe(false);
    expect(postSpy).toHaveBeenCalledTimes(3);
  });
});
