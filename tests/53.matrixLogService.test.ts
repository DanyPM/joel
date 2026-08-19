import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  configureMatrixLogging,
  createMatrixLogger,
  describeMatrixPayload,
  MAX_PAYLOAD_CHARS,
  REPEAT_SUMMARY_INTERVAL_MS
} from "../utils/matrixLogService.ts";

const HTML_502 = [
  "<!DOCTYPE html>",
  '<html lang="fr"><head>',
  "  <title>502</title>",
  "  <style>body { font-family: 'Inter', sans-serif; }</style>",
  "</head>",
  "<body>",
  '  <div class="error-code">Erreur 502</div>',
  '  <div class="error-title">Bad Gateway</div>',
  "</body></html>"
].join("\n");

const errors: string[] = [];
const infos: string[] = [];
const warnings: string[] = [];

const errorLines = () => errors;
const infoLines = () => infos;

const capture =
  (into: string[]) =>
  (...args: unknown[]) => {
    into.push(args.map((arg) => String(arg)).join(" "));
  };

beforeEach(() => {
  errors.length = 0;
  infos.length = 0;
  warnings.length = 0;
  vi.spyOn(console, "error").mockImplementation(capture(errors));
  vi.spyOn(console, "log").mockImplementation(capture(infos));
  vi.spyOn(console, "warn").mockImplementation(capture(warnings));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeMatrixPayload", () => {
  it("summarizes an HTML error page instead of printing it", () => {
    const summary = describeMatrixPayload(HTML_502);

    expect(summary).toContain("HTML body");
    expect(summary).toContain("502");
    expect(summary).not.toContain("<style>");
    expect(summary.length).toBeLessThan(200);
  });

  it("names the errcode and message of a Matrix error body", () => {
    const summary = describeMatrixPayload({
      errcode: "M_UNKNOWN",
      error: "Unable to introspect the access token"
    });

    expect(summary).toBe("M_UNKNOWN: Unable to introspect the access token");
  });

  it("reports the status code of a thrown HTTP response and summarizes its body", () => {
    const summary = describeMatrixPayload({
      statusCode: 502,
      body: HTML_502
    });

    expect(summary).toContain("HTTP 502");
    expect(summary).toContain("HTML body");
    expect(summary).not.toContain("<style>");
  });

  it("never yields [object Object] for a plain object", () => {
    const summary = describeMatrixPayload({ next_batch: "s123", rooms: {} });

    expect(summary).not.toContain("[object Object]");
    expect(summary).toContain("next_batch");
  });

  it("truncates payloads longer than the cap", () => {
    const summary = describeMatrixPayload("x".repeat(MAX_PAYLOAD_CHARS * 3));

    expect(summary.length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS + 20);
    expect(summary).toContain("truncated");
  });

  it("keeps an Error readable", () => {
    const summary = describeMatrixPayload(new Error("read ECONNRESET"));

    expect(summary).toContain("read ECONNRESET");
  });
});

describe("createMatrixLogger", () => {
  it("tags every line with the app label", () => {
    const logger = createMatrixLogger("Tchap");

    logger.error("MatrixHttpClient", "(REQ-7)", {
      errcode: "M_NOT_FOUND",
      error: "Event not found."
    });

    expect(errorLines()[0]).toContain("[Tchap]");
    expect(errorLines()[0]).toContain("M_NOT_FOUND: Event not found.");
  });

  it("attaches the method and path of the request that failed", () => {
    const logger = createMatrixLogger("Matrix");

    logger.debug(
      "MatrixHttpClient",
      "(REQ-4)",
      "GET https://matrix.example.org/_matrix/client/v3/rooms/!a:b/event/$c"
    );
    logger.error("MatrixHttpClient", "(REQ-4)", {
      errcode: "M_NOT_FOUND",
      error: "Event not found."
    });

    const line = errorLines()[0];
    expect(line).toContain("GET /_matrix/client/v3/rooms/!a:b/event/$c");
    expect(line).toContain("M_NOT_FOUND");
  });

  it("does not print request-start debug lines", () => {
    const logger = createMatrixLogger("Matrix");

    logger.debug("MatrixHttpClient", "(REQ-9)", "GET https://home/_matrix/x");

    expect(infoLines()).toHaveLength(0);
  });

  it("drops the sync backoff chatter", () => {
    const logger = createMatrixLogger("Matrix");

    logger.info("MatrixClientLite", "Backing off for 6616.42ms");

    expect(infoLines()).toHaveLength(0);
  });

  it("drops the sync error line, which carries no usable detail", () => {
    const logger = createMatrixLogger("Matrix");

    logger.error("MatrixClientLite", "Error handling sync [object Object]");

    expect(errorLines()).toHaveLength(0);
  });

  it("keeps other MatrixClientLite lines", () => {
    const logger = createMatrixLogger("Matrix");

    logger.info("MatrixClientLite", "End-to-end encryption enabled");

    expect(infoLines()[0]).toContain("End-to-end encryption enabled");
  });

  it("prints a repeated failure once, then one summary per interval", () => {
    let clock = 0;
    const logger = createMatrixLogger("Tchap", { now: () => clock });
    const fail = () => {
      logger.error("MatrixHttpClient", "(REQ-1)", {
        errcode: "M_UNKNOWN",
        error: "Unable to introspect the access token"
      });
    };

    const repeats = REPEAT_SUMMARY_INTERVAL_MS / 10_000;
    fail();
    for (let i = 0; i < repeats; i++) {
      clock += 10_000;
      fail();
    }

    const lines = errorLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Unable to introspect the access token");
    expect(lines[1]).toContain(`${String(repeats + 1)} times`);
    expect(lines[1]).toContain("Unable to introspect the access token");
  });

  it("prints a different failure immediately", () => {
    const logger = createMatrixLogger("Tchap", { now: () => 0 });

    logger.error("MatrixHttpClient", "(REQ-1)", { errcode: "M_UNKNOWN" });
    logger.error("MatrixHttpClient", "(REQ-2)", { errcode: "M_FORBIDDEN" });

    expect(errorLines()).toHaveLength(2);
  });

  it("routes warnings to console.warn", () => {
    const logger = createMatrixLogger("Matrix");

    logger.warn("CryptoClient", "Unknown device");

    expect(warnings).toHaveLength(1);
  });
});

describe("configureMatrixLogging", () => {
  it("enables the debug level so request paths can be correlated", async () => {
    const { LogService, LogLevel } = await import("matrix-bot-sdk");

    configureMatrixLogging("Matrix");

    expect(LogService.level.includes(LogLevel.DEBUG)).toBe(true);
  });
});
