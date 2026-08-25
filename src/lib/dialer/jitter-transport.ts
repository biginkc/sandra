import {
  cancelJitterSoftphoneCall,
  cancelJitterSoftphoneCallByStartIntent,
  connectJitterSoftphoneCall,
  getJitterSoftphoneToken,
  reportJitterSoftphoneAudioHealth,
  sendJitterSoftphoneDigit,
  startJitterSoftphoneCall,
} from "./jitter-actions";
import type {
  JitterCancelResponse,
  JitterCancelReason,
  JitterAudioHealthResponse,
  JitterAudioHealthSample,
  JitterConnectPhase,
  JitterProxyResult,
  JitterStartCallResult,
  JitterTokenResponse,
} from "./jitter-contract";
import type {
  CallHandle,
  CallResult,
  CallTarget,
  CallTransport,
  CallTransportState,
  DtmfDigit,
} from "./transport";

const TELNYX_REGISTER_TIMEOUT_MS = 25_000;
const JITTER_START_ACTION_ATTEMPTS = 2;
const JITTER_CANCEL_ATTEMPTS = 3;
const JITTER_CANCEL_BACKOFF_MS = [100, 300] as const;
const JITTER_AUDIO_HEALTH_REPORT_TIMEOUT_MS = 1_500;
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
  peer?: { instance?: RTCPeerConnection | null };
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
  prepareMicrophone(): Promise<void>;
  startCall(
    target: CallTarget,
  ): Promise<JitterStartCallResult>;
  getToken(callId: string): Promise<JitterProxyResult<JitterTokenResponse>>;
  connect(
    callId: string,
    phase: JitterConnectPhase,
  ): Promise<JitterProxyResult<{ dialing: true }>>;
  cancel(
    callId: string,
    reason: JitterCancelReason,
  ): Promise<JitterProxyResult<JitterCancelResponse>>;
  cancelByStartIntent?(
    intentCapability: string,
    reason: JitterCancelReason,
  ): Promise<JitterProxyResult<JitterCancelResponse>>;
  reportAudioHealth(
    callId: string,
    sample: JitterAudioHealthSample,
  ): Promise<JitterProxyResult<JitterAudioHealthResponse>>;
  sendDigit(callId: string, digit: DtmfDigit): Promise<JitterProxyResult<{ sent: true }>>;
  createRtcClient(
    token: string,
    remoteAudio: HTMLAudioElement | null,
  ): Promise<TelnyxRtcLike>;
  createRemoteAudio(): HTMLAudioElement | null;
  subscribePageHide(handler: () => void): () => void;
  sendCancelBeacon(callId: string, reason: JitterCancelReason): boolean;
  sleep(delayMs: number): Promise<void>;
  scheduleAudioHealth(handler: () => void): () => void;
  now(): number;
  registrationTimeoutMs: number;
};

const defaultDependencies: JitterTransportDependencies = {
  prepareMicrophone,
  startCall: startJitterSoftphoneCall,
  getToken: getJitterSoftphoneToken,
  connect: connectJitterSoftphoneCall,
  cancel: cancelJitterSoftphoneCall,
  cancelByStartIntent: cancelJitterSoftphoneCallByStartIntent,
  reportAudioHealth: reportJitterSoftphoneAudioHealth,
  sendDigit: sendJitterSoftphoneDigit,
  createRtcClient: createTelnyxRtcClient,
  createRemoteAudio,
  subscribePageHide(handler) {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  },
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  scheduleAudioHealth(handler) {
    const timer = setInterval(handler, 1_000);
    return () => clearInterval(timer);
  },
  sendCancelBeacon(callId, reason) {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.sendBeacon !== "function"
    )
      return false;
    const body = JSON.stringify({ callId, reason });
    return navigator.sendBeacon(
      "/api/softphone/jitter/cancel",
      new Blob([body], { type: "application/json" }),
    );
  },
  now: () => Date.now(),
  registrationTimeoutMs: TELNYX_REGISTER_TIMEOUT_MS,
};

