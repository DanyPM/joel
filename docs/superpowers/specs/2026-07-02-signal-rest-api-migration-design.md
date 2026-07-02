# Signal: migrate from signal-sdk to signal-cli-rest-api

**Date:** 2026-07-02
**Status:** Approved (design)

## Problem

The Signal bot uses `signal-sdk` (`SignalCli`), which spawns `signal-cli` as a
json-rpc daemon and runs its own health check. The health check calls
`getVersion()` every 30s and, on a `CONNECTION_ERROR`, **SIGKILLs the daemon**
and reconnects. In practice the json-rpc transport breaks ~90s after start and
then churns every 30s on both Windows and Linux. During each kill/reconnect,
inbound message events and in-flight sends are lost, so the bot never replies
reliably. Device linking additionally panics in libsignal on Windows
(`username must be of the form {ACI}.{deviceId}`, deviceId=0).

Root cause is `signal-sdk@0.2.4` + `signal-cli 0.14.x` daemon instability — not
application code.

## Goal

Replace `signal-sdk` with [`bbernhard/signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api),
a battle-tested container that owns the `signal-cli` daemon lifecycle and exposes
HTTP + WebSocket. The bot talks to it over the network. No more SDK health-check
SIGKILL loop; linking is done by the rest-api (browser QR), sidestepping the
Windows libsignal panic.

## Architecture

Two containers wired by a new `docker-compose.signal.yml`, used both for local
dev and as the Coolify deploy unit:

```
services:
  signal-api:                      # bbernhard/signal-cli-rest-api
    MODE=json-rpc                   # persistent daemon + WebSocket receive
    volume: signal-data:/home/.local/share/signal-cli   # linked-device keys
  joel-signal:                     # the bot (Dockerfile.signal)
    SIGNAL_API_URL=http://signal-api:8080
    depends_on: signal-api
```

- **MODE=json-rpc** is required for the WebSocket receive endpoint.
- The bot image no longer needs `signal-sdk`, `signal-cli`, or Java.
- Persistence lives on the `signal-api` container's volume (not the bot).

## New component: `utils/signalRestClient.ts`

A drop-in adapter exposing the **same four methods** the codebase already calls
on the old `SignalCli`, so call sites barely change:

| Method | Implementation |
|---|---|
| `connect()` | Open a WebSocket to `<SIGNAL_API_URL with http→ws / https→wss>/v1/receive/<number>` using Node's built-in global `WebSocket` (Node 22+, present in the `node:24-slim` image — no `ws` dependency). Auto-reconnect on close with capped exponential backoff. |
| `on("message", cb)` | Parse each WS JSON frame and emit the **same shape** `signalApp` already consumes: `{ envelope: { sourceNumber, dataMessage?: { message? } } }`. |
| `sendMessage(to, text)` | `POST /v2/send` with `{ number: <bot>, recipients: [to], message: text }`. Throw on non-2xx so the existing retry path handles it. |
| `disconnect()` | Close the WS and stop the reconnect loop (mark intentional shutdown). |

Constructor: `new SignalRestClient(apiUrl: string, phoneNumber: string)`.

The adapter is a small `EventEmitter` subclass (or minimal listener registry) so
`.on("message", ...)` works exactly as before.

### Message frame shape

signal-cli-rest-api's json-rpc WebSocket streams signal-cli envelope JSON. The
adapter maps it to the existing `ISignalMessage` interface in `signalApp.ts`
(`envelope.sourceNumber`, `envelope.dataMessage.message`). Frames without a
`dataMessage` (receipts, typing, sync) are ignored, matching current behavior.

## Data flow

- **Inbound:** phone → `signal-api` daemon → WS frame → adapter emits `message`
  → `handleIncomingMessage` (unchanged).
- **Outbound:** `SignalSession.sendMessage` → `sendSignalAppMessage` (unchanged
  chunking + 3-retry capped backoff) → adapter `sendMessage` → `POST /v2/send`.

## Files changed

**New**
- `utils/signalRestClient.ts` — the adapter.
- `docker-compose.signal.yml` — `signal-api` + `joel-signal` services.
- `docs/superpowers/specs/2026-07-02-signal-rest-api-migration-design.md` — this doc.

**Type swap `SignalCli` → `SignalRestClient`**
- `entities/SignalSession.ts` (field type, `sendSignalAppMessage` param type).
- `entities/Session.ts` (`ExternalMessageOptions.signalCli`, dispatch param).
- `notifications/runNotificationProcess.ts` (option type check).
- `utils/loadAllMessageApps.ts` (construct adapter instead of `SignalCli`).

**Modified**
- `apps/signalApp.ts` — construct `new SignalRestClient(SIGNAL_API_URL, phone)`;
  remove the `createRequire`/`path`/`SIGNAL_CLI_PATH` binary-resolution block.
- `Dockerfile.signal` — drop all signal-cli/Java concerns; build + run the node
  bot only. (Still installs `libvips-dev` for `sharp`.)
- `package.json` — remove `signal-sdk` dependency. `start-si` scripts stay.
- `.env.template` — remove `SIGNAL_CLI_PATH` and `JAVA_TOOL_OPTIONS`; add
  `SIGNAL_API_URL`. Document linking via `GET /v1/qrcodelink?device_name=JOEL`.

**Deleted**
- `utils/connectSignal.ts` — linking now uses the rest-api browser QR endpoint.

**Tests**
- `tests/45.loadAllMessageApps.test.ts` — replace the `signal-sdk`/`SignalCli`
  mock with a `SignalRestClient` mock (same `connect`/`on` surface); assert the
  adapter is constructed with `(SIGNAL_API_URL, phone)` and `connect()` is called.
  Signal now gates on `SIGNAL_PHONE_NUMBER` **and** `SIGNAL_API_URL`.
- `tests/19.signalSession.test.ts` — the send mock keeps a `sendMessage` method,
  so changes are minimal (drop the `signal-sdk` import, use a plain mock object).
- New unit coverage for `signalRestClient.ts`: `sendMessage` (mock `fetch`,
  assert POST body + throw on non-2xx) and frame parsing (feed a fake WS frame,
  assert the emitted envelope shape; non-dataMessage frames ignored).

## Environment variables

- **Add:** `SIGNAL_API_URL` (e.g. `http://signal-api:8080` in compose,
  `http://localhost:8080` locally). Signal is enabled only when both
  `SIGNAL_PHONE_NUMBER` and `SIGNAL_API_URL` are set.
