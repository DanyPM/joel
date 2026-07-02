import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MessageApp } from "../types.ts";

// --- Shared SDK / dependency mocks ------------------------------------------
// NB: constructor mocks must use non-arrow functions so `new X()` works.
const matrixStart = vi.fn(() => Promise.resolve());
const MatrixClientMock = vi.fn(function () {
  return { start: matrixStart };
});
const SimpleFsStorageProviderMock = vi.fn();
const RustSdkCryptoStorageProviderMock = vi.fn();

const signalConnect = vi.fn(() => Promise.resolve());
const SignalCliMock = vi.fn(function () {
  return { connect: signalConnect };
});

const WhatsAppAPIMock = vi.fn(function () {
  return { on: {} as Record<string, unknown> };
});

const logErrorMock = vi.fn(() => Promise.resolve());

// Load loadAllMessageApps with a fresh module graph and controllable
// MATRIX_ENCRYPTION_ENABLED value, mocking every heavy side-effectful dep.
async function loadModule(encryptionEnabled: boolean) {
  vi.resetModules();
  vi.doMock("../apps/matrixApp.ts", () => ({
    MATRIX_ENCRYPTION_ENABLED: encryptionEnabled
  }));
  vi.doMock("matrix-bot-sdk", () => ({
    MatrixClient: MatrixClientMock,
    SimpleFsStorageProvider: SimpleFsStorageProviderMock,
    RustSdkCryptoStorageProvider: RustSdkCryptoStorageProviderMock
  }));
  vi.doMock("signal-sdk", () => ({ SignalCli: SignalCliMock }));
  vi.doMock("whatsapp-api-js/middleware/express", () => ({
    WhatsAppAPI: WhatsAppAPIMock
  }));
  vi.doMock("@matrix-org/matrix-sdk-crypto-nodejs", () => ({
    StoreType: { Sqlite: "Sqlite" }
  }));
  vi.doMock("../entities/WhatsAppSession.ts", () => ({
    WHATSAPP_API_VERSION: "v24.0"
  }));
  vi.doMock("../utils/debugLogger.ts", () => ({ logError: logErrorMock }));

  const mod = await import("../utils/loadAllMessageApps.ts");
  return mod.loadAllMessageApps;
}

const ENV_KEYS = [
  "WHATSAPP_USER_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "SIGNAL_BAT_PATH",
  "SIGNAL_PHONE_NUMBER",
  "TELEGRAM_BOT_TOKEN",
  "MATRIX_HOME_URL",
  "MATRIX_BOT_TOKEN"
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  matrixStart.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("loadAllMessageApps — WhatsApp", () => {
  it("enables WhatsApp when all env vars are set", async () => {
    process.env.WHATSAPP_USER_TOKEN = "tok";
    process.env.WHATSAPP_APP_SECRET = "sec";
    process.env.WHATSAPP_VERIFY_TOKEN = "vfy";

    const loadAllMessageApps = await loadModule(true);
    const { messageApps, messageAppOptions } = await loadAllMessageApps([
      "WhatsApp"
    ]);

    expect(messageApps).toEqual(["WhatsApp"]);
    expect(WhatsAppAPIMock).toHaveBeenCalledTimes(1);
    expect(messageAppOptions.whatsAppAPI).toBeDefined();
    // the `sent` handler is registered
    const sent = (
      messageAppOptions.whatsAppAPI as unknown as {
        on: { sent?: (arg: { phoneID: string; to: string }) => void };
      }
    ).on.sent;
    expect(sent).toBeTypeOf("function");
    // invoke it (no-op body) so the callback is covered
    expect(() => sent?.({ phoneID: "p1", to: "u1" })).not.toThrow();
  });

  it("throws when WhatsApp env vars are partially set", async () => {
    process.env.WHATSAPP_USER_TOKEN = "tok"; // others missing

    const loadAllMessageApps = await loadModule(true);
    await expect(loadAllMessageApps(["WhatsApp"])).rejects.toThrow(
      "WhatsApp env vars partially set"
    );
  });
});

describe("loadAllMessageApps — Signal", () => {
  it("enables Signal and connects when all env vars are set", async () => {
    process.env.SIGNAL_BAT_PATH = "/bin/signal";
    process.env.SIGNAL_PHONE_NUMBER = "+33600000000";

    const loadAllMessageApps = await loadModule(true);
    const { messageApps, messageAppOptions } = await loadAllMessageApps([
      "Signal"
    ]);

    expect(messageApps).toEqual(["Signal"]);
    expect(SignalCliMock).toHaveBeenCalledWith("/bin/signal", "+33600000000");
    expect(signalConnect).toHaveBeenCalledTimes(1);
    expect(messageAppOptions.signalCli).toBeDefined();
  });

  it("throws when Signal env vars are partially set", async () => {
    process.env.SIGNAL_BAT_PATH = "/bin/signal"; // phone missing

    const loadAllMessageApps = await loadModule(true);
    await expect(loadAllMessageApps(["Signal"])).rejects.toThrow(
      "Signal env vars partially set"
    );
  });
});

describe("loadAllMessageApps — Telegram", () => {
  it("enables Telegram when the bot token is set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "12345:abc";

    const loadAllMessageApps = await loadModule(true);
    const { messageApps, messageAppOptions } = await loadAllMessageApps([
      "Telegram"
    ]);

    expect(messageApps).toEqual(["Telegram"]);
    expect(messageAppOptions.telegramBotToken).toBe("12345:abc");
  });
});