export function mapTelnyxCallState(
  call: Pick<
    TelnyxCallLike,
    "direction" | "state" | "sipCode" | "sipReason" | "cause"
  >,
  wasLive: boolean,
): CallTransportState | null {
  const state = call.state?.trim().toLowerCase();
  if (isTerminalCallState(state)) {
    return wasLive && (call.sipCode ?? 0) < 400 ? "ended" : "failed";
  }
  if ((call.sipCode ?? 0) >= 400) return "failed";
  if (call.direction === "inbound" && state === "ringing") return "ringing";
  if (state === "active" || state === "held") return "live";
  if (
    state === "requesting" ||
    state === "trying" ||
    state === "answering" ||
    state === "early"
  ) {
    return "connecting";
  }
  return null;
}

export class JitterCallTransport implements CallTransport {
  private listener: ((state: CallTransportState) => void) | null = null;
  private currentState: CallTransportState | null = null;
  private callId: string | null = null;
  private startIntentCapability: string | null = null;
  private startOutcomeAmbiguous = false;
  private rtcClient: TelnyxRtcLike | null = null;
  private currentCall: TelnyxCallLike | null = null;
  private currentCallId: string | null = null;
  private expectedIncoming = false;
  private answerStarted = false;
  private acceptedPromise: Promise<void> | null = null;
  private desiredMute = false;
  private desiredHold = false;
  private holdTransition = false;
  private liveAt: number | null = null;
  private terminalAt: number | null = null;
  private terminal: "ended" | "failed" | null = null;
  private hangupRequested = false;
  private startPromise: Promise<CallHandle> | null = null;
  private hangupPromise: Promise<CallResult> | null = null;
  private digitQueue: Promise<void> = Promise.resolve();
  private digitEpoch = 0;
  private cancelPromise: Promise<boolean> | null = null;
  private lastTeardownConfirmed = true;
  private refreshPromise: Promise<void> | null = null;
  private registrationPromise: Promise<void> | null = null;
  private resolveRegistration: (() => void) | null = null;
  private rejectRegistration: ((error: unknown) => void) | null = null;
  private registrationTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private removePageHideListener: (() => void) | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private stopAudioHealth: (() => void) | null = null;
  private audioHealthControllerId = newControllerId();
  private audioHealthPeer: RTCPeerConnection | null = null;
  private audioHealthPeerGeneration = 0;
  private audioHealthSequence = 0;
  private audioHealthInFlight = false;

  constructor(
    private readonly dependencies: JitterTransportDependencies = defaultDependencies,
  ) {}

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

  async hold(on: boolean): Promise<boolean> {
    if (this.holdTransition) return false;
    const call = this.currentCall;
    if (!call) return false;
    this.holdTransition = true;
    this.digitEpoch += 1;
    try {
      const result = on ? call.hold() : call.unhold();
      await Promise.resolve(result);
      this.desiredHold = on;
      return true;
    } catch (error) {
      await this.failAndCancel(error);
      return false;
    } finally {
      this.holdTransition = false;
    }
  }

  sendDigit(digit: DtmfDigit): Promise<boolean> {
    const queuedEpoch = this.digitEpoch;
    const attempt = this.digitQueue.then(async () => {
      if (
        queuedEpoch !== this.digitEpoch ||
        !this.currentCall ||
        !this.callId ||
        this.currentState !== "live" ||
        this.desiredHold ||
        this.holdTransition ||
        this.terminal ||
        this.hangupRequested ||
        this.cancelPromise
      ) return false;
      const result = await this.dependencies.sendDigit(this.callId, digit).catch(() => null);
      return result?.ok === true;
    });
    this.digitQueue = attempt.then(() => undefined, () => undefined);
    return attempt;
  }

  hangup(): Promise<CallResult> {
    if (!this.hangupPromise) {
      const attempt = this.hangupInternal();
      this.hangupPromise = attempt;
      void attempt.then(
        () => {
          if (!this.lastTeardownConfirmed && this.hangupPromise === attempt) {
            this.hangupPromise = null;
          }
        },
        () => {
          if (this.hangupPromise === attempt) this.hangupPromise = null;
        },
      );
    }
    return this.hangupPromise;
  }

