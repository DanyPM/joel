import axios, { AxiosError, isAxiosError } from "axios";
import { MessageApp } from "../types.ts";
import * as https from "node:https";
import pLimit from "p-limit";

export interface UmamiNotificationData {
  message_nb: number;
  updated_follows_nb: number;
  total_records_nb: number;
  last_engagement_delay_days: number;
}

export type UmamiLogger = (args: UmamiLogArgs) => Promise<void> | void;

export interface UmamiLogArgs {
  event: UmamiEvent;
  hasAccount?: boolean;
  messageApp?: MessageApp;
  notificationData?: UmamiNotificationData;
  payload?: Record<string, unknown>;
}

const buildExtraData = (args: UmamiLogArgs): Record<string, unknown> => {
  const extra_data: Record<string, unknown> = args.payload ?? {};
  if (args.messageApp) {
    extra_data.messageApp = args.messageApp;
  }
  if (args.hasAccount != null) {
    extra_data.has_account = args.hasAccount;
  }

  if (args.notificationData != null) {
    extra_data.message_nb = args.notificationData.message_nb;
    extra_data.updated_follows_nb = args.notificationData.updated_follows_nb;
    extra_data.total_records_nb = args.notificationData.total_records_nb;
  }

  return extra_data;
};

const createPayload = (args: UmamiLogArgs) => ({
  payload: {
    hostname: process.env.UMAMI_HOST,
    website: process.env.UMAMI_ID,
    name: args.event,
    data: buildExtraData(args)
  },
  type: "event"
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10
});

const axiosClient = axios.create({
  httpsAgent
});

// Shared limiter to cap concurrent send attempts across all log calls.
const limit = pLimit(5);

// Umami is the only record that a scheduled run happened at all, so a dropped
// event is indistinguishable from a run that never started. Retry before
// giving up.
const SEND_MAX_ATTEMPTS = 3;
const SEND_RETRY_DELAY_MS = 500;

// Resolves to false when the event did not reach Umami.
const logInternal = async (args: UmamiLogArgs): Promise<boolean> => {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.NODE_ENV === "development") {
    console.log(
      `Umami event ${args.messageApp ? "(" + args.messageApp + ")" : ""}: ${args.event}`
    );
    if (args.notificationData != null || args.payload != null)
      console.log({ ...args.notificationData, ...args.payload });
    return true;
  } else {
    if (args.messageApp === "debug") {
      throw new Error(
        "Umami logging with messageApp 'debug' is not allowed in production."
      );
    }
  }

  const endpoint = `https://${String(process.env.UMAMI_HOST)}/api/send`;
  const payload = createPayload(args);
  const options = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0"
    }
  };
  return await limit(async () => {
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await axiosClient.post(endpoint, payload, options);
        return true;
      } catch (error) {
        if (attempt < SEND_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, SEND_RETRY_DELAY_MS * attempt)
          );
          continue;
        }
        if (isAxiosError(error)) {
          const axiosErr = error as AxiosError;
          console.error(
            `Axios error on umami.log "${args.event}" : ${axiosErr.code ? " " + axiosErr.code : ""} ${axiosErr.message}`
          );
        } else {
          console.log(error);
        }
      }
    }
    return false;
  });
};

export const log = (args: UmamiLogArgs): void => {
  // Schedule the whole logging routine to keep callers non-blocking.
  setImmediate(() => {
    void logInternal(args);
  });
};

export const logAsync: UmamiLogger = async (
  args: UmamiLogArgs
): Promise<void> => {
  await logInternal(args);
};

/**
 * Like {@link logAsync}, but reports whether the event actually reached Umami.
 * Use it for events whose absence is itself the signal being measured.
 */
export const logAsyncVerified = async (args: UmamiLogArgs): Promise<boolean> =>
  await logInternal(args);

export default {
  log,
  logAsync,
  logAsyncVerified
};

export type UmamiEvent =
  | "/message-received"
  | "/message-sent"
  | "/message-sent-broadcast"
  | "/message-fail-too-many-requests"
  | "/message-fail-too-many-requests-aborted"
  | "/message-received-echo-refused"
  | "/reengagement-notifications-sent"
  | "/reengagement-reminder-sweep"
  | "/wh-reengagement-near-miss"
  | "/wh-reengagement-window-expired"
  | "/trigger-pending-updates"
  | "/start"
  | "/start-from-people"
  | "/start-from-organisation"
  | "/start-from-tag"
  | "/default-message"
  | "/main-menu-message"
  | "/help"
  | "/stats"
  | "/build"
  | "/list"
  | "/delete-profile"
  | "/jorfsearch-error"
  | "/jorfsearch-request-people"
  | "/jorfsearch-request-people-formatted"
  | "/jorfsearch-request-tag"
  | "/jorfsearch-request-organisation"
  | "/jorfsearch-request-date"
  | "/jorfsearch-request-meta"
  | "/jorfsearch-request-reference"
  | "/jorfsearch-request-wikidata-names"
  | "/jorfsearch-request-date-nonempty"
  | "/search"
  | "/history"
  | "/ena"
  | "/ena-list"
  | "/follow"
  | "/follow-name"
  | "/follow-function"
  | "/follow-organisation"
  | "/follow-reference"
  | "/follow-meta"
  | "/text-alert"
  | "/unfollow"
  | "/new-user"
  | "/new-organisation"
  | "/publication-added"
  | "/organisation-deletion-no-follow"
  | "/person-added"
  | "/person-deletion-no-follow"
  | "/user-blocked-joel"
  | "/user-unblocked-joel"
  | "/user-deactivated"
  | "/user-deletion-no-follow"
  | "/user-deletion-self"
  | "/data-export"
  | "/data-import"
  | "/data-import-confirmed"
  | "/notification-update-people"
  | "/notification-update-name"
  | "/notification-update-function"
  | "/notification-update-organisation"
  | "/notification-update-meta"
  | "/notification-process-completed"
  | "/daily-active-user"
  | "/weekly-active-user"
  | "/monthly-active-user"
  | "/console-log"
  | "/daily-stats-completed"
  | "/notification-failover-triggered"
  | "/notification-failover-clear";