describe("loadAllMessageApps — Matrix encryption branches", () => {
  it("uses RustSdkCryptoStorageProvider when encryption is ENABLED", async () => {
    process.env.MATRIX_HOME_URL = "matrix.example.org";
    process.env.MATRIX_BOT_TOKEN = "botTok";

    const loadAllMessageApps = await loadModule(true);
    const { messageApps } = await loadAllMessageApps(["Matrix"]);

    expect(messageApps).toEqual(["Matrix"]);
    expect(RustSdkCryptoStorageProviderMock).toHaveBeenCalledTimes(1);
    expect(RustSdkCryptoStorageProviderMock).toHaveBeenCalledWith(
      "matrix/matrix-crypto",
      "Sqlite"
    );
    expect(SimpleFsStorageProviderMock).toHaveBeenCalledWith(
      "matrix/matrix-bot.json"
    );
    // cryptoProvider (4th arg) is an instance of RustSdk mock, i.e. defined.
    const cryptoArg = MatrixClientMock.mock.calls[0][3];
    expect(cryptoArg).toBeDefined();
    expect(matrixStart).toHaveBeenCalledTimes(1);
  });

  it("passes undefined cryptoProvider when encryption is DISABLED", async () => {
    process.env.MATRIX_HOME_URL = "matrix.example.org";
    process.env.MATRIX_BOT_TOKEN = "botTok";

    const loadAllMessageApps = await loadModule(false);
    const { messageApps } = await loadAllMessageApps(["Matrix"]);

    expect(messageApps).toEqual(["Matrix"]);
    expect(RustSdkCryptoStorageProviderMock).not.toHaveBeenCalled();
    const cryptoArg = MatrixClientMock.mock.calls[0][3];
    expect(cryptoArg).toBeUndefined();
  });

  it("throws when Matrix env vars are partially set", async () => {
    process.env.MATRIX_HOME_URL = "matrix.example.org"; // token missing

    const loadAllMessageApps = await loadModule(true);
    await expect(loadAllMessageApps(["Matrix"])).rejects.toThrow(
      "Matrix env vars partially set"
    );
  });

  it("logs and skips Matrix when the client fails to start", async () => {
    process.env.MATRIX_HOME_URL = "matrix.example.org";
    process.env.MATRIX_BOT_TOKEN = "botTok";
    matrixStart.mockRejectedValueOnce(new Error("server already running"));

    const loadAllMessageApps = await loadModule(true);
    const { messageApps } = await loadAllMessageApps(["Matrix"]);

    expect(messageApps).toEqual([]); // Matrix not pushed
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0][0]).toBe("Matrix");
  });
});

describe("loadAllMessageApps — selection & empty env", () => {
  it("returns no apps when nothing is configured (messageApps undefined)", async () => {
    const loadAllMessageApps = await loadModule(true);
    const { messageApps, messageAppOptions } = await loadAllMessageApps();

    expect(messageApps).toEqual([]);
    expect(messageAppOptions).toEqual({});
  });

  it("only considers the requested apps (filtered subset)", async () => {
    // Set env for several apps but only request Telegram.
    process.env.TELEGRAM_BOT_TOKEN = "12345:abc";
    process.env.WHATSAPP_USER_TOKEN = "tok";
    process.env.WHATSAPP_APP_SECRET = "sec";
    process.env.WHATSAPP_VERIFY_TOKEN = "vfy";

    const requested: MessageApp[] = ["Telegram"];
    const loadAllMessageApps = await loadModule(true);
    const { messageApps } = await loadAllMessageApps(requested);

    expect(messageApps).toEqual(["Telegram"]);
    expect(WhatsAppAPIMock).not.toHaveBeenCalled();
  });

  it("enables all configured apps when messageApps is undefined", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "12345:abc";
    process.env.SIGNAL_BAT_PATH = "/bin/signal";
    process.env.SIGNAL_PHONE_NUMBER = "+33600000000";

    const loadAllMessageApps = await loadModule(true);
    const { messageApps } = await loadAllMessageApps();

    expect(messageApps).toContain("Signal");
    expect(messageApps).toContain("Telegram");
  });
});
