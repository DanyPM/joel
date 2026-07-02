import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";

// Shared spy for the internal jorfAxios instance's `.get`.
const { getSpy } = vi.hoisted(() => ({ getSpy: vi.fn() }));

// Mock axios so `axios.create()` returns an object whose `.get` we control.
// Keep the real `isAxiosError` so shouldRetry keeps working.
vi.mock("axios", async (importActual) => {
  const actual = await importActual<typeof import("axios")>();
  return {
    ...actual,
    default: {
      ...(actual.default as object),
      create: () => ({ get: getSpy })
    },
    isAxiosError: actual.isAxiosError
  };
});

const { umamiLogSpy, umamiLogAsyncSpy } = vi.hoisted(() => ({
  umamiLogSpy: vi.fn(),
  umamiLogAsyncSpy: vi.fn(() => Promise.resolve())
}));
vi.mock("../utils/umami.ts", () => ({
  default: { log: umamiLogSpy, logAsync: umamiLogAsyncSpy }
}));
vi.mock("../utils/debugLogger.ts", () => ({
  logError: vi.fn(() => Promise.resolve())
}));

import {
  getJORFRecordsFromDate,
  getJORFMetaRecordsFromDate
} from "../utils/JORFSearch.utils.ts";

// Build a valid raw JORFSearch "people" record for a given source_date (YMD).
function rawItem(source_date: string) {
  return {
    nom: "Dupont",
    prenom: "Jean",
    source_id: "JORFTEXT" + source_date.replace(/-/g, ""),
    source_date,
    source_name: "JORF",
    type_ordre: "nomination",
    organisations: [{ nom: "Conseil", wikidata_id: "Q123" }]
  };
}

// Build a valid raw meta publication for a given date (YMD).
function rawMeta(date: string) {
  return {
    id: "JORFTEXT" + date.replace(/-/g, ""),
    date,
    title: "Titre de test",
    tags: { mesure_nominative: true }
  };
}

function ymdMinusOneDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map((s) => parseInt(s));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  const yy = String(dt.getFullYear());
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

beforeEach(async () => {
  if (!mongoose.connection.db) throw new Error("no db");
  await mongoose.connection.db.dropDatabase();
  vi.clearAllMocks();
});

describe("getJORFRecordsFromDate", () => {
  it("aggregates records across a multi-day range (chunked loop runs >1 chunk)", async () => {
    // Return, per requested day, a single record whose source_date matches that day.
    getSpy.mockImplementation((url: string) => {
      const m = /(\d{2})-(\d{2})-(\d{4})/.exec(url); // DMY in the day URL
      const ymd = m ? `${m[3]}-${m[2]}-${m[1]}` : "2024-01-01";
      return Promise.resolve({ data: [rawItem(ymd)], request: {} });
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 2); // 3-day range => 3 chunks of size 1

    const results = await getJORFRecordsFromDate(startDate, [
      "Telegram",
      "Signal"
    ]);

    // One record per day -> 3 total, sorted ascending by source_date.
    expect(results).toHaveLength(3);
    expect(getSpy).toHaveBeenCalledTimes(3);
    for (let i = 1; i < results.length; i++) {
      expect(
        new Date(results[i].source_date).getTime()
      ).toBeGreaterThanOrEqual(new Date(results[i - 1].source_date).getTime());
    }
    // Aggregated stats logged once per app.
    const dateEvents = umamiLogSpy.mock.calls.filter(
      (c) => c[0]?.event === "/jorfsearch-request-date"
    );
    expect(dateEvents).toHaveLength(2);
    expect(dateEvents[0][0].payload.day_nb).toBe(3);
  });

  it("tolerates a day returning a null/string payload", async () => {
    getSpy.mockResolvedValue({ data: "error string", request: {} });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const results = await getJORFRecordsFromDate(new Date(today), ["Telegram"]);

    expect(results).toEqual([]);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getJORFMetaRecordsFromDate", () => {
  it("aggregates meta publications across a multi-day range and persists them", async () => {
    getSpy.mockImplementation((url: string) => {
      // meta URL: .../meta/search?date=YYYY-MM-DD
      const m = /date=(\d{4}-\d{2}-\d{2})/.exec(url);
      const queryDate = m ? m[1] : "2024-01-02";
      // callJORFSearchMetaDay filters by (queryDate - 1 day)
      const prev = ymdMinusOneDay(queryDate);
      return Promise.resolve({ data: [rawMeta(prev)], request: {} });
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 2); // 3 chunks of size 1

    const results = await getJORFMetaRecordsFromDate(startDate, ["Telegram"]);

    expect(results).toHaveLength(3);
    expect(getSpy).toHaveBeenCalledTimes(3);
    // sorted ascending by date
    for (let i = 1; i < results.length; i++) {
      expect(new Date(results[i].date).getTime()).toBeGreaterThanOrEqual(
        new Date(results[i - 1].date).getTime()
      );
    }
    const metaEvents = umamiLogSpy.mock.calls.filter(
      (c) => c[0]?.event === "/jorfsearch-request-meta"
    );
    expect(metaEvents).toHaveLength(1);
    expect(metaEvents[0][0].payload.day_nb).toBe(3);
    // Persisted to the in-memory DB (saveMetaPublications upserts).
    expect(umamiLogAsyncSpy).toHaveBeenCalled();
  });

  it("throws when a day returns a null/string payload", async () => {
    getSpy.mockResolvedValue({ data: "error string", request: {} });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await expect(
      getJORFMetaRecordsFromDate(new Date(today), ["Telegram"])
    ).rejects.toThrow("JORFSearch returned a null value");
  });
});
