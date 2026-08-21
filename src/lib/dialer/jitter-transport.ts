import {
  cancelJitterSoftphoneCall,
  connectJitterSoftphoneCall,
  getJitterSoftphoneToken,
  startJitterSoftphoneCall,
} from "./jitter-actions";
import type {
  JitterCancelReason,
  JitterProxyResult,
  JitterStartCallResponse,
  JitterTokenResponse,
} from "./jitter-contract";
import type {
  CallHandle,
  CallResult,
  CallTarget,
  CallTransport,
  CallTransportState,
} from "./transport";

const TELNYX_REGISTER_TIMEOUT_MS = 25_000;
const TELNYX_TOKEN_EXPIRING_SOON = 34_001;
const TELNYX_HOLD_FAILED = 44_001;
const TELNYX_BYE_SEND_FAILED = 44_003;
const TELNYX_RECOVERABLE_ERRORS = new Set([45_002, 45_004, 48_001]);

type TelnyxCallLike = {
  id?: string;
  recoveredCallId?: string;
  direction?: string;
  state?: string;
  cause?: string;
  sipCode?: number;
  sipReason?: string;
  answer(): Promise<void> | void;
  hangup(): Promise<void> | void;
  muteAudio(): void;
  unmuteAudio(): void;
  hold(): Promise<unknown> | void;
  unhold(): Promise<unknown> | void;
};

type TelnyxRtcLike = {
  remoteElement?: HTMLMediaElement | string | ((...args: unknown[]) => unknown);
  connect(): Promise<void> | void;
  disconnect(): Promise<void> | void;
  login?(options?: { creds?: { login_token?: string } }): Promise<void> | void;
  on(eventName: string, handler: (...args: unknown[]) => void): TelnyxRtcLike;
};

type TelnyxNotificationLike = {
  type?: string;
  call?: TelnyxCallLike;
  error?: unknown;
};

export type JitterTransportDependencies = {
  startCall(target: CallTarget): Promise<JitterProxyResult<JitterStartCallResponse>>;
  getToken(sessionRef: string): Promise<JitterProxyResult<JitterTokenResponse>>;
  connect(sessionRef: string): Promise<JitterProxyResult<{ dialing: true }>>;
  cancel(sessionRef: string, reason: JitterCancelReason): Promise<JitterProxyResult<{ tornDown: true }>>;
  createRtcClient(token: string, remoteAudio: HTMLAudioElement | null): Promise<TelnyxRtcLike>;
  createRemoteAudio(): HTMLAudioElement | null;
  subscribePageHide(handler: () => void): () => void;
  sendCancelBeacon(sessionRef: string, reason: JitterCancelReason): boolean;
  now(): number;
  registrationTimeoutMs: number;
};

const defaultDependencies: JitterTransportDependencies = {
  startCall: startJitterSoftphoneCall,
  getToken: getJitterSoftphoneToken,
  connect: connectJitterSoftphoneCall,
  cancel: cancelJitterSoftphoneCall,
  createRtcClient: createTelnyxRtcClient,
  createRemoteAudio,
  subscribePageHide(handler) {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  },
  sendCancelBeacon(sessionRef, reason) {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false;
    const body = JSON.stringify({ sessionRef, reason });
    return navigator.sendBeacon(
      "/api/softphone/jitter/cancel",
      new Blob([body], { type: "application/json" }),
    );
  },
  now: () => Date.now(),
  registrationTimeoutMs: TELNYX_REGISTER_TIMEOUT_MS,
};

export function mapTelnyxCallState(
  call: Pick<TelnyxCallLike, "direction" | "state" | "sipCode" | "sipReason" | "cause">,
  wasLive: boolean,
): CallTransportState | null {
  const state = call.state?.trim().toLowerCase();
  if (isTerminalCallState(state)) {
    return wasLive && (call.sipCode ?? 0) < 400 ? "ended" : "failed";
  }
  if ((call.sipCode ?? 0) >= 400) return "failed";
  if (call.direction === "inbound" && state === "ringing") return "ringing";
  if (state === "active" || state === "held") return "live";
  if (state === "requesting" || state === "trying" || state === "answering" || state === "early") {
    return "connecting";
  }
  return null;
}

