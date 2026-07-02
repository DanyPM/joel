# Signal poll parity (native polls)

**Date:** 2026-07-02
**Status:** Approved (design)

## Problem

Menus and in-flow selections render as interactive UI on Telegram (reply
keyboard), Matrix (native poll), and WhatsApp (interactive list), but on Signal
the `keyboard` option was silently dropped — users only got text and an
"I didn't understand" fallback. Signal has no reply-keyboard, but
signal-cli-rest-api **does** expose native Signal polls.

## Verified API contract (live-tested)

- **Create:** `POST /v1/polls/{botNumber}`
  `{ recipient, question, answers: string[], allow_multiple_selections: false }`
  → `{ "timestamp": "1783018038934" }` (string). Emoji survive when sent via
  Node `fetch` (the bot's path).
- **Vote (inbound WS frame):**
  `envelope.sourceNumber` = voter;
  `envelope.dataMessage.pollVote = { author, targetSentTimestamp, optionIndexes: number[], voteCount }`.
  `targetSentTimestamp` equals the create response `timestamp`. Votes carry the
  **index**, not the label.
- **Close:** `DELETE /v1/polls/{botNumber}` `{ recipient, pollTimestamp }`.

## Design (mirrors Matrix)

### `utils/signalRestClient.ts`

- `createPoll(recipient, question, answers): Promise<string>` — POST; returns the
  poll timestamp; records `pollRegistry.set(timestamp, { recipient, answers })`.
- `closePoll(recipient, timestamp): Promise<void>` — DELETE.
- `pollRegistry: Map<string, { recipient; answers: string[] }>` — bounded
  (`MAX_TRACKED_POLLS = 200`; evict oldest on overflow) so a long-running bot
  doesn't leak entries.
- `parsePollVote(data): { sourceNumber; targetSentTimestamp; optionIndexes } | null`
  — pure, testable.
- WS message handler: first try `parseSignalFrame` (text). If that is null, try
  `parsePollVote`; on a vote, look up the registry by `targetSentTimestamp`,
  resolve `optionIndexes[0]` → answer label, then **emit a normal `"message"`
  event** carrying that label (synthetic envelope
  `{ sourceNumber: voter, dataMessage: { message: label } }`), delete the
  registry entry, and fire-and-forget `closePoll`.

### `entities/SignalSession.ts`

`sendMessage(text, options)`:
1. Send the text as today (skip if empty).
2. Compute poll answers:
   - `options.keyboard` present → `keyboard.flat().map(k => k.text)`.
   - else `options.separateMenuMessage` → the Signal main-menu labels
     (`SIGNAL_MAIN_MENU_KEYS`).
   - else → none.
3. If answers exist, best-effort `signalCli.createPoll(chatId, prompt, answers)`
   (prompt: `"🏠 Menu principal"` for the main menu, otherwise
   `"👇 Choisissez une option"`). A poll failure is logged, never fails the text
   send.

`SIGNAL_MAIN_MENU_KEYS` mirrors the existing Signal main-menu keyboard
(`FOLLOWS_LIST`, `FUNCTION_FOLLOW`, `HELP`).

### Dispatcher: unchanged

The emitted label flows through the existing `handleIncomingMessage` →
`processMessage`, which already matches an incoming line against
`KEYBOARD_KEYS[*].key.text` and runs the action — exactly how Matrix routes a
vote (answer `id` = label). Follow-up selection prompts resolve through
`handleFollowUpMessage` the same way.

## Encoding note

The `??` seen during testing was Git Bash `curl` mangling emoji on the command
line, not signal-cli — Node `fetch` (the bot's path) sends UTF-8 cleanly. No
`JAVA_TOOL_OPTIONS` change needed.

## Success criteria

- Sending a menu on Signal produces a native poll with correct emoji.
- Voting dispatches the corresponding action (same as typing the label).
- The poll is closed after the vote is processed.
- `tsc -p tsconfig.build.json` clean; new adapter + SignalSession tests green.

## Out of scope

- Multi-select polls (`allow_multiple_selections` stays false).
- Poll edits; re-showing an expired poll.
