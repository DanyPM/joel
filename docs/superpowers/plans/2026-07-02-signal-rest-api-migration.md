# signal-cli-rest-api Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `signal-sdk` with a thin adapter over `bbernhard/signal-cli-rest-api` (HTTP send + WebSocket receive), eliminating the SDK's health-check SIGKILL churn.

**Architecture:** A new `SignalRestClient` adapter exposes the same four methods (`connect`/`on`/`sendMessage`/`disconnect`) the code already calls on `SignalCli`, so call sites only swap the type. It POSTs to `/v2/send` and receives over a WebSocket to `/v1/receive/<number>`. The rest-api runs as a second container (`MODE=json-rpc`) via `docker-compose.signal.yml`.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Node 24 built-in global `WebSocket` + `fetch` (no new deps), vitest, Docker Compose.

## Global Constraints

- ESM with explicit `.ts` extensions in imports (matches existing code).
- No new runtime dependency: use Node's built-in global `WebSocket` and `fetch` (Node 22+; image is `node:24-slim`).
- Signal is enabled only when **both** `SIGNAL_PHONE_NUMBER` and `SIGNAL_API_URL` are set.
- Inbound message shape emitted to consumers: `{ envelope: { sourceNumber: string; dataMessage?: { message?: string } } }` (unchanged from current `ISignalMessage`).
- `tsc -p tsconfig.build.json` must stay clean; full vitest suite must stay green.
- Commit after each task; commits end with the `Co-Authored-By` trailer.

---

### Task 1: `SignalRestClient` adapter + unit tests

**Files:**
- Create: `utils/signalRestClient.ts`
- Create: `tests/46.signalRestClient.test.ts`

**Interfaces:**
- Produces:
  - `export interface SignalEnvelopeMessage { envelope: { sourceNumber: string; dataMessage?: { message?: string } } }`
  - `export function parseSignalFrame(data: unknown): SignalEnvelopeMessage | null`
  - `export interface WebSocketLike { addEventListener(type: string, cb: (ev: any) => void): void; close(): void }`
  - `export class SignalRestClient extends EventEmitter` with
    `constructor(apiUrl: string, phoneNumber: string, wsFactory?: (url: string) => WebSocketLike)`,
    `connect(): Promise<void>`, `sendMessage(recipient: string, message: string): Promise<void>`, `disconnect(): void`.
    Emits `"message"` with a `SignalEnvelopeMessage`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/46.signalRestClient.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSignalFrame,
  SignalRestClient,
  type WebSocketLike
} from "../utils/signalRestClient.ts";

afterEach(() => vi.restoreAllMocks());

describe("parseSignalFrame", () => {
  it("returns the envelope for a data message", () => {
    const frame = JSON.stringify({
      envelope: { sourceNumber: "+33600000000", dataMessage: { message: "hi" } }
    });
    const res = parseSignalFrame(frame);
    expect(res?.envelope.dataMessage?.message).toBe("hi");
  });

  it("ignores frames without a dataMessage (receipts/typing/sync)", () => {
    const frame = JSON.stringify({
      envelope: { sourceNumber: "+33600000000", receiptMessage: {} }
    });
    expect(parseSignalFrame(frame)).toBeNull();
  });

  it("ignores non-string and non-JSON input", () => {
    expect(parseSignalFrame(123)).toBeNull();
    expect(parseSignalFrame("not json")).toBeNull();
  });
});