export class JitterCallTransport implements CallTransport {
  private listener: ((state: CallTransportState) => void) | null = null;
  private currentState: CallTransportState | null = null;
  private sessionRef: string | null = null;
  private rtcClient: TelnyxRtcLike | null = null;
  private currentCall: TelnyxCallLike | null = null;
  private currentCallId: string | null = null;
  private expectedIncoming = false;
  private answerStarted = false;
  private desiredMute = false;
  private desiredHold = false;
  private liveAt: number | null = null;
  private terminalAt: number | null = null;
  private terminal: "ended" | "failed" | null = null;
  private hangupRequested = false;
  private startPromise: Promise<CallHandle> | null = null;
  private hangupPromise: Promise<CallResult> | null = null;
  private cancelPromise: Promise<boolean> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private registrationPromise: Promise<void> | null = null;
  private resolveRegistration: (() => void) | null = null;
  private rejectRegistration: ((error: unknown) => void) | null = null;
  private registrationTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private removePageHideListener: (() => void) | null = null;
  private remoteAudio: HTMLAudioElement | null = null;

  constructor(private readonly dependencies: JitterTransportDependencies = defaultDependencies) {}

  onStateChange(cb: (state: CallTransportState) => void): void {
    this.listener = cb;
  }

  start(target: CallTarget): Promise<CallHandle> {
    if (!this.startPromise) this.startPromise = this.startInternal(target);
    return this.startPromise;
  }

  mute(on: boolean): void {
    this.desiredMute = on;
    const call = this.currentCall;
    if (!call) return;
    try {
      if (on) call.muteAudio();
      else call.unmuteAudio();
    } catch (error) {
      void this.failAndCancel(error);
    }
  }

  hold(on: boolean): void {
    this.desiredHold = on;
    const call = this.currentCall;
    if (!call) return;
    try {
      const result = on ? call.hold() : call.unhold();
      void Promise.resolve(result).catch((error) => this.failAndCancel(error));
    } catch (error) {
      void this.failAndCancel(error);
    }
  }

  hangup(): Promise<CallResult> {
    if (!this.hangupPromise) this.hangupPromise = this.hangupInternal();
    return this.hangupPromise;
  }

  private async startInternal(target: CallTarget): Promise<CallHandle> {
    this.emit("connecting");
    try {
      const started = await this.dependencies.startCall(target);
      if (!started.ok) throw proxyError(started);
      this.sessionRef = started.data.sessionRef;
      this.removePageHideListener = this.dependencies.subscribePageHide(() => this.onPageHide());
      if (this.hangupRequested) {
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }

      const token = await this.dependencies.getToken(this.sessionRef);
      if (!token.ok) throw proxyError(token);
      requireUsableToken(token.data, this.dependencies.now());
      if (this.hangupRequested) {
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }

      this.remoteAudio = this.dependencies.createRemoteAudio();
      this.rtcClient = await this.dependencies.createRtcClient(token.data.rtcToken, this.remoteAudio);
      this.bindRtcEvents(this.rtcClient);
      await this.registerRtc(this.rtcClient);
      if (this.hangupRequested) {
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }

      // Arm the incoming handler before triggering Jitter's operator leg.
      this.expectedIncoming = true;
      const connected = await this.dependencies.connect(this.sessionRef);
      if (!connected.ok) throw proxyError(connected);
      return { id: this.sessionRef };
    } catch (error) {
      await this.failAndCancel(error);
      throw error;
    }
  }

  private bindRtcEvents(client: TelnyxRtcLike): void {
    client
      .on("telnyx.ready", () => {
        this.clearRecoveryTimer();
        this.finishRegistration();
      })
      .on("telnyx.socket.close", () => {
        if (!this.terminal && !this.hangupRequested) this.beginRecoveryTimeout();
      })
      .on("telnyx.error", (event) => {
        if (this.terminal || this.hangupRequested) return;
        const code = eventErrorCode(event);
        if (code !== undefined && TELNYX_RECOVERABLE_ERRORS.has(code)) {
          this.beginRecoveryTimeout();
          return;
        }
        if (code === TELNYX_HOLD_FAILED) {
          // The Phase 1 seam has no control-error/rollback event. Failing the
          // call is safer than telling the operator audio is held when it is not.
          void this.failAndCancel(eventError(event));
          return;
        }
        if (code === TELNYX_BYE_SEND_FAILED) return;
        void this.failAndCancel(eventError(event));
      })
      .on("telnyx.warning", (event) => {
        if (warningCode(event) === TELNYX_TOKEN_EXPIRING_SOON) void this.refreshRtcToken();
      })
      .on("telnyx.notification", (notification) => {
        this.handleNotification(notification as TelnyxNotificationLike);
      });
  }

  private async registerRtc(client: TelnyxRtcLike): Promise<void> {
    const registration = new Promise<void>((resolve, reject) => {
      this.resolveRegistration = resolve;
      this.rejectRegistration = reject;
      this.registrationTimer = setTimeout(() => {
        reject(new Error(`Telnyx WebRTC registration timed out after ${this.dependencies.registrationTimeoutMs}ms.`));
        this.clearRegistration();
      }, this.dependencies.registrationTimeoutMs);
    });
    // connect() itself can reject before this method reaches the await below.
    // Keep a handler attached so the later teardown rejection cannot become an
    // unhandled promise while start() is already handling the connect error.
    void registration.catch(() => undefined);
    this.registrationPromise = registration;
    await Promise.resolve(client.connect());
    await registration;
  }

