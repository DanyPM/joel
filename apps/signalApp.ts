import "dotenv/config";

import { createRequire } from "node:module";
import path from "node:path";
import { SignalCli } from "signal-sdk";
import { mongodbConnect, mongodbDisconnect } from "../db.ts";
import { SignalSession } from "../entities/SignalSession.ts";
import { startDailyNotificationJobs } from "../notifications/notificationScheduler.ts";
import { logError } from "../utils/debugLogger.ts";
import { handleIncomingMessage } from "../utils/messageWorkflow.ts";

const { SIGNAL_PHONE_NUMBER } = process.env;

// signal-sdk auto-resolves its bundled binary, but on Windows the resolved
// absolute path contains backslashes, which the SDK's own path validator
// rejects as "unsafe". Build the path with forward slashes (accepted on every
// platform) so the bot also runs locally on Windows.
const require = createRequire(import.meta.url);
const signalSdkDir = path.dirname(require.resolve("signal-sdk/package.json"));
const binName = process.platform === "win32" ? "signal-cli.bat" : "signal-cli";
const SIGNAL_CLI_PATH = path
  .join(signalSdkDir, "bin", binName)
  .replace(/\\/g, "/");

if (SIGNAL_PHONE_NUMBER === undefined) {
  console.log("Signal: env is not set, bot did not start \u{1F6A9}");
  process.exit(0);
}

interface ISignalMessage {
  envelope: {
    sourceNumber: string;
    dataMessage?: {
      message?: string;
    };
    receiptMessage?: never;
  };
}
await (async () => {
  try {
    // Path first, phone second: the SDK treats a non-"+" first arg as the
    // signal-cli path and the second as the account number.
    const signalCli = new SignalCli(SIGNAL_CLI_PATH, SIGNAL_PHONE_NUMBER);

    // Register stopper
    let shuttingDown = false;

    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;

      console.log(`Signal: Received ${signal}, shutting down...`);

      try {
        signalCli.disconnect();

        // Close DB cleanly
        await mongodbDisconnect();

        // Let stdout flush naturally; do not force-exit yet
        process.exitCode = 0;
      } catch (error) {
        await logError("Signal", `Error during ${signal} shutdown`, error);
        process.exitCode = 1;
      }

      // Safety net: if something keeps the event loop alive, force exit.
      setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref();
    };

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        void shutdown(sig);
      });
    }

    // Start the bot by connecting to MongoDB
    await mongodbConnect();

    // Connect to signal-cli daemon
    await signalCli.connect();

    // Listen for incoming messages
    signalCli.on("message", (message: ISignalMessage) => {
      void (async () => {
        try {
          if (message.envelope.sourceNumber === SIGNAL_PHONE_NUMBER) return;

          const msgText = message.envelope.dataMessage?.message;
          if (msgText === undefined) return;

          const messageSentTime = new Date(); // TODO: use the real message timestamp

          const signalSession = new SignalSession(
            signalCli,
            SIGNAL_PHONE_NUMBER,
            message.envelope.sourceNumber,
            "fr",
            messageSentTime
          );

          await handleIncomingMessage(signalSession, msgText, {
            errorContext: "Error processing command"
          });
        } catch (error) {
          await logError("Signal", "Error processing command", error);
        }
      })();
    });

    startDailyNotificationJobs(["Signal"], { signalCli: signalCli });
    console.log(`Signal: JOEL started successfully \u{2705}`);
  } catch (error) {
    await logError("Signal", "Failed to start Signal app", error);
  }
})();