// Minimal fake WebSocket implementing WebSocketLike + event dispatch.
class FakeWS implements WebSocketLike {
  handlers: Record<string, ((ev: any) => void)[]> = {};
  static last: FakeWS;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  addEventListener(type: string, cb: (ev: any) => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  emit(type: string, ev?: any) {
    (this.handlers[type] ?? []).forEach((h) => h(ev));
  }
  close() {
    this.emit("close");
  }
}

describe("SignalRestClient.connect / message", () => {
  it("opens a ws:// URL derived from an http:// api url and emits messages", async () => {
    const client = new SignalRestClient(
      "http://signal-api:8080",
      "+33111111111",
      (url) => new FakeWS(url)
    );
    const received: unknown[] = [];
    client.on("message", (m) => received.push(m));

    const connected = client.connect();
    FakeWS.last.emit("open");
    await connected;

    expect(FakeWS.last.url).toBe("ws://signal-api:8080/v1/receive/+33111111111");

    FakeWS.last.emit("message", {
      data: JSON.stringify({
        envelope: { sourceNumber: "+33600000000", dataMessage: { message: "yo" } }
      })
    });
    expect(received).toHaveLength(1);

    client.disconnect();
  });
});

describe("SignalRestClient.sendMessage", () => {
  it("POSTs to /v2/send with number, recipients and message", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 201 }));
    const client = new SignalRestClient(
      "http://signal-api:8080",
      "+33111111111",
      () => new FakeWS("x")
    );
    await client.sendMessage("+33600000000", "hello");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://signal-api:8080/v2/send");
    expect(JSON.parse(String(init?.body))).toEqual({
      number: "+33111111111",
      recipients: ["+33600000000"],
      message: "hello"
    });
  });

  it("throws on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad number", { status: 400, statusText: "Bad Request" })
    );
    const client = new SignalRestClient(
      "http://signal-api:8080",
      "+33111111111",
      () => new FakeWS("x")
    );
    await expect(client.sendMessage("+33600000000", "hi")).rejects.toThrow(
      /send failed: 400/
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/46.signalRestClient.test.ts`
Expected: FAIL — module `../utils/signalRestClient.ts` not found.

- [ ] **Step 3: Write the adapter**

```ts
// utils/signalRestClient.ts
import { EventEmitter } from "node:events";

export interface SignalEnvelopeMessage {
  envelope: {
    sourceNumber: string;
    dataMessage?: { message?: string };
  };
}

// Minimal surface of the global WebSocket the adapter relies on. Lets tests
// inject a fake without a real socket.
export interface WebSocketLike {
  addEventListener(type: string, cb: (ev: any) => void): void;
  close(): void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;

// Parse a signal-cli-rest-api receive frame into the envelope shape the bot
// consumes. Returns null for anything that is not an actionable text message
// (receipts, typing, sync, malformed frames).
export function parseSignalFrame(data: unknown): SignalEnvelopeMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const env = (parsed as Partial<SignalEnvelopeMessage>)?.envelope;
  if (env == null || env.dataMessage?.message == null) return null;
  return parsed as SignalEnvelopeMessage;
}

export class SignalRestClient extends EventEmitter {
  private readonly apiUrl: string;
  private readonly wsUrl: string;
  private readonly phoneNumber: string;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private ws: WebSocketLike | null = null;
  private reconnectAttempts = 0;
  private intentionalShutdown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    apiUrl: string,
    phoneNumber: string,
    wsFactory: (url: string) => WebSocketLike = (url) =>
      new WebSocket(url) as unknown as WebSocketLike
  ) {
    super();
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.phoneNumber = phoneNumber;
    this.wsFactory = wsFactory;
    const wsBase = this.apiUrl.replace(/^http/, "ws"); // http->ws, https->wss
    this.wsUrl = `${wsBase}/v1/receive/${phoneNumber}`;
  }

  connect(): Promise<void> {
    this.intentionalShutdown = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Signal rest-api WebSocket connect timed out"));
      }, CONNECT_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      this.openSocket(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private openSocket(onOpen?: () => void): void {
    const ws = this.wsFactory(this.wsUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      onOpen?.();
    });
    ws.addEventListener("message", (ev: { data?: unknown }) => {
      const parsed = parseSignalFrame(ev?.data);
      if (parsed) this.emit("message", parsed);
    });
    ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.intentionalShutdown) this.scheduleReconnect();
    });
    // 'error' is followed by 'close'; reconnection is handled there.
    ws.addEventListener("error", () => undefined);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalShutdown) this.openSocket();
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") {
      this.reconnectTimer.unref();
    }
  }

  async sendMessage(recipient: string, message: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: this.phoneNumber,
        recipients: [recipient],
        message
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `signal-cli-rest-api send failed: ${res.status} ${res.statusText} ${body}`.trim()
      );
    }
  }

  disconnect(): void {
    this.intentionalShutdown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/46.signalRestClient.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add utils/signalRestClient.ts tests/46.signalRestClient.test.ts
git commit -m "feat(signal): SignalRestClient adapter over signal-cli-rest-api"
```

---

### Task 2: Swap the `SignalCli` type across consumers

**Files:**
- Modify: `entities/SignalSession.ts` (import + field/param types)
- Modify: `entities/Session.ts` (import + two `signalCli?` types)
- Modify: `notifications/runNotificationProcess.ts` (import only, if it imports the type)

**Interfaces:**
- Consumes: `SignalRestClient` from Task 1.
- Produces: `sendSignalAppMessage(signalCli: SignalRestClient, ...)` and `SignalSession.signalCli: SignalRestClient`; `ExternalMessageOptions.signalCli?: SignalRestClient`.

- [ ] **Step 1: Update `entities/SignalSession.ts`**

Replace the import on line 11:
```ts
// remove: import { SignalCli } from "signal-sdk";
import { SignalRestClient } from "../utils/signalRestClient.ts";
```
Replace every `SignalCli` type reference in this file with `SignalRestClient`:
- field `signalCli: SignalRestClient;`
- constructor param `signalCli: SignalRestClient,`
- `sendSignalAppMessage(signalCli: SignalRestClient, ...)`

- [ ] **Step 2: Update `entities/Session.ts`**

Replace the import on line 9:
```ts
// remove: import { SignalCli } from "signal-sdk";
import { SignalRestClient } from "../utils/signalRestClient.ts";
```
Change both `signalCli?: SignalCli;` occurrences to `signalCli?: SignalRestClient;`.

- [ ] **Step 3: Update `notifications/runNotificationProcess.ts`**

If it imports `SignalCli` from `signal-sdk`, remove that import (it only reads `messageAppsOptions.signalCli`, whose type now flows from `Session.ts`). Otherwise no change.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors from these files. (`apps/signalApp.ts` and `utils/loadAllMessageApps.ts` still import `signal-sdk` — fixed in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add entities/SignalSession.ts entities/Session.ts notifications/runNotificationProcess.ts
git commit -m "refactor(signal): type consumers on SignalRestClient"
```

---

### Task 3: Wire the adapter into `signalApp.ts` and `loadAllMessageApps.ts`; delete `connectSignal.ts`

**Files:**
- Modify: `apps/signalApp.ts`
- Modify: `utils/loadAllMessageApps.ts`
- Delete: `utils/connectSignal.ts`
- Modify: `vitest.config.ts` (drop the `utils/connectSignal.ts` coverage-exclude line)

**Interfaces:**
- Consumes: `SignalRestClient` from Task 1.

- [ ] **Step 1: Rewrite the top of `apps/signalApp.ts`**

Replace the import block and the binary-resolution block. New header:
```ts
import "dotenv/config";

import { SignalRestClient } from "../utils/signalRestClient.ts";
import { mongodbConnect, mongodbDisconnect } from "../db.ts";
import { SignalSession } from "../entities/SignalSession.ts";
import { startDailyNotificationJobs } from "../notifications/notificationScheduler.ts";
import { logError } from "../utils/debugLogger.ts";
import { handleIncomingMessage } from "../utils/messageWorkflow.ts";

const { SIGNAL_PHONE_NUMBER, SIGNAL_API_URL } = process.env;

if (SIGNAL_PHONE_NUMBER === undefined || SIGNAL_API_URL === undefined) {
  console.log("Signal: env is not set, bot did not start \u{1F6A9}");
  process.exit(0);
}
```
Delete the entire `createRequire`/`path`/`SIGNAL_CLI_PATH`/`binName` block.
Replace the construction line:
```ts
const signalCli = new SignalRestClient(SIGNAL_API_URL, SIGNAL_PHONE_NUMBER);
```
(The `ISignalMessage` interface and the rest of the file stay unchanged; the `on("message", ...)` handler already matches the emitted shape.)

- [ ] **Step 2: Rewrite the Signal block in `utils/loadAllMessageApps.ts`**

Remove the `createRequire`/`path` imports added earlier and the `signal-sdk` import. Add:
```ts
import { SignalRestClient } from "./signalRestClient.ts";
```
Replace the Signal block body:
```ts
  if (messageApps == null || messageApps.some((a) => a === "Signal")) {
    const { SIGNAL_PHONE_NUMBER, SIGNAL_API_URL } = process.env;
    if (SIGNAL_PHONE_NUMBER && SIGNAL_API_URL) {
      const signalCli = new SignalRestClient(SIGNAL_API_URL, SIGNAL_PHONE_NUMBER);
      await signalCli.connect();
      resolved.signalCli = signalCli;
      enabledApps.push("Signal");
    }
  }
```

- [ ] **Step 3: Delete `connectSignal.ts` and its coverage exclude**

```bash
git rm utils/connectSignal.ts
```
In `vitest.config.ts`, remove the line `"utils/connectSignal.ts",` from the coverage `exclude` array.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors. No file imports `signal-sdk` anymore.

- [ ] **Step 5: Commit**

```bash
git add apps/signalApp.ts utils/loadAllMessageApps.ts vitest.config.ts
git commit -m "feat(signal): drive signalApp and loadAllMessageApps via SignalRestClient"
```

---

### Task 4: Update existing Signal tests

**Files:**
- Modify: `tests/19.signalSession.test.ts`
- Modify: `tests/45.loadAllMessageApps.test.ts`

**Interfaces:**
- Consumes: `SignalRestClient` type (as a mock shape with `sendMessage`, `connect`, `on`).

- [ ] **Step 1: Update `tests/19.signalSession.test.ts`**

Replace the type import on line 29:
```ts
// remove: import type { SignalCli } from "signal-sdk";
import type { SignalRestClient } from "../utils/signalRestClient.ts";
```
Update the `makeSignalCli` cast:
```ts
const makeSignalCli = () => {
  const sendMessage = vi.fn(() => Promise.resolve());
  return {
    cli: { sendMessage } as unknown as SignalRestClient,
    sendMessage
  };
};
```

- [ ] **Step 2: Update `tests/45.loadAllMessageApps.test.ts`**

Replace the `signal-sdk` mock with a `signalRestClient.ts` mock. Change the mock (was `vi.doMock("signal-sdk", ...)`):
```ts
  vi.doMock("../utils/signalRestClient.ts", () => ({
    SignalRestClient: SignalCliMock
  }));
```
Add `SIGNAL_API_URL` to `ENV_KEYS`. In the "enables Signal" test, set both env vars and assert construction args:
```ts
    process.env.SIGNAL_PHONE_NUMBER = "+33600000000";
    process.env.SIGNAL_API_URL = "http://signal-api:8080";
    // ...
    expect(SignalCliMock).toHaveBeenCalledWith(
      "http://signal-api:8080",
      "+33600000000"
    );
```
Update the "skips Signal when the phone number is unset" test to also cover the missing-API-URL case, and add one asserting Signal is skipped when the phone is set but `SIGNAL_API_URL` is not:
```ts
  it("skips Signal when SIGNAL_API_URL is unset", async () => {
    process.env.SIGNAL_PHONE_NUMBER = "+33600000000";
    const loadAllMessageApps = await loadModule(true);
    const { messageApps } = await loadAllMessageApps(["Signal"]);
    expect(messageApps).toEqual([]);
    expect(SignalCliMock).not.toHaveBeenCalled();
  });
```
In the "enables all configured apps" test, set `SIGNAL_API_URL` too so Signal is included.

- [ ] **Step 3: Run the updated tests**

Run: `npx vitest run tests/19.signalSession.test.ts tests/45.loadAllMessageApps.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/19.signalSession.test.ts tests/45.loadAllMessageApps.test.ts
git commit -m "test(signal): update Signal tests for SignalRestClient"
```

---

### Task 5: Docker + deps + env; remove signal-sdk; full green

**Files:**
- Create: `docker-compose.signal.yml`
- Modify: `Dockerfile.signal`
- Modify: `package.json` (remove `signal-sdk`)
- Modify: `package-lock.json` (via `npm install`)
- Modify: `.env.template`

- [ ] **Step 1: Create `docker-compose.signal.yml`**

```yaml
# JOEL Signal deployment: the bot plus the signal-cli daemon (REST + WebSocket).
# Used both locally and as the Coolify deploy unit.
services:
  signal-api:
    image: bbernhard/signal-cli-rest-api:latest
    environment:
      - MODE=json-rpc # persistent daemon; enables the WebSocket receive endpoint
    ports:
      - "8080:8080" # only needed for linking via the browser QR endpoint
    volumes:
      # linked-device identity keys; must persist across redeploys
      - signal-data:/home/.local/share/signal-cli
    restart: unless-stopped

  joel-signal:
    build:
      context: .
      dockerfile: Dockerfile.signal
    environment:
      - SIGNAL_API_URL=http://signal-api:8080
    env_file:
      - .env
    depends_on:
      - signal-api
    restart: unless-stopped

volumes:
  signal-data:
```

- [ ] **Step 2: Simplify `Dockerfile.signal`**

Replace the persistence comment block (the `signal-cli persists ...` lines and the `Coolify -> Storages` note) with a one-line note that persistence now lives on the `signal-api` service. The build stages are otherwise unchanged. New tail of the production stage:
```dockerfile
ENV NODE_ENV=production

# The signal-cli daemon and its persistent linked-device keys live in the
# companion signal-cli-rest-api service (see docker-compose.signal.yml), not
# here. This image is just the Node bot.

CMD ["npm", "run", "start-si:prod"]
```
Also update the top-of-file comment to say the image is the bot only and no longer bundles signal-cli.

- [ ] **Step 3: Remove `signal-sdk` and resync the lockfile**

```bash
npm remove signal-sdk
```
(That updates `package.json` and `package-lock.json`. If the safe-chain wrapper interferes, run `npm install` to resync the lock.)

- [ ] **Step 4: Update `.env.template`**

Remove the `JAVA_TOOL_OPTIONS` line and its two comment lines. Set the Signal section to:
```
SIGNAL_PHONE_NUMBER=""
SIGNAL_DEVICE_NAME=""
# URL of the signal-cli-rest-api service (docker-compose: http://signal-api:8080)
SIGNAL_API_URL="http://localhost:8080"
# Link the device once by opening in a browser and scanning with the Signal app:
#   http://localhost:8080/v1/qrcodelink?device_name=JOEL
```

- [ ] **Step 5: Full typecheck + suite**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: clean.
Run: `npx vitest run`
Expected: all files pass (including tasks 1 and 4 changes). Confirm no test imports `signal-sdk`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.signal.yml Dockerfile.signal package.json package-lock.json .env.template
git commit -m "build(signal): compose with signal-cli-rest-api, drop signal-sdk"
```

---

## Self-Review

**Spec coverage:**
- Adapter with 4 methods → Task 1. ✅
- Type swap across SignalSession/Session/runNotificationProcess → Task 2. ✅
- signalApp + loadAllMessageApps wiring, delete connectSignal → Task 3. ✅
- docker-compose, Dockerfile.signal, package.json, .env.template → Task 5. ✅
- Test updates + new adapter tests → Tasks 1 & 4. ✅
- Env gating on both vars → Tasks 3 & 4. ✅
- Remove signal-sdk → Task 5. ✅

**Placeholder scan:** No TBD/TODO; all steps carry concrete code or exact edits.

**Type consistency:** `SignalRestClient(apiUrl, phoneNumber)`, `sendMessage(recipient, message)`, `connect()`, `disconnect()`, `parseSignalFrame`, `SignalEnvelopeMessage`, `WebSocketLike` used identically across tasks.
