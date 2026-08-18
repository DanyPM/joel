import { describe, it, expect, vi, beforeEach } from "vitest";

const { logWarningSpy } = vi.hoisted(() => ({
  logWarningSpy: vi.fn(() => Promise.resolve())
}));
vi.mock("../utils/debugLogger.ts", () => ({ logWarning: logWarningSpy }));

import { textFromMessage } from "../utils/whatsAppMessageText.ts";
import type { ServerMessage } from "whatsapp-api-js/types";

const asMessage = (value: unknown) => value as ServerMessage;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("textFromMessage", () => {
  it("returns null for a missing message instead of throwing", () => {
    // whatsapp-api-js reads value.messages[0] unconditionally, so a "messages"
    // change carrying an empty array reaches the emitter with no message.
    expect(textFromMessage(undefined)).toBeNull();
    expect(textFromMessage(null)).toBeNull();
    expect(logWarningSpy).not.toHaveBeenCalled();
  });

  it("reads plain text bodies", () => {
    expect(
      textFromMessage(asMessage({ type: "text", text: { body: "Bonjour" } }))
    ).toBe("Bonjour");
  });

  it("reads quick-reply button text", () => {
    expect(
      textFromMessage(asMessage({ type: "button", button: { text: "Oui" } }))
    ).toBe("Oui");
  });

  it("reads interactive list and button replies", () => {
    expect(
      textFromMessage(
        asMessage({
          type: "interactive",
          interactive: { type: "list_reply", list_reply: { title: "Suivis" } }
        })
      )
    ).toBe("Suivis");
    expect(
      textFromMessage(
        asMessage({
          type: "interactive",
          interactive: {
            type: "button_reply",
            button_reply: { title: "Menu" }
          }
        })
      )
    ).toBe("Menu");
  });

  it("returns null for an interactive reply with no title-bearing shape", () => {
    expect(
      textFromMessage(
        asMessage({ type: "interactive", interactive: { type: "nfm_reply" } })
      )
    ).toBeNull();
  });

  it("warns once for a media message and returns null", () => {
    expect(textFromMessage(asMessage({ type: "image", image: {} }))).toBeNull();
    expect(logWarningSpy).toHaveBeenCalledWith(
      "WhatsApp",
      expect.stringContaining("image")
    );
  });
});
