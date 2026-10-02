import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDirectWatchdogPresence } from "./direct-watchdog-presence";

type TestEvent = { type: string; data?: string; code?: number };
type Listener = (event: TestEvent) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(value: string): void {
    void value;
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  message(body: unknown): void {
    this.emit("message", { data: JSON.stringify(body) });
  }

  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  private emit(type: string, extra: Partial<TestEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...extra });
  }
}

function token(expiresAtMs = Date.now() + 60_000): string {
  const body = Buffer.from(JSON.stringify({
    browserLegId: "browser-leg",
    callId: "call",
    expiresAtMs,
    operatorUserId: "operator",
    sessionId: "session",
  })).toString("base64url");
  return body + ".signature";
}

describe("direct watchdog browser presence", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("bounds construction-to-admission and does not wait for an open event forever", async () => {
    vi.useFakeTimers();
    const pending = openDirectWatchdogPresence({ url: "wss://watchdog.test/presence", token: token() });
    const rejected = expect(pending).rejects.toThrow("did not acknowledge");
    await vi.advanceTimersByTimeAsync(2_500);
    await rejected;
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("reconnects after an admitted socket closes and re-admits before continuing", async () => {
    vi.useFakeTimers();
    const pending = openDirectWatchdogPresence({ url: "wss://watchdog.test/presence", token: token() });
    const first = FakeWebSocket.instances[0];
    first.open();
    first.message({ type: "presence_ack", callId: "call" });
    const presence = await pending;

    first.serverClose(1001);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1];
    second.open();
    second.message({ type: "presence_ack", callId: "call" });
    await presence.close();
    expect(second.readyState).toBe(FakeWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("stops reconnecting after the signed lease expires", async () => {
    vi.useFakeTimers();
    const pending = openDirectWatchdogPresence({ url: "wss://watchdog.test/presence", token: token(Date.now() + 500) });
    const first = FakeWebSocket.instances[0];
    first.open();
    first.message({ type: "presence_ack", callId: "call" });
    const presence = await pending;
    first.serverClose(1001);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await presence.close();
  });
});
