import { EventEmitter } from "node:events";

export interface SignalEnvelopeMessage {
  envelope: {
    sourceNumber: string;
    dataMessage?: { message?: string };
  };
}

// Minimal surface of the global WebSocket the adapter relies on. Lets tests
// inject a fake without a real socket.
export interface WebSocketLike {
  addEventListener(type: string, cb: (ev: any) => void): void;
  close(): void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;

// Parse a signal-cli-rest-api receive frame into the envelope shape the bot
// consumes. Returns null for anything that is not an actionable text message
// (receipts, typing, sync, malformed frames).
export function parseSignalFrame(data: unknown): SignalEnvelopeMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const env = (parsed as Partial<SignalEnvelopeMessage>)?.envelope;
  if (env == null || env.dataMessage?.message == null) return null;
  return parsed as SignalEnvelopeMessage;
}

export class SignalRestClient extends EventEmitter {
  private readonly apiUrl: string;
  private readonly wsUrl: string;
  private readonly phoneNumber: string;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private ws: WebSocketLike | null = null;
  private reconnectAttempts = 0;
  private intentionalShutdown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    apiUrl: string,
    phoneNumber: string,
    wsFactory: (url: string) => WebSocketLike = (url) =>
      new WebSocket(url) as unknown as WebSocketLike
  ) {
    super();
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.phoneNumber = phoneNumber;
    this.wsFactory = wsFactory;
    const wsBase = this.apiUrl.replace(/^http/, "ws"); // http->ws, https->wss
    this.wsUrl = `${wsBase}/v1/receive/${phoneNumber}`;
  }

  connect(): Promise<void> {
    this.intentionalShutdown = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Signal rest-api WebSocket connect timed out"));
      }, CONNECT_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      this.openSocket(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private openSocket(onOpen?: () => void): void {
    const ws = this.wsFactory(this.wsUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      onOpen?.();
    });
    ws.addEventListener("message", (ev: { data?: unknown }) => {
      const parsed = parseSignalFrame(ev?.data);
      if (parsed) this.emit("message", parsed);
    });
    ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.intentionalShutdown) this.scheduleReconnect();
    });
    // 'error' is followed by 'close'; reconnection is handled there.
    ws.addEventListener("error", () => undefined);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalShutdown) this.openSocket();
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") {
      this.reconnectTimer.unref();
    }
  }

  async sendMessage(recipient: string, message: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: this.phoneNumber,
        recipients: [recipient],
        message
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `signal-cli-rest-api send failed: ${res.status} ${res.statusText} ${body}`.trim()
      );
    }
  }

  disconnect(): void {
    this.intentionalShutdown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
