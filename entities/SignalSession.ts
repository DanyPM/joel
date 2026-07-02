import { ISession, IUser, MessageApp } from "../types.ts";
import User from "../models/User.ts";
import {
  ExternalMessageOptions,
  loadUser,
  MessageSendingOptionsInternal,
  recordSuccessfulDelivery
} from "./Session.ts";
import umami, { UmamiEvent, UmamiLogger } from "../utils/umami.ts";
import { markdown2plainText, splitText } from "../utils/text.utils.ts";
import { SignalRestClient } from "../utils/signalRestClient.ts";
import { KEYBOARD_KEYS } from "./Keyboard.ts";
import { logError } from "../utils/debugLogger.ts";

const SignalMessageApp: MessageApp = "Signal";

// Signal has no reply keyboard, so menus and selections are rendered as native
// Signal polls. These labels mirror the main-menu keyboard used elsewhere.
const SIGNAL_MAIN_MENU_LABELS = [
  KEYBOARD_KEYS.FOLLOWS_LIST.key.text,
  KEYBOARD_KEYS.FUNCTION_FOLLOW.key.text,
  KEYBOARD_KEYS.HELP.key.text
];
const SIGNAL_MAIN_MENU_PROMPT = "🏠 Menu principal";
const SIGNAL_SELECT_PROMPT = "👇 Choisissez une option";

export const SIGNAL_MESSAGE_CHAR_LIMIT = 2000;
const SIGNAL_COOL_DOWN_DELAY_SECONDS = 6;
// the Signal send path exposes no error taxonomy, so a failure is treated as transient:
// resume from the failed chunk for a few capped-backoff attempts, then give up
// (return false -> notification retried on a later run, user state unchanged).
const MAX_SIGNAL_MESSAGE_RETRY = 3;
const SIGNAL_MAX_BACKOFF_MS = 60_000;

export const SIGNAL_API_SENDING_CONCURRENCY = 1;

export class SignalSession implements ISession {
  messageApp = SignalMessageApp;
  signalCli: SignalRestClient;
  language_code: string;
  chatId: string;
  botPhoneID: string;
  user: IUser | null | undefined = undefined;
  isReply: boolean | undefined;
  lastEngagementAt: Date;

  constructor(
    signalCli: SignalRestClient,
    botPhoneID: string,
    userPhoneId: string,
    language_code: string,
    lastEngagementAt: Date
  ) {
    this.signalCli = signalCli;
    this.botPhoneID = botPhoneID;
    this.chatId = userPhoneId;
    this.language_code = language_code;
    this.lastEngagementAt = lastEngagementAt;
  }

  // try to fetch user from db
  async loadUser(): Promise<IUser | null> {
    this.user = await loadUser(this);
    return this.user;
  }

  // Force create a user record
  async createUser() {
    this.user = await User.findOrCreate(this);
  }

  sendTypingAction() {
    // TODO: check implementation in Signal
  }

  log(args: { event: UmamiEvent; payload?: Record<string, unknown> }) {
    umami.log({
      event: args.event,
      messageApp: this.messageApp,
      payload: args.payload,
      hasAccount: this.user != null
    });
  }

  async sendMessage(
    formattedData: string,
    options?: MessageSendingOptionsInternal
  ): Promise<boolean> {
    const delivered = await sendSignalAppMessage(
      this.signalCli,
      this.chatId,
      formattedData,
      { ...options, useAsyncUmamiLog: false, hasAccount: this.user != null }
    );

    // Render a menu / selection as a native Signal poll. An explicit keyboard
    // becomes the poll options; separateMenuMessage shows the main menu. A poll
    // failure never fails the text send.
    try {
      let answers: string[] | undefined;
      let prompt = SIGNAL_SELECT_PROMPT;
      if (options?.keyboard != null) {
        answers = options.keyboard.flat().map((k) => k.text);
      } else if (options?.separateMenuMessage) {
        answers = SIGNAL_MAIN_MENU_LABELS;
        prompt = SIGNAL_MAIN_MENU_PROMPT;
      }
      if (answers != null && answers.length > 0) {
        const recipient = this.chatId.startsWith("+")
          ? this.chatId
          : "+" + this.chatId;
        await this.signalCli.createPoll(recipient, prompt, answers);
      }
    } catch (error) {
      await logError("Signal", "Failed to send Signal poll menu", error);
    }

    return delivered;
  }

  extractMessageAppsOptions(): ExternalMessageOptions {
    return { signalCli: this.signalCli };
  }
}

export async function extractSignalAppSession(
  session: ISession,
  userFacingError?: boolean
): Promise<SignalSession | undefined> {
  if (session.messageApp !== "Signal") {
    await logError(session.messageApp, "Session is not a SignalSession");
    if (userFacingError) {
      await session.sendMessage(
        `Cette fonctionnalité n'est pas encore disponible sur ${session.messageApp}`
      );
    }
    return undefined;
  }
  if (!(session instanceof SignalSession)) {
    await logError(
      session.messageApp,
      "Session messageApp is Signal, but session is not a SignalSession"
    );
    return undefined;
  }

  return session;
}

export async function sendSignalAppMessage(
  signalCli: SignalRestClient,
  userPhoneId: string,
  message: string,
  options: MessageSendingOptionsInternal,
  retryNumber = 0,
  // Resume state for retries: reuse the already-split chunks and start at the
  // failed chunk so previously delivered chunks are not resent.
  preSplitChunks?: string[],
  startChunk = 0
): Promise<boolean> {
  const umamiLogger: UmamiLogger = options.useAsyncUmamiLog
    ? umami.logAsync
    : umami.log;
  const userPhoneIdInt = userPhoneId.startsWith("+")
    ? userPhoneId
    : "+" + userPhoneId;
  // On a retry, reuse the chunks split on the first attempt (don't re-convert).
  const mArr =
    preSplitChunks ??
    splitText(markdown2plainText(message), SIGNAL_MESSAGE_CHAR_LIMIT);
  let i = startChunk;
  try {
    for (; i < mArr.length; i++) {
      await signalCli.sendMessage(userPhoneIdInt, mArr[i]);

      await umamiLogger({
        event: "/message-sent",
        messageApp: "Signal",
        hasAccount: options.hasAccount
      });

      // prevent hitting the Signal API rate limit
      await new Promise((resolve) =>
        setTimeout(resolve, SIGNAL_COOL_DOWN_DELAY_SECONDS * 1000)
      );
    }
    await recordSuccessfulDelivery(SignalMessageApp, userPhoneId);
  } catch (error) {
    if (retryNumber < MAX_SIGNAL_MESSAGE_RETRY) {
      const backoffMs =
        Math.min(Math.pow(2, retryNumber) * 1000, SIGNAL_MAX_BACKOFF_MS) +
        Math.random() * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      // Resume from the failed chunk i, reusing mArr.
      return await sendSignalAppMessage(
        signalCli,
        userPhoneId,
        message,
        options,
        retryNumber + 1,
        mArr,
        i
      );
    }
    await logError(
      "Signal",
      `Error sending signal message aborted after ${String(MAX_SIGNAL_MESSAGE_RETRY)} retries (chunk ${String(i + 1)}/${String(mArr.length)}) to ${userPhoneId}`,
      error
    );
    return false;
  }
  return true;
}