  private async startInternal(target: CallTarget): Promise<CallHandle> {
    this.startIntentCapability = target.intentCapability ?? null;
    this.startOutcomeAmbiguous = false;
    this.emit("connecting");
    try {
      // Ask for microphone access while the call-button gesture is still the
      // active browser interaction. Waiting until Telnyx delivers the
      // operator leg leaves the permission prompt inside the provider's
      // answer timeout, which can terminate the leg as busy before the user
      // has a chance to grant access. Do not provision anything until audio
      // capture is proven available.
      await this.dependencies.prepareMicrophone();
      const started = await this.startCallWithLostResponseRecovery(target);
      this.startOutcomeAmbiguous = started.ambiguous === true;
      if (!started.ok) throw proxyError(started);
      if (this.hangupRequested || this.terminal || this.cancelPromise) {
        // The operator may have ended the attempt while the start response was
        // in flight. Treat that response as ambiguous and never resurrect a
        // late-arriving browser leg after fallback teardown began.
        this.startOutcomeAmbiguous = true;
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }
      this.callId = started.data.callId;
      this.removePageHideListener = this.dependencies.subscribePageHide(() =>
        this.onPageHide(),
      );
      if (this.hangupRequested) {
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }

      const token = await this.dependencies.getToken(this.callId);
      if (!token.ok) throw proxyError(token);
      requireUsableToken(token.data, this.dependencies.now());
      if (this.hangupRequested) {
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }

      this.remoteAudio = this.dependencies.createRemoteAudio();
      this.rtcClient = await this.dependencies.createRtcClient(
        token.data.rtc_token,
        this.remoteAudio,
      );
      this.bindRtcEvents(this.rtcClient);
      await this.registerRtc(this.rtcClient);
      if (this.hangupRequested) {
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }

      // Arm the incoming handler before triggering Jitter's operator leg.
      this.expectedIncoming = true;
      const connected = await this.dependencies.connect(
        this.callId,
        "registered",
      );
      if (!connected.ok) throw proxyError(connected);
      return { id: this.callId };
    } catch (error) {
      await this.failAndCancel(error, proxyFailureState(error));
      throw error;
    }
  }

