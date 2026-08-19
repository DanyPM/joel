import { ILogger, LogLevel, LogService } from "matrix-bot-sdk";

/** Longest payload text kept on a single log line. */
export const MAX_PAYLOAD_CHARS = 2000;

/** A failure repeating within this window is counted, not reprinted. */
export const REPEAT_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

/** Number of (REQ-id → method + path) pairs kept for error correlation. */
const REQUEST_TRAIL_SIZE = 200;

/** The SDK logs its own messages as strings; anything else is a payload. */
const asText = (value: unknown): string =>
  typeof value === "string" ? value : "";

const REQUEST_ID_PATTERN = /^\(REQ-(\d+)\)$/;
const REQUEST_START_PATTERN = /^(GET|POST|PUT|DELETE) (\S+)$/;
const HTML_PATTERN = /^\s*<(!doctype|html)/i;
const HTML_TITLE_PATTERN = /<title[^>]*>([^<]*)<\/title>/i;

const truncate = (text: string): string =>
  text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}… (truncated)`
    : text;

const describeHtml = (html: string): string => {
  const title = HTML_TITLE_PATTERN.exec(html)?.[1].trim();
  const bytes = Buffer.byteLength(html);
  return `HTML body (${String(bytes)} bytes)${title != null && title.length > 0 ? `: ${title}` : ""}`;
};

const hasKey = <K extends string>(
  value: object,
  key: K
): value is Record<K, unknown> => key in value;

/**
 * Renders anything the SDK hands to its logger as a short, greppable string.
 * The SDK logs whole response bodies and throws raw HTTP responses, so without
 * this a single homeserver 502 puts a multi-kB HTML page on stdout.
 */
export const describeMatrixPayload = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string")
    return HTML_PATTERN.test(value) ? describeHtml(value) : truncate(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[function ${value.name}]`;

  if (hasKey(value, "errcode")) {
    const errcode = String(value.errcode);
    const detail = hasKey(value, "error") ? String(value.error) : undefined;
    return detail != null ? `${errcode}: ${detail}` : errcode;
  }

  if (hasKey(value, "statusCode")) {
    const status = String(value.statusCode);
    const body = hasKey(value, "body")
      ? describeMatrixPayload(value.body)
      : undefined;
    return body != null ? `HTTP ${status} ${body}` : `HTTP ${status}`;
  }

  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(Object.prototype.toString.call(value));
  }
};

interface MatrixLoggerOptions {
  now?: () => number;
}

interface RepeatState {
  count: number;
  lastPrintedAt: number;
}

const formatDurationShort = (ms: number): string => {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${String(minutes)}m${String(seconds)}s`
    : `${String(seconds)}s`;
};

/**
 * Builds the logger the matrix-bot-sdk writes through, for one bot app.
 *
 * The SDK's default logger prints raw bodies, gives no way to tell a Matrix
 * line from a Tchap one, and concatenates error objects into the useless
 * "Error handling sync [object Object]". This logger summarizes payloads, tags
 * each line with the app, correlates errors with the request that caused them,
 * and collapses a repeating failure into one line per
 * {@link REPEAT_SUMMARY_INTERVAL_MS}.
 */
export const createMatrixLogger = (
  appLabel: string,
  options: MatrixLoggerOptions = {}
): ILogger => {
  const now = options.now ?? (() => Date.now());
  const requestTrail = new Map<string, string>();
  const repeats = new Map<string, RepeatState>();

  const rememberRequest = (messageOrObject: unknown[]): void => {
    const requestId = REQUEST_ID_PATTERN.exec(asText(messageOrObject[0]))?.[1];
    const start = REQUEST_START_PATTERN.exec(asText(messageOrObject[1]));
    if (requestId == null || start == null) return;

    let path = start[2];
    try {
      path = new URL(start[2]).pathname;
    } catch {
      // Not an absolute URL: keep whatever the SDK logged.
    }
    if (requestTrail.size >= REQUEST_TRAIL_SIZE) {
      const oldest = requestTrail.keys().next();
      if (!oldest.done) requestTrail.delete(oldest.value);
    }
    requestTrail.set(requestId, `${start[1]} ${path}`);
  };

  const describeRequest = (messageOrObject: unknown[]): string | undefined => {
    const requestId = REQUEST_ID_PATTERN.exec(asText(messageOrObject[0]))?.[1];
    return requestId != null ? requestTrail.get(requestId) : undefined;
  };

  const buildLine = (module: string, messageOrObject: unknown[]): string =>
    [
      `[${appLabel}]`,
      module,
      describeRequest(messageOrObject),
      ...messageOrObject.map(describeMatrixPayload)
    ]
      .filter((part): part is string => part != null)
      .join(" ");

  return {
    // Request-start lines exist only to correlate later errors: they are kept
    // in memory, never printed.
    trace: (module: string, ...messageOrObject: unknown[]) => {
      if (module === "MatrixHttpClient") rememberRequest(messageOrObject);
    },
    debug: (module: string, ...messageOrObject: unknown[]) => {
      if (module === "MatrixHttpClient") rememberRequest(messageOrObject);
    },
    info: (module: string, ...messageOrObject: unknown[]) => {
      const text = asText(messageOrObject[0]);
      // One line per sync retry, forever. The outage itself is reported by the
      // sync health tracker instead.
      if (module === "MatrixClientLite" && text.startsWith("Backing off for"))
        return;
      console.log(buildLine(module, messageOrObject));
    },
    warn: (module: string, ...messageOrObject: unknown[]) => {
      console.warn(buildLine(module, messageOrObject));
    },
    error: (module: string, ...messageOrObject: unknown[]) => {
      const text = asText(messageOrObject[0]);
      // The SDK concatenates the error object into this message, so it reads
      // "[object Object]" or repeats a whole HTML page. The MatrixHttpClient
      // line just above carries the same failure with its errcode.
      if (
        module === "MatrixClientLite" &&
        text.startsWith("Error handling sync")
      )
        return;

      const line = buildLine(module, messageOrObject);
      const signature = `${module} ${messageOrObject.slice(1).map(describeMatrixPayload).join(" ")}`;
      const at = now();
      const seen = repeats.get(signature);

      if (seen == null) {
        repeats.set(signature, { count: 1, lastPrintedAt: at });
        console.error(line);
        return;
      }

      seen.count += 1;
      if (at - seen.lastPrintedAt < REPEAT_SUMMARY_INTERVAL_MS) return;

      console.error(
        `${line} (${String(seen.count)} times in ${formatDurationShort(at - seen.lastPrintedAt)})`
      );
      seen.count = 0;
      seen.lastPrintedAt = at;
    }
  };
};

/**
 * Points the matrix-bot-sdk at {@link createMatrixLogger}. DEBUG is enabled so
 * the logger sees request-start lines and can name the endpoint behind a failed
 * request; those lines are swallowed rather than printed.
 */
export const configureMatrixLogging = (appLabel: string): void => {
  LogService.setLogger(createMatrixLogger(appLabel));
  LogService.setLevel(LogLevel.DEBUG);
};
