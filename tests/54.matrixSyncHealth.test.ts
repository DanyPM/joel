import { describe, it, expect, vi, beforeEach } from "vitest";

const { logErrorSpy, logWarningSpy } = vi.hoisted(() => ({
  logErrorSpy: vi.fn(() => Promise.resolve()),
  logWarningSpy: vi.fn(() => Promise.resolve())
}));

vi.mock("../utils/debugLogger.ts", () => ({
  logError: logErrorSpy,
  logWarning: logWarningSpy
}));

const {
  attachSyncHealth,
  createSyncHealth,
  SYNC_ALERT_AFTER_FAILURES,
  SYNC_ALERT_AFTER_MS,
  SYNC_REALERT_COOLDOWN_MS
} = await import("../utils/matrixSyncHealth.ts");

const tokenError = () => ({
  errcode: "M_UNKNOWN",
  error: "Unable to introspect the access token"
});

const alertTexts = () =>
  logErrorSpy.mock.calls.map((call) => (call as unknown as string[]).join(" "));

let clock: number;

const healthWithClock = () => createSyncHealth("Tchap", { now: () => clock });

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
});

describe("sync health alerting", () => {
  it("stays quiet while failures are below the threshold", async () => {
    const health = healthWithClock();

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES - 1; i++) {
      clock += 1000;
      await health.recordFailure(tokenError());
    }

    expect(logErrorSpy).not.toHaveBeenCalled();
  });

  it("alerts once when the failures pile up, naming the errcode", async () => {
    const health = healthWithClock();

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES + 5; i++) {
      clock += 1000;
      await health.recordFailure(tokenError());
    }

    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    const alert = alertTexts()[0];
    expect(alert).toContain("Tchap");
    expect(alert).toContain("Unable to introspect the access token");
    expect(alert).not.toContain("[object Object]");
  });

  it("alerts on a short but long-lasting outage", async () => {
    const health = healthWithClock();

    await health.recordFailure(tokenError());
    clock += SYNC_ALERT_AFTER_MS + 1;
    await health.recordFailure(tokenError());

    expect(logErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("re-alerts only once the cooldown has elapsed", async () => {
    const health = healthWithClock();

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES; i++) {
      clock += 1000;
      await health.recordFailure(tokenError());
    }
    expect(logErrorSpy).toHaveBeenCalledTimes(1);

    clock += SYNC_REALERT_COOLDOWN_MS - 1;
    await health.recordFailure(tokenError());
    expect(logErrorSpy).toHaveBeenCalledTimes(1);

    clock += 2;
    await health.recordFailure(tokenError());
    expect(logErrorSpy).toHaveBeenCalledTimes(2);
  });

  it("reports recovery with the outage duration once sync succeeds", async () => {
    const health = healthWithClock();

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES; i++) {
      clock += 60_000;
      await health.recordFailure(tokenError());
    }
    await health.recordSuccess();

    expect(logWarningSpy).toHaveBeenCalledTimes(1);
    const recovery = (logWarningSpy.mock.calls[0] as unknown as string[]).join(
      " "
    );
    expect(recovery).toContain("recovered");
    expect(recovery).toMatch(/\dm/);
  });

  it("says nothing on a success that follows no alert", async () => {
    const health = healthWithClock();

    await health.recordFailure(tokenError());
    await health.recordSuccess();

    expect(logWarningSpy).not.toHaveBeenCalled();
    expect(logErrorSpy).not.toHaveBeenCalled();
  });

  it("starts a fresh streak after a recovery", async () => {
    const health = healthWithClock();

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES; i++) {
      clock += 1000;
      await health.recordFailure(tokenError());
    }
    await health.recordSuccess();
    clock += 1000;
    await health.recordFailure(tokenError());

    expect(logErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a node network error readable", async () => {
    const health = healthWithClock();

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES; i++) {
      clock += 1000;
      await health.recordFailure(new Error("read ECONNRESET"));
    }

    expect(alertTexts()[0]).toContain("read ECONNRESET");
  });
});

describe("attachSyncHealth", () => {
  const fakeClient = (doSync: (token: string) => Promise<unknown>) => ({
    doSync
  });

  it("passes the sync response through untouched", async () => {
    const client = fakeClient(() => Promise.resolve({ next_batch: "s42" }));
    attachSyncHealth(client, healthWithClock());

    await expect(client.doSync("s41")).resolves.toEqual({ next_batch: "s42" });
  });

  it("rethrows a sync failure so the SDK keeps its own backoff", async () => {
    const failure = new Error("read ECONNRESET");
    const client = fakeClient(() => Promise.reject(failure));
    attachSyncHealth(client, healthWithClock());

    await expect(client.doSync("s41")).rejects.toBe(failure);
  });

  it("alerts once the failed syncs pile up", async () => {
    const client = fakeClient(() => Promise.reject(new Error("boom")));
    attachSyncHealth(client, healthWithClock());

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES; i++) {
      clock += 1000;
      await expect(client.doSync("s41")).rejects.toThrow("boom");
    }

    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(alertTexts()[0]).toContain("boom");
  });

  it("reports the recovery when a later sync succeeds", async () => {
    let fail = true;
    const client = fakeClient(() =>
      fail ? Promise.reject(new Error("boom")) : Promise.resolve({})
    );
    attachSyncHealth(client, healthWithClock());

    for (let i = 0; i < SYNC_ALERT_AFTER_FAILURES; i++) {
      clock += 1000;
      await expect(client.doSync("s41")).rejects.toThrow("boom");
    }
    fail = false;
    await client.doSync("s41");

    expect(logWarningSpy).toHaveBeenCalledTimes(1);
  });
});
