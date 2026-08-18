import "dotenv/config";
import { mongodbConnect } from "../db.ts";
import { JORFSearchItem } from "../entities/JORFSearchResponse.ts";
import { JORFSearchPublication } from "../entities/JORFSearchResponseMeta.ts";
import { MessageApp } from "../types.ts";
import { notifyOrganisationsUpdates } from "./organisationNotifications.ts";
import { notifyPeopleUpdates } from "./peopleNotifications.ts";
import { notifyNameMentionUpdates } from "./nameNotifications.ts";
import { notifyFunctionTagsUpdates } from "./functionTagNotifications.ts";
import { notifyAlertStringUpdates } from "./alertStringNotifications.ts";
import { runReengagementReminderSweep } from "./reengagementReminderSweep.ts";
import umami from "../utils/umami.ts";
import mongoose, { Types } from "mongoose";

import { ExternalMessageOptions } from "../entities/Session.ts";
import { refreshTelegramBlockedUsers } from "../entities/TelegramSession.ts";
import { logError, logErrorForApps } from "../utils/debugLogger.ts";
import {
  getJORFMetaRecordsFromDate,
  getJORFRecordsFromDate,
  JORFRangeResult
} from "../utils/JORFSearch.utils.ts";
import { formatDuration, JORFtoDate } from "../utils/date.utils.ts";

/**
 * Runs one JORFSearch range fetch, downgrading every failure mode to an empty
 * item list so the rest of the run can proceed.
 *
 * A partial range still yields its items: serving the users whose follows were
 * published on a reachable day beats serving nobody. The gap is reported so it
 * can be replayed with NOTIFICATIONS_SHIFT_DAYS, because handlers move each
 * follow's `lastUpdate` forward on delivery and will not revisit the missed
 * days on their own.
 */
/**
 * Newest instant a range is known to cover completely.
 *
 * Coverage runs forward from a follow's stored `lastUpdate`, so it ends at the
 * first day the range failed to fetch: everything from that day on is unknown,
 * whether or not later days succeeded. Returns the last millisecond before that
 * day starts, which keeps records dated that day above the cursor and therefore
 * eligible on a later run. `JORFtoDate` and the handlers' own comparisons both
 * place a YMD date at local midnight, so the two agree on the boundary.
 */
export function coverageCursorFor(
  windowNow: Date,
  failedDates: string[]
): Date {
  if (failedDates.length === 0) return windowNow;
  // YMD sorts lexicographically in date order.
  const oldestGap = failedDates.reduce((a, b) => (a < b ? a : b));
  return new Date(
    Math.min(windowNow.getTime(), JORFtoDate(oldestGap).getTime() - 1)
  );
}

async function fetchRange<T>(
  label: string,
  fetch: () => Promise<JORFRangeResult<T>>,
  targetApps: MessageApp[],
  windowNow: Date
): Promise<{ items: T[]; coverageCursor: Date }> {
  let range: JORFRangeResult<T>;
  try {
    range = await fetch();
  } catch (error) {
    await logErrorForApps(
      targetApps,
      `Could not fetch JORF ${label}: the matching notifications are skipped for this run.`,
      error
    );
    return { items: [], coverageCursor: windowNow };
  }

  if (range.failedDates.length === 0) {
    return { items: range.items, coverageCursor: windowNow };
  }

  const allDaysFailed = range.failedDates.length === range.requestedDays;
  await logErrorForApps(
    targetApps,
    allDaysFailed
      ? `JORFSearch is unreachable for ${label}: no day of the range could be fetched, the matching notifications are skipped for this run.`
      : `JORFSearch returned no data for ${String(range.failedDates.length)}/${String(range.requestedDays)} day(s) of ${label} (${range.failedDates.join(", ")}). Notifications are sent for the days that were fetched, and follows are not advanced past ${range.failedDates.reduce((a, b) => (a < b ? a : b))} so the gap is picked up on a later run.`
  );

  // A fully failed range is indistinguishable from "nothing was published", and
  // handlers no-op on an empty list either way.
  return {
    items: allDaysFailed ? [] : range.items,
    coverageCursor: coverageCursorFor(windowNow, range.failedDates)
  };
}