  private finishRegistration(): void {
    const resolve = this.resolveRegistration;
    this.clearRegistration();
    resolve?.();
  }

  private clearRegistration(): void {
    if (this.registrationTimer) clearTimeout(this.registrationTimer);
    this.registrationTimer = null;
    this.registrationPromise = null;
    this.resolveRegistration = null;
    this.rejectRegistration = null;
  }

  private handleNotification(notification: TelnyxNotificationLike): void {
    if (notification.type === "userMediaError") {
      void this.failAndCancel(notification.error ?? new Error("Telnyx microphone access failed."));
      return;
    }
    if (notification.type !== "callUpdate" || !notification.call) return;
    this.handleCallUpdate(notification.call);
  }

  private handleCallUpdate(call: TelnyxCallLike): void {
    const mapped = mapTelnyxCallState(call, this.liveAt !== null);

    if (mapped === "ringing") {
      this.handleIncomingRinging(call);
      return;
    }

    let recovered = false;
    if (this.currentCallId && call.id && call.id !== this.currentCallId) {
      if (call.recoveredCallId !== this.currentCallId) return;
      this.currentCallId = call.id;
      this.currentCall = call;
      recovered = true;
    }
    if (this.currentCall) this.currentCall = call;
    if (this.hangupRequested && isTerminalCallState(call.state)) return;
    this.handleMappedCallState(mapped, call, recovered);
  }

  private handleIncomingRinging(call: TelnyxCallLike): void {
    if (!this.expectedIncoming) return;
    if (!this.currentCallId || this.currentCallId === (call.id ?? this.currentCallId)) {
      this.currentCall = call;
      this.currentCallId = call.id ?? "incoming-call";
    }
    this.emit("ringing");
    if (this.answerStarted) return;
    this.answerStarted = true;
    void Promise.resolve(call.answer()).catch((error) => this.failAndCancel(error));
  }

  private handleMappedCallState(
    mapped: CallTransportState | null,
    call: TelnyxCallLike,
    recovered: boolean,
  ): void {
    if (mapped === "live") {
      if (!this.currentCall) return;
      const firstLive = this.liveAt === null;
      if (firstLive) this.liveAt = this.dependencies.now();
      if (firstLive || recovered) this.applyDesiredControls();
      this.emit("live");
      return;
    }
    if (mapped === "failed") {
      void this.failAndCancel(new Error(call.sipReason?.trim() || call.cause?.trim() || "The Telnyx call failed."));
      return;
    }
    if (mapped === "ended") {
      this.terminal = "ended";
      this.terminalAt ??= this.dependencies.now();
      this.emit("ended");
      void this.cancel("abandoned");
      return;
    }
    if (mapped === "connecting") this.emit("connecting");
  }

  private applyDesiredControls(): void {
    const call = this.currentCall;
    if (!call) return;
    try {
      if (this.desiredMute) call.muteAudio();
      if (this.desiredHold) void Promise.resolve(call.hold()).catch((error) => this.failAndCancel(error));
    } catch (error) {
      void this.failAndCancel(error);
    }
  }

