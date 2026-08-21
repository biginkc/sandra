export type CallTarget = {
  phoneE164: string;
  propertyId?: string;
  contactId?: string;
};

export type CallHandle = { id: string };
export type CallResult = { durationSeconds: number; outcome: "connected_human" | "failed" };
export type CallTransportState = "connecting" | "ringing" | "live" | "ended" | "failed";

export interface CallTransport {
  start(target: CallTarget): Promise<CallHandle>;
  mute(on: boolean): void;
  hold(on: boolean): void;
  hangup(): Promise<CallResult>;
  onStateChange(cb: (state: CallTransportState) => void): void;
}

/**
 * Phase 1's deliberately boring transport. It exercises the exact seam that
 * Phase 2 will replace with Jitter without importing a telephony SDK here.
 */
export class SimulatedCallTransport implements CallTransport {
  private listener: ((state: CallTransportState) => void) | null = null;
  private liveAt: number | null = null;
  private ended = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  onStateChange(cb: (state: CallTransportState) => void): void {
    this.listener = cb;
  }

  async start(target: CallTarget): Promise<CallHandle> {
    void target;
    this.ended = false;
    this.listener?.("connecting");
    this.timers.push(
      setTimeout(() => this.listener?.("ringing"), 40),
      setTimeout(() => {
        this.liveAt = Date.now();
        this.listener?.("live");
      }, 120),
    );
    return { id: `sim-${crypto.randomUUID()}` };
  }

  mute(on: boolean): void {
    void on;
  }

  hold(on: boolean): void {
    void on;
  }

  async hangup(): Promise<CallResult> {
    if (this.ended) return { durationSeconds: this.duration(), outcome: "connected_human" };
    this.ended = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    const result = { durationSeconds: this.duration(), outcome: "connected_human" as const };
    this.listener?.("ended");
    return result;
  }

  private duration(): number {
    return this.liveAt ? Math.max(0, Math.floor((Date.now() - this.liveAt) / 1000)) : 0;
  }
}
