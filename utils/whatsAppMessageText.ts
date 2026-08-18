import type { ServerMessage } from "whatsapp-api-js/types";

import { logWarning } from "./debugLogger.ts";

/**
 * Pick a printable fragment from any WhatsApp inbound message.
 * Returns `null` when there is nothing reasonably textual.
 */
export function textFromMessage(
  msg: ServerMessage | undefined | null
): string | null {
  // Meta can deliver a "messages" change whose `messages` array is empty; the
  // client library still indexes [0] and hands us `undefined`.
  if (msg == null) return null;

  switch (msg.type) {
    //  Plain text
    case "text":
      return msg.text.body;

    // Quick-reply buttons
    case "button":
      return msg.button.text;

    //  Interactive replies (List, Reply-button, Flow)  */
    case "interactive":
      switch (msg.interactive.type) {
        case "list_reply":
          return msg.interactive.list_reply.title;
        case "button_reply":
          return msg.interactive.button_reply.title;
        /*
      case "nfm_reply": // Flow submission
        return (
          msg.interactive.nfm_reply.body ??
          msg.interactive.nfm_reply.response_json ??
          null);
        */
      }
      return null;

    /*  Catch-all for anything the API marks
         as unsupported or future types  */
    default:
      // Media, stickers, locations and future types: expected user behaviour,
      // not a fault.
      void logWarning("WhatsApp", `Unsupported message type: ${msg.type}`);
      return null;
  }
}