  private async refreshRtcToken(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      if (!this.sessionRef || !this.rtcClient?.login) throw new Error("Telnyx token refresh is unavailable.");
      const token = await this.dependencies.getToken(this.sessionRef);
      if (!token.ok) throw proxyError(token);
      requireUsableToken(token.data, this.dependencies.now());
      await Promise.resolve(this.rtcClient.login({ creds: { login_token: token.data.rtcToken } }));
    })();
    try {
      await this.refreshPromise;
    } catch (error) {
      await this.failAndCancel(error);
    } finally {
      this.refreshPromise = null;
    }
  }

  private async failAndCancel(error: unknown): Promise<void> {
    if (!this.terminal) {
      this.terminal = "failed";
      this.terminalAt ??= this.dependencies.now();
      this.expectedIncoming = false;
      const reject = this.rejectRegistration;
      this.clearRegistration();
      reject?.(error);
      this.emit("failed");
    }
    await this.cancel("failed");
  }

  private async hangupInternal(): Promise<CallResult> {
    this.hangupRequested = true;
    this.expectedIncoming = false;
    this.terminalAt ??= this.dependencies.now();
    try {
      await Promise.resolve(this.currentCall?.hangup());
    } catch {
      // The server-side cancel remains authoritative and idempotent.
    }
    const canceled = await this.cancel("hangup");
    if (!this.terminal) {
      this.terminal = canceled ? "ended" : "failed";
      this.emit(this.terminal);
    }
    return {
      durationSeconds: this.duration(),
      outcome: this.terminal !== "failed" && this.liveAt !== null && canceled
        ? "connected_human"
        : "failed",
    };
  }

  private cancel(reason: JitterCancelReason): Promise<boolean> {
    if (this.cancelPromise) return this.cancelPromise;
    if (!this.sessionRef) {
      this.destroyRtc();
      return Promise.resolve(true);
    }
    this.cancelPromise = (async () => {
      let canceled = true;
      try {
        const result = await this.dependencies.cancel(this.sessionRef!, reason);
        canceled = result.ok;
      } catch {
        canceled = false;
      }
      this.destroyRtc();
      return canceled;
    })();
    return this.cancelPromise;
  }

  private onPageHide(): void {
    if (!this.sessionRef || this.cancelPromise) return;
    this.hangupRequested = true;
    this.expectedIncoming = false;
    this.terminalAt ??= this.dependencies.now();
    try {
      void Promise.resolve(this.currentCall?.hangup()).catch(() => undefined);
    } catch {
      // The beacon/server action remains the teardown path.
    }
    let beaconAccepted = false;
    try {
      beaconAccepted = this.dependencies.sendCancelBeacon(this.sessionRef, "abandoned");
    } catch {
      // Fall through to the authenticated Server Action path.
    }
    if (beaconAccepted) {
      this.cancelPromise = Promise.resolve(true);
      this.destroyRtc();
      return;
    }
    void this.cancel("abandoned");
  }

  private destroyRtc(): void {
    this.removePageHideListener?.();
    this.removePageHideListener = null;
    this.clearRegistration();
    this.clearRecoveryTimer();
    const client = this.rtcClient;
    this.rtcClient = null;
    if (client) void Promise.resolve(client.disconnect()).catch(() => undefined);
    this.remoteAudio?.remove();
    this.remoteAudio = null;
  }

  private emit(state: CallTransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.listener?.(state);
  }

  private duration(): number {
    return this.liveAt === null
      ? 0
      : Math.max(0, Math.floor(((this.terminalAt ?? this.dependencies.now()) - this.liveAt) / 1000));
  }

  private beginRecoveryTimeout(): void {
    if (this.recoveryTimer || this.terminal || this.hangupRequested) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.failAndCancel(new Error("Telnyx WebRTC recovery timed out."));
    }, this.dependencies.registrationTimeoutMs);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }
}

function proxyError(error: { error: string; errorCode: string; reason?: string }): Error {
  const result = new Error(error.reason ?? error.error);
  result.name = error.errorCode;
  return result;
}

function requireUsableToken(token: JitterTokenResponse, now: number): void {
  const expiresAt = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    const error = new Error("Jitter returned an expired browser-audio token.");
    error.name = "rtc_token_expired";
    throw error;
  }
}

function eventError(event: unknown): unknown {
  return event && typeof event === "object" && "error" in event
    ? (event as { error: unknown }).error
    : event;
}

function eventErrorCode(event: unknown): number | undefined {
  const error = eventError(event);
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function isTerminalCallState(state: string | undefined): boolean {
  const normalized = state?.trim().toLowerCase();
  return normalized === "hangup" || normalized === "destroy" || normalized === "purge";
}

function warningCode(event: unknown): number | undefined {
  if (!event || typeof event !== "object" || !("warning" in event)) return undefined;
  const warning = (event as { warning?: { code?: unknown } }).warning;
  return typeof warning?.code === "number" ? warning.code : undefined;
}

async function createTelnyxRtcClient(
  token: string,
  remoteAudio: HTMLAudioElement | null,
): Promise<TelnyxRtcLike> {
  const sdk = await import("@telnyx/webrtc") as unknown as {
    TelnyxRTC: {
      new(options: { login_token: string; keepConnectionAliveOnSocketClose?: boolean }): TelnyxRtcLike;
      webRTCInfo?: () => { supportWebRTCAudio?: boolean } | string;
    };
  };
  const support = sdk.TelnyxRTC.webRTCInfo?.();
  if (typeof support === "string" || support?.supportWebRTCAudio === false) {
    throw new Error("Browser audio is not supported in this browser.");
  }
  const client = new sdk.TelnyxRTC({
    login_token: token,
    keepConnectionAliveOnSocketClose: true,
  });
  if (remoteAudio) client.remoteElement = remoteAudio;
  return client;
}

function createRemoteAudio(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.setAttribute("playsinline", "true");
  audio.hidden = true;
  document.body.append(audio);
  return audio;
}