  private async startCallWithLostResponseRecovery(
    target: CallTarget,
  ): Promise<JitterStartCallResult> {
    let lastResult: JitterStartCallResult | undefined;
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt < JITTER_START_ACTION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const result = await this.dependencies.startCall(target);
        lastResult = result;
        if (result.ok) return result;
        if (result.ambiguous === true || result.status >= 500) continue;
        // Every delivered 4xx is authoritative. It is safe to stop retrying
        // and must not trigger cancel-by-key fallback.
        return { ...result, ambiguous: false };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastResult) return { ...lastResult, ambiguous: true };
    if (lastError instanceof Error) {
      Object.assign(lastError, { ambiguous: true });
      throw lastError;
    }
    return {
      ok: false,
      status: 503,
      error: "Jitter call start response was lost.",
      errorCode: "jitter_unavailable",
      ambiguous: true,
    };
  }

  private bindRtcEvents(client: TelnyxRtcLike): void {
    client
      .on("telnyx.ready", () => {
        this.clearRecoveryTimer();
        this.finishRegistration();
      })
      .on("telnyx.socket.close", () => {
        if (!this.terminal && !this.hangupRequested)
          this.beginRecoveryTimeout();
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
        if (warningCode(event) === TELNYX_TOKEN_EXPIRING_SOON)
          void this.refreshRtcToken();
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
        reject(
          new Error(
            `Telnyx WebRTC registration timed out after ${this.dependencies.registrationTimeoutMs}ms.`,
          ),
        );
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
      void this.failAndCancel(
        notification.error ?? new Error("Telnyx microphone access failed."),
      );
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
    if (this.currentCallId && call.id && this.currentCallId !== call.id) return;
    this.currentCall = call;
    this.currentCallId = call.id ?? "incoming-call";
    this.expectedIncoming = false;
    this.emit("ringing");
    if (this.answerStarted) return;
    this.answerStarted = true;
    void Promise.resolve(call.answer()).catch((error) =>
      this.failAndCancel(error),
    );
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
      if (firstLive) void this.acceptActiveCall(call);
      if (firstLive) this.startAudioHealth();
      this.emit("live");
      return;
    }
    if (mapped === "failed") {
      void this.failAndCancel(
        new Error(
          call.sipReason?.trim() ||
            call.cause?.trim() ||
            "The Telnyx call failed.",
        ),
      );
      return;
    }
    if (mapped === "ended") {
      this.terminal = "ended";
      this.terminalAt ??= this.dependencies.now();
      this.emit("ended");
      void this.cancel("hangup");
      return;
    }
    if (mapped === "connecting") this.emit("connecting");
  }

  private async acceptActiveCall(call: TelnyxCallLike): Promise<void> {
    if (this.acceptedPromise) return this.acceptedPromise;
    if (
      !this.callId ||
      this.currentCall !== call ||
      this.terminal ||
      this.hangupRequested ||
      this.cancelPromise
    )
      return;
    const callId = this.callId;
    this.acceptedPromise = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (
          this.callId !== callId ||
          this.currentCall !== call ||
          this.terminal ||
          this.hangupRequested ||
          this.cancelPromise
        )
          return;
        let accepted: JitterProxyResult<{ dialing: true }>;
        try {
          accepted = await this.dependencies.connect(callId, "accepted");
        } catch (error) {
          if (attempt === 2) throw error;
          continue;
        }
        if (accepted.ok) return;
        if (accepted.status < 500 || attempt === 2) throw proxyError(accepted);
      }
    })();
    try {
      await this.acceptedPromise;
    } catch (error) {
      if (!this.terminal && !this.hangupRequested && !this.cancelPromise) {
        await this.failAndCancel(error);
      }
    }
  }

  private applyDesiredControls(): void {
    const call = this.currentCall;
    if (!call) return;
    try {
      if (this.desiredMute) call.muteAudio();
      if (this.desiredHold)
        void Promise.resolve(call.hold()).catch((error) =>
          this.failAndCancel(error),
        );
    } catch (error) {
      void this.failAndCancel(error);
    }
  }

  private async refreshRtcToken(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const callId = this.callId;
      const client = this.rtcClient;
      if (!callId || !client?.login)
        throw new Error("Telnyx token refresh is unavailable.");
      const token = await this.dependencies.getToken(callId);
      if (!token.ok) throw proxyError(token);
      requireUsableToken(token.data, this.dependencies.now());
      if (
        this.callId !== callId ||
        this.rtcClient !== client ||
        this.terminal ||
        this.hangupRequested ||
        this.cancelPromise
      )
        return;
      await Promise.resolve(
        client.login({ creds: { login_token: token.data.rtc_token } }),
      );
    })();
    try {
      await this.refreshPromise;
    } catch (error) {
      if (!this.terminal && !this.hangupRequested && !this.cancelPromise) {
        await this.failAndCancel(error);
      }
    } finally {
      this.refreshPromise = null;
    }
  }

  private async failAndCancel(
    error: unknown,
    failureState: Extract<CallTransportState, "failed" | "operator_busy" | "not_callable" | "caller_id_unavailable" | "caller_id_inventory_unavailable"> = "failed",
  ): Promise<void> {
    if (error instanceof Error && "ambiguous" in error) {
      this.startOutcomeAmbiguous =
        this.startOutcomeAmbiguous ||
        (error as Error & { ambiguous?: unknown }).ambiguous === true;
    }
    if (!this.terminal) {
      this.terminal = "failed";
      this.terminalAt ??= this.dependencies.now();
      this.expectedIncoming = false;
      const reject = this.rejectRegistration;
      this.clearRegistration();
      reject?.(error);
      this.emit(this.startOutcomeAmbiguous ? "failed" : failureState);
    }
    await this.cancel("failed");
  }

  private async hangupInternal(): Promise<CallResult> {
    this.hangupRequested = true;
    if (!this.callId && this.startPromise) this.startOutcomeAmbiguous = true;
    this.expectedIncoming = false;
    this.terminalAt ??= this.dependencies.now();
    try {
      await Promise.resolve(this.currentCall?.hangup());
    } catch {
      // The server-side cancel remains authoritative and idempotent.
    }
    const canceled = await this.cancel("hangup");
    this.lastTeardownConfirmed = canceled;
    if (!this.terminal) {
      this.terminal = canceled ? "ended" : "failed";
      this.emit(this.terminal);
    }
    return {
      durationSeconds: this.duration(),
      outcome:
        this.terminal !== "failed" && this.liveAt !== null && canceled
          ? "connected_human"
          : "failed",
    };
  }

  private cancel(reason: JitterCancelReason): Promise<boolean> {
    if (this.cancelPromise) return this.cancelPromise;
    if (!this.callId) {
      if (this.startOutcomeAmbiguous && this.startIntentCapability) {
        const intentCapability = this.startIntentCapability;
        const cancelByStartIntent = this.dependencies.cancelByStartIntent;
        if (cancelByStartIntent) {
          const attempt = (async () => {
            for (let index = 0; index < JITTER_CANCEL_ATTEMPTS; index += 1) {
              try {
                const result = await cancelByStartIntent(intentCapability, reason);
                if (result.ok) {
                  const recovered = !this.lastTeardownConfirmed;
                  this.lastTeardownConfirmed = true;
                  this.destroyRtc();
                  if (recovered) this.emit("teardown_confirmed");
                  return true;
                }
              } catch {
                // A thrown/lost Server Action response is unconfirmed.
              }
              const delayMs = JITTER_CANCEL_BACKOFF_MS[index];
              if (delayMs !== undefined) await this.dependencies.sleep(delayMs);
            }
            this.lastTeardownConfirmed = false;
            this.emit("teardown_unconfirmed");
            this.destroyRtc(true);
            return false;
          })();
          this.cancelPromise = attempt;
          void attempt.then(
            (confirmed) => {
              if (!confirmed && this.cancelPromise === attempt)
                this.cancelPromise = null;
            },
            () => {
              this.lastTeardownConfirmed = false;
              if (this.cancelPromise === attempt) this.cancelPromise = null;
            },
          );
          return attempt;
        }
      }
      this.lastTeardownConfirmed = true;
      this.destroyRtc();
      return Promise.resolve(true);
    }
    const callId = this.callId;
    const attempt = (async () => {
      for (let index = 0; index < JITTER_CANCEL_ATTEMPTS; index += 1) {
        try {
          const result = await this.dependencies.cancel(callId, reason);
          if (result.ok) {
            const recovered = !this.lastTeardownConfirmed;
            this.lastTeardownConfirmed = true;
            this.destroyRtc();
            if (recovered) this.emit("teardown_confirmed");
            return true;
          }
        } catch {
          // A thrown/lost Server Action response is just as unconfirmed as a
          // retryable error envelope. The Jitter cancel operation is idempotent.
        }
        const delayMs = JITTER_CANCEL_BACKOFF_MS[index];
        if (delayMs !== undefined) await this.dependencies.sleep(delayMs);
      }
      this.lastTeardownConfirmed = false;
      this.emit("teardown_unconfirmed");
      // Stop media now, but retain the pagehide listener so a later navigation
      // still gets an unload-safe best-effort cancel attempt.
      this.destroyRtc(true);
      return false;
    })();
    this.cancelPromise = attempt;
    void attempt.then(
      (confirmed) => {
        if (!confirmed && this.cancelPromise === attempt)
          this.cancelPromise = null;
      },
      () => {
        this.lastTeardownConfirmed = false;
        if (this.cancelPromise === attempt) this.cancelPromise = null;
      },
    );
    return attempt;
  }

  private onPageHide(): void {
    if (!this.callId) return;
    const cancelInFlight = this.cancelPromise !== null;
    this.hangupRequested = true;
    this.expectedIncoming = false;
    this.terminalAt ??= this.dependencies.now();
    try {
      void Promise.resolve(this.currentCall?.hangup()).catch(() => undefined);
    } catch {
      // The beacon/server action remains the teardown path.
    }
    try {
      // `true` means only that the browser queued the beacon. It is not an
      // acknowledgment from Sandra or Jitter, so the authenticated Server
      // Action remains the confirmation path.
      this.dependencies.sendCancelBeacon(this.callId, "abandoned");
    } catch {
      // Fall through to the authenticated Server Action path.
    }
    if (!cancelInFlight) void this.cancel("abandoned");
  }

  private destroyRtc(preservePageHideListener = false): void {
    this.stopAudioHealth?.();
    this.stopAudioHealth = null;
    this.audioHealthPeer = null;
    if (!preservePageHideListener) {
      this.removePageHideListener?.();
      this.removePageHideListener = null;
    }
    this.clearRegistration();
    this.clearRecoveryTimer();
    const client = this.rtcClient;
    this.rtcClient = null;
    if (client)
      void Promise.resolve(client.disconnect()).catch(() => undefined);
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
      : Math.max(
          0,
          Math.floor(
            ((this.terminalAt ?? this.dependencies.now()) - this.liveAt) / 1000,
          ),
        );
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

  private startAudioHealth(): void {
    if (this.stopAudioHealth) return;
    const sample = () => void this.sampleAudioHealth();
    sample();
    this.stopAudioHealth = this.dependencies.scheduleAudioHealth(sample);
  }

  private async sampleAudioHealth(): Promise<void> {
    if (this.audioHealthInFlight) return;
    const callId = this.callId;
    const call = this.currentCall;
    if (!callId || !call || this.terminal || this.hangupRequested) return;
    this.audioHealthInFlight = true;
    try {
      const peer = call.peer?.instance ?? null;
      if (!peer || peer.connectionState === "closed") return;
      if (this.audioHealthPeer !== peer) {
        this.audioHealthPeer = peer;
        this.audioHealthPeerGeneration += 1;
        this.audioHealthSequence = 0;
      }
      const counters = await inboundAudioCounters(peer).catch(() => undefined);
      if (
        !counters ||
        this.callId !== callId ||
        this.currentCall !== call ||
        this.terminal
      )
        return;
      this.audioHealthSequence += 1;
      await settleBeforeDeadline(
        Promise.resolve()
          .then(() =>
            this.dependencies.reportAudioHealth(callId, {
              controller_id: this.audioHealthControllerId,
              peer_connection_generation: this.audioHealthPeerGeneration,
              sample_sequence: this.audioHealthSequence,
              packets_received: counters.packetsReceived,
              bytes_received: counters.bytesReceived,
            }),
          )
          .catch(() => undefined),
        JITTER_AUDIO_HEALTH_REPORT_TIMEOUT_MS,
      );
    } finally {
      this.audioHealthInFlight = false;
    }
  }
}