- **Remove:** `SIGNAL_CLI_PATH`, `JAVA_TOOL_OPTIONS` (no local signal-cli/JVM).
- **Keep:** `SIGNAL_PHONE_NUMBER`, `SIGNAL_DEVICE_NAME` (device label for linking).

## Error handling

- **WS drop:** adapter reconnects with capped exponential backoff; logs via
  `logError`. `disconnect()` sets an intentional-shutdown flag so a deliberate
  close does not trigger reconnect.
- **Send failure (non-2xx / network):** adapter throws; `sendSignalAppMessage`'s
  existing 3-retry capped backoff (resume-from-failed-chunk) handles it.
- No health-check SIGKILL loop — the rest-api owns the daemon.

## Linking (operations)

1. Bring up `signal-api` (compose or Coolify).
2. Open `http://<host>:8080/v1/qrcodelink?device_name=JOEL` in a browser.
3. Signal app → Settings → Linked devices → Link new device → scan.
4. Keys persist on the `signal-data` volume; the bot connects on next start.

## Success criteria

- Bot connects to `signal-api` over WS and stays connected (no 30s churn).
- Inbound message from another Signal account triggers a reply.
- Outbound notification delivered via `POST /v2/send`.
- `signal-sdk` removed from `package.json`; `tsc -p tsconfig.build.json` clean.
- Full vitest suite green, including updated Signal tests + new adapter tests.

## Out of scope

- Attachments/media send (current bot sends text only).
- Group messaging.
- Migrating other message apps (Telegram/WhatsApp/Matrix) — untouched.