// Ops latency warning only: the WhatsApp send guard re-checks the 24h window
// in real time at each send, so a slow run no longer risks 131047 errors.
const NOTIFICATION_DURATION_BEFORE_WARNING_MS = 5 * 60 * 1000; // 5 minutes

export async function runNotificationProcess(
  targetApps: MessageApp[],
  messageAppsOptions: ExternalMessageOptions
): Promise<void> {
  const start = new Date();
  console.log("Notification started.");
  try {
    if (
      targetApps.some((a) => a === "Matrix") &&
      messageAppsOptions.matrixClient == null
    ) {
      await logError(
        "Matrix",
        `Notification process skipped as the Matrix client is not set.`
      );
      return;
    }
    if (
      targetApps.some((a) => a === "Telegram") &&
      messageAppsOptions.telegramBotToken == null
    ) {
      await logError(
        "Telegram",
        `Notification process skipped as the bot token is not set.`
      );
      return;
    }

    if (
      targetApps.some((a) => a === "Signal") &&
      messageAppsOptions.signalCli == null
    ) {
      await logError(
        "Signal",
        `Notification process skipped as the signal client is not set.`
      );
      return;
    }

    if (
      targetApps.some((a) => a === "WhatsApp") &&
      messageAppsOptions.whatsAppAPI == null
    ) {
      await logError(
        "WhatsApp",
        `Notification process skipped as the WhatsApp client is not set.`
      );
      return;
    }

    // Start mdb connection if not already connected
    if (mongoose.connection.readyState.valueOf() != 1) await mongodbConnect();

    if (targetApps.includes("Telegram")) {
      await refreshTelegramBlockedUsers(messageAppsOptions.telegramBotToken);
    }

    // Number of days to go back: 0 means we just fetch today's info
    const SHIFT_DAYS_ENV = process.env.NOTIFICATIONS_SHIFT_DAYS;

    if (SHIFT_DAYS_ENV == null) {
      for (const appType of targetApps) {
        void logError(
          appType,
          "Missing NOTIFICATIONS_SHIFT_DAYS env var not set: using 0"
        );
      }
    }
    let SHIFT_DAYS = 0;
    if (SHIFT_DAYS_ENV != null) {
      const parsedShiftDays = parseInt(SHIFT_DAYS_ENV, 10);
      if (Number.isNaN(parsedShiftDays)) {
        for (const appType of targetApps) {
          void logError(
            appType,
            `Invalid NOTIFICATIONS_SHIFT_DAYS env var value "${SHIFT_DAYS_ENV}": using 0`
          );
        }
      } else {
        SHIFT_DAYS = parsedShiftDays;
      }
    }

    const currentDate = new Date();
    const startDate = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      currentDate.getDate() - SHIFT_DAYS
    );
    startDate.setHours(0, 0, 0, 0);

    // Each source is fetched independently: one being unreachable must not cost
    // users the notifications the other one can still deliver.
    const records = await fetchRange(
      "records",
      () => getJORFRecordsFromDate(startDate, targetApps),
      targetApps,
      start
    );
    const metaRecords = await fetchRange(
      "meta publications",
      () => getJORFMetaRecordsFromDate(startDate, targetApps),
      targetApps,
      start
    );

    const failedHandlers = await notifyAllFollows(
      records.items,
      metaRecords.items,
      targetApps,
      messageAppsOptions,
      // `start` is the process-start snapshot; reuse it as the single window clock.
      start,
      undefined,
      false,
      {
        records: records.coverageCursor,
        meta: metaRecords.coverageCursor
      }
    );
    if (failedHandlers.length > 0) {
      await logErrorForApps(
        targetApps,
        `Notification handlers failed and were skipped: ${failedHandlers.join(", ")}. Other handlers ran normally.`
      );
    }

    // Weekly reminder for WhatsApp users sitting on pending notifications.
    // Independent of JORF: it must still run after a fetch or handler failure.
    if (targetApps.includes("WhatsApp")) {
      try {
        await runReengagementReminderSweep(messageAppsOptions);
      } catch (error) {
        await logError(
          "WhatsApp",
          "Error running the re-engagement reminder sweep",
          error
        );
      }
    }

    const duration_s = Math.ceil(
      (new Date().getTime() - start.getTime()) / 1000
    );

    for (const appType of targetApps) {
      await umami.logAsync({
        event: "/notification-process-completed",
        messageApp: appType,
        hasAccount: true,
        payload: { duration_s }
      });
    }

    const end = new Date();

    const delay = end.getTime() - start.getTime();
    if (
      end.getTime() - start.getTime() >
      NOTIFICATION_DURATION_BEFORE_WARNING_MS
    ) {
      for (const appType of targetApps) {
        await logError(
          appType,
          `Notification process took too long: ${formatDuration(delay)}.`
        );
      }
    }
    console.log(`Notification ended: took ${formatDuration(delay)}.`);
  } catch (err) {
    for (const appType of targetApps) {
      await logError(appType, "Error running notification process: ", err);
    }
  }
}