async function settleBeforeDeadline(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function inboundAudioCounters(peer: RTCPeerConnection): Promise<
  | {
      packetsReceived: number;
      bytesReceived: number;
    }
  | undefined
> {
  const report = await peer.getStats();
  let found = false;
  let packetsReceived = 0;
  let bytesReceived = 0;
  report.forEach((stat) => {
    if (stat.type !== "inbound-rtp" || stat.isRemote === true) return;
    const kind = stat.kind ?? stat.mediaType;
    if (kind !== "audio") return;
    found = true;
    packetsReceived += safeCounter(stat.packetsReceived);
    bytesReceived += safeCounter(stat.bytesReceived);
  });
  return found ? { packetsReceived, bytesReceived } : undefined;
}

function safeCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function newControllerId(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "00000000-0000-4000-8000-000000000001";
}

async function prepareMicrophone(): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error("Microphone access is required to place calls.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error("Microphone access is required to place calls.");
  }
  for (const track of stream.getTracks()) track.stop();
}

function proxyError(error: {
  error: string;
  errorCode: string;
  reason?: string;
  ambiguous?: boolean;
}): Error {
  const result = new Error(error.reason ?? error.error);
  result.name = error.errorCode;
  Object.assign(result, {
    ambiguous: error.ambiguous === true,
  });
  return result;
}

