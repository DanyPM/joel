import { ISession } from "../types.ts";
import { Keyboard } from "../entities/Keyboard.ts";
import {
  ExternalMessageOptions,
  MiniUserInfo,
  sendMessage
} from "../entities/Session.ts";
import { logError } from "../utils/debugLogger.ts";

export const defaultCommand = async (session: ISession): Promise<void> => {
  try {
    if (session.isReply) return;
    session.log({ event: "/default-message" });
    await session.sendMessage("Je n'ai pas compris votre message 🥺", {
      separateMenuMessage: true
    });
  } catch (error) {
    await logError(session.messageApp, "Error in /default command", error);
  }
};

export const MAIN_MENU_MESSAGE = "Utilisez le clavier ci-dessous.";

export const mainMenuCommand = async (session: ISession): Promise<void> => {
  session.log({ event: "/main-menu-message" });
  await sendMainMenu(
    {
      messageApp: session.messageApp,
      chatId: session.chatId,
      roomId: session.roomId,
      hasAccount: session.user != null
    },
    { session }
  );
};

export async function sendMainMenu(
  userInfo: {
    chatId: MiniUserInfo["chatId"];
    messageApp: MiniUserInfo["messageApp"];
    roomId: MiniUserInfo["roomId"];
    hasAccount: boolean;
  },
  options: {
    externalOptions?: ExternalMessageOptions;
    session?: ISession;
  }
): Promise<void> {
  if (options.session == null && options.externalOptions == null)
    throw new Error("session or externalOptions is required");

  try {
    const message = MAIN_MENU_MESSAGE;
    let separateMenuMessage = undefined;

    const keyboard: Keyboard | undefined = undefined;
    switch (userInfo.messageApp) {
      // Signal mirrors Matrix: the full menu is shown as a native poll
      // (separateMenuMessage), not a text list of commands.
      case "Tchap":
      case "Matrix":
      case "Signal":
        separateMenuMessage = true;
        break;

      case "Telegram":
      case "WhatsApp":
        break;
    }
    if (options.session != null)
      await options.session.sendMessage(message, {
        keyboard,
        separateMenuMessage
      });
    else if (options.externalOptions != null)
      await sendMessage(userInfo, message, {
        ...options.externalOptions,
        keyboard,
        separateMenuMessage,
        useAsyncUmamiLog: true,
        hasAccount: userInfo.hasAccount
      });
  } catch (error) {
    await logError(userInfo.messageApp, "Error in /default command", error);
  }
}