export async function notifyAllFollows(
  JORFAllRecordsFromDate: JORFSearchItem[],
  JORFMetaRecordsFromDate: JORFSearchPublication[],
  targetApps: MessageApp[],
  messageAppsOptions: ExternalMessageOptions,
  // One clock for the whole run: every handler judges the 24h window against the
  // same instant, so a user can't be in-window for handler 1 and expired by
  // handler 5 just because the run is slow.
  windowNow: Date,
  userIds?: Types.ObjectId[],
  forceWHMessages = false,
  // How far each source is known to be complete. The default suits callers
  // whose records come from explicit lookups rather than a day range, where
  // coverage is total by construction.
  coverageCursors: { records: Date; meta: Date } = {
    records: windowNow,
    meta: windowNow
  }
): Promise<string[]> {
  const handlers: { name: string; run: () => Promise<void> }[] = [];

  if (JORFAllRecordsFromDate.length > 0) {
    handlers.push(
      {
        name: "function tags",
        run: () =>
          notifyFunctionTagsUpdates(
            JORFAllRecordsFromDate,
            targetApps,
            messageAppsOptions,
            windowNow,
            userIds,
            forceWHMessages,
            coverageCursors.records
          )
      },
      {
        name: "organisations",
        run: () =>
          notifyOrganisationsUpdates(
            JORFAllRecordsFromDate,
            targetApps,
            messageAppsOptions,
            windowNow,
            userIds,
            forceWHMessages,
            coverageCursors.records
          )
      },
      {
        name: "people",
        run: () =>
          notifyPeopleUpdates(
            JORFAllRecordsFromDate,
            targetApps,
            messageAppsOptions,
            windowNow,
            userIds,
            forceWHMessages,
            coverageCursors.records
          )
      },
      {
        name: "name mentions",
        run: () =>
          notifyNameMentionUpdates(
            JORFAllRecordsFromDate,
            targetApps,
            messageAppsOptions,
            windowNow,
            // `userIds` / `forceWHMessages` are deliberately not forwarded here:
            // this handler has always run unscoped and unforced.
            undefined,
            false,
            coverageCursors.records
          )
      }
    );
  }

  if (JORFMetaRecordsFromDate.length > 0) {
    handlers.push({
      name: "alert strings",
      run: () =>
        notifyAlertStringUpdates(
          JORFMetaRecordsFromDate,
          targetApps,
          messageAppsOptions,
          windowNow,
          // Unscoped and unforced, as this handler has always been called.
          undefined,
          false,
          coverageCursors.meta
        )
    });
  }

  // Handlers cover disjoint follow types, so one blowing up says nothing about
  // the others: run each in isolation and report the failures to the caller
  // rather than losing every later handler's users to the first throw.
  const failedHandlers: string[] = [];
  for (const handler of handlers) {
    try {
      await handler.run();
    } catch (error) {
      failedHandlers.push(handler.name);
      await logErrorForApps(
        targetApps,
        `Error notifying ${handler.name} follows`,
        error
      );
    }
  }
  return failedHandlers;
}