function proxyFailureState(
  error: unknown,
): Extract<CallTransportState, "failed" | "operator_busy" | "not_callable" | "caller_id_unavailable" | "caller_id_inventory_unavailable"> {
  if (error instanceof Error && error.name === "operator_busy")
    return "operator_busy";
  if (error instanceof Error && error.name === "not_callable")
    return "not_callable";
  if (error instanceof Error && error.name === "caller_id_unavailable")
    return "caller_id_unavailable";
  if (
    error instanceof Error &&
    error.name === "caller_id_inventory_unavailable"
  )
    return "caller_id_inventory_unavailable";
  return "failed";
}

function requireUsableToken(token: JitterTokenResponse, now: number): void {
  const expiresAt = Date.parse(token.expires_at);
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
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function isTerminalCallState(state: string | undefined): boolean {
  const normalized = state?.trim().toLowerCase();
  return (
    normalized === "hangup" ||
    normalized === "destroy" ||
    normalized === "purge"
  );
}

function warningCode(event: unknown): number | undefined {
  if (!event || typeof event !== "object" || !("warning" in event))
    return undefined;
  const warning = (event as { warning?: { code?: unknown } }).warning;
  return typeof warning?.code === "number" ? warning.code : undefined;
}

async function createTelnyxRtcClient(
  token: string,
  remoteAudio: HTMLAudioElement | null,
): Promise<TelnyxRtcLike> {
  const sdk = (await import("@telnyx/webrtc")) as unknown as {
    TelnyxRTC: {
      new (options: {
        login_token: string;
        keepConnectionAliveOnSocketClose?: boolean;
      }): TelnyxRtcLike;
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
