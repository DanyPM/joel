import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  runSpy: vi.fn(() => Promise.resolve()),
  outcomeSpy: vi.fn(() => Promise.resolve()),
  logErrorSpy: vi.fn(() => Promise.resolve()),
  logWarningSpy: vi.fn(() => Promise.resolve())
}));

vi.mock("../notifications/runNotificationProcess.ts", () => ({
  runNotificationProcess: h.runSpy,
  logNotificationOutcome: h.outcomeSpy
}));
vi.mock("../utils/debugLogger.ts", () => ({
  logError: h.logErrorSpy,
  logWarning: h.logWarningSpy
}));

import { startDailyNotificationJobs } from "../notifications/notificationScheduler.ts";

const HOUR = 60 * 60 * 1000;
const savedEnv = { ...process.env };

// 05:00 keeps computeNextOccurrence on the same calendar day, so the configured
// time decides whether the next occurrence lands ahead of or behind "now".
const at5am = new Date(2026, 7, 18, 5, 0, 0, 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(at5am);
});

afterEach(() => {
  vi.useRealTimers();
  process.env.NODE_ENV = savedEnv.NODE_ENV;
  process.env.DAILY_NOTIFICATION_TIME = savedEnv.DAILY_NOTIFICATION_TIME;
});

describe("startDailyNotificationJobs — surviving a bad next occurrence", () => {
  it("retries instead of unwinding when the next time cannot be computed", async () => {
    // In production an occurrence computed in the past throws rather than
    // rolling forward a day.
    process.env.NODE_ENV = "production";
    process.env.DAILY_NOTIFICATION_TIME = "00:01";

    expect(() => {
      startDailyNotificationJobs(["Telegram"], {});
    }).not.toThrow();

    expect(h.logErrorSpy).toHaveBeenCalledWith(
      "Telegram",
      expect.stringContaining("Could not compute the next notification time"),
      expect.any(Error)
    );

    // The retry keeps the loop alive rather than leaving the app silent.
    const callsBefore = h.logErrorSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.logErrorSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe("startDailyNotificationJobs — surviving a hung run", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.DAILY_NOTIFICATION_TIME = "09:00";
  });

  it("reschedules and reports when a run outstays the watchdog", async () => {
    h.runSpy.mockReturnValueOnce(new Promise<void>(() => undefined));

    startDailyNotificationJobs(["Telegram"], {});

    // 05:00 -> 09:00 fires the run, which then never settles.
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(h.runSpy).toHaveBeenCalledTimes(1);
    expect(h.outcomeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6 * HOUR);

    const watchdogCall = h.logErrorSpy.mock.calls.find((call) =>
      String(call[1]).includes("error during notification process")
    );
    expect(watchdogCall).toBeDefined();
    expect(String((watchdogCall?.[2] as Error | undefined)?.message)).toContain(
      "still unfinished"
    );
    expect(h.outcomeSpy).toHaveBeenCalledWith(
      ["Telegram"],
      "failed",
      0,
      expect.arrayContaining([expect.stringContaining("watchdog")])
    );
  });

  it("counts the cycles a hung run eats instead of going quiet", async () => {
    h.runSpy.mockReturnValueOnce(new Promise<void>(() => undefined));

    startDailyNotificationJobs(["Telegram"], {});
    await vi.advanceTimersByTimeAsync(4 * HOUR); // run starts
    await vi.advanceTimersByTimeAsync(6 * HOUR); // watchdog gives up
    h.outcomeSpy.mockClear();

    // Next day's occurrence still fires, and is reported as skipped rather
    // than silently vanishing.
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(h.outcomeSpy).toHaveBeenCalledWith(
      ["Telegram"],
      "skipped",
      0,
      expect.arrayContaining([expect.stringContaining("still in progress")])
    );
    // The hung run is never started a second time.
    expect(h.runSpy).toHaveBeenCalledTimes(1);
  });

  it("resumes normally once a slow run finally settles", async () => {
    let release: (() => void) | undefined;
    h.runSpy.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = () => {
          resolve();
        };
      })
    );

    startDailyNotificationJobs(["Telegram"], {});
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    await vi.advanceTimersByTimeAsync(6 * HOUR); // watchdog gave up

    release?.();
    await vi.advanceTimersByTimeAsync(0);

    // The schedule the watchdog rearmed carries on once the flag is released.
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(h.runSpy).toHaveBeenCalledTimes(2);
  });

  it("fires exactly one run per occurrence after a watchdog event", async () => {
    let release: (() => void) | undefined;
    h.runSpy.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = () => {
          resolve();
        };
      })
    );

    startDailyNotificationJobs(["Telegram"], {});
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    release?.();
    await vi.advanceTimersByTimeAsync(0);

    // The watchdog rearmed the schedule while the run was still pending, so
    // the token check has to keep that from compounding into extra timers.
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(h.runSpy).toHaveBeenCalledTimes(3);
  });
});
