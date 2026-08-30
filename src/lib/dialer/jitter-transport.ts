import {
  cancelJitterSoftphoneCall,
  cancelJitterSoftphoneCallByStartIntent,
  connectJitterSoftphoneCall,
  getJitterSoftphoneToken,
  getJitterSoftphoneProviderStatus,
  recoverJitterSoftphoneAudio,
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
  JitterProviderStatusResponse,
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
const JITTER_AUDIO_HEALTH_RESUME_FAILURE_LIMIT = 3;
const JITTER_PROVIDER_PROOF_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000, 10_000] as const;
const JITTER_RECOVERY_CONTROL_ATTEMPTS = 3;
const TELNYX_TOKEN_EXPIRING_SOON = 34_001;
const TELNYX_HOLD_FAILED = 44_001;
const TELNYX_BYE_SEND_FAILED = 44_003;
const TELNYX_RECONNECTION_EXHAUSTED = 45_003;
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
  /** Pinned SDK socket-only reconnect primitive; does not purge calls or send BYE. */
  socketDisconnect?(): void;
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
  getProviderStatus(callId: string): Promise<JitterProxyResult<JitterProviderStatusResponse>>;
  recoverAudio(callId: string): Promise<JitterProxyResult<{ recovering: true }>>;
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
  getProviderStatus: getJitterSoftphoneProviderStatus,
  recoverAudio: recoverJitterSoftphoneAudio,
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
  private rehydrating = false;
  private acceptedPromise: Promise<void> | null = null;
  private desiredMute = false;
  private desiredHold = false;
  private holdCapability = false;
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
  private providerProofRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private providerProofInFlight = false;
  private providerProofGeneration = 0;
  private localTerminalProofCall: TelnyxCallLike | null = null;
  private removePageHideListener: (() => void) | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private removeRemoteAudioDiagnostics: (() => void) | null = null;
  private stopAudioHealth: (() => void) | null = null;
  private audioHealthControllerId = newControllerId();
  private audioHealthPeer: RTCPeerConnection | null = null;
  private audioHealthPeerGeneration = 0;
  private audioHealthSequence = 0;
  private audioHealthInFlight: Promise<void> | null = null;
  private audioHealthQueued = false;
  private audioHealthResumeBaselinePending = false;
  private audioHealthResumeFailures = 0;
  private audioRecoveryRequired = false;
  private audioReconnectPromise: Promise<boolean> | null = null;
  private recoveryControlsCall: TelnyxCallLike | null = null;
  private recoveryControlsPromise: Promise<void> | null = null;

  constructor(
    private readonly dependencies: JitterTransportDependencies = defaultDependencies,
  ) {}

  onStateChange(cb: (state: CallTransportState) => void): void {
    this.listener = cb;
  }

  callHandle(): CallHandle | null {
    return this.callId ? { id: this.callId } : null;
  }

  start(target: CallTarget): Promise<CallHandle> {
    if (!this.startPromise) this.startPromise = this.startInternal(target);
    return this.startPromise;
  }

  async recover(handle: CallHandle, startedAt: string): Promise<CallHandle> {
    if (this.callId || this.startPromise) throw new Error("A softphone call is already owned.");
    this.callId = handle.id;
    this.liveAt = Number.isFinite(Date.parse(startedAt))
      ? Date.parse(startedAt)
      : this.dependencies.now();
    this.rehydrating = true;
    this.removePageHideListener = this.dependencies.subscribePageHide(() => this.onPageHide());
    this.audioRecoveryRequired = true;
    this.emit("audio_reconnect_required");
    try {
      await this.dependencies.prepareMicrophone();
      const token = await this.dependencies.getToken(handle.id);
      if (!token.ok) throw proxyError(token);
      requireUsableToken(token.data, this.dependencies.now());
      this.holdCapability = token.data.capabilities?.audio_health_media_state === "v1";
      this.remoteAudio = this.dependencies.createRemoteAudio();
      this.removeRemoteAudioDiagnostics = this.bindRemoteAudioDiagnostics(this.remoteAudio);
      this.rtcClient = await this.dependencies.createRtcClient(token.data.rtc_token, this.remoteAudio);
      this.bindRtcEvents(this.rtcClient);
      await this.registerRtc(this.rtcClient);
      // A retained provider leg may already be terminal and therefore never
      // Attach back to the new browser session. Reconcile exact Jitter proof
      // independently of SDK callUpdate so reload cannot orphan bookkeeping.
      void this.reconcileRetainedProviderProof(handle.id);
      return handle;
    } catch (error) {
      this.requireAudioReconnect(error);
      return handle;
    }
  }

  mute(on: boolean): void {
    this.desiredMute = on;
    const call = this.currentCall;
    if (!call) return;
    try {
      if (on) call.muteAudio();
      else call.unmuteAudio();
    } catch (error) {
      this.handleOperationalFailure(error);
    }
  }

  reconnectAudio(): Promise<boolean> {
    if (
      !this.audioRecoveryRequired ||
      this.liveAt === null ||
      this.terminal ||
      this.hangupRequested ||
      !this.rtcClient
    ) return Promise.resolve(false);
    if (this.audioReconnectPromise) return this.audioReconnectPromise;
    const client = this.rtcClient;
    const attempt = (async () => {
      this.emit("audio_reconnecting");
      this.clearRecoveryTimer();
      try {
        await this.dependencies.prepareMicrophone();
        if (
          this.rtcClient !== client ||
          this.terminal ||
          this.hangupRequested
        ) return false;
        if (!client.socketDisconnect) {
          throw new Error("Telnyx socket-only recovery is unavailable.");
        }
        const callId = this.callId;
        if (!callId) return false;
        const recovery = await this.dependencies.recoverAudio(callId);
        if (!recovery.ok) throw proxyError(recovery);
        // In 2.27.1 this invokes only _closeConnection(). With
        // keepConnectionAliveOnSocketClose enabled the SDK reconnects the same
        // BrowserSession and handles the server Attach without Purge or BYE.
        client.socketDisconnect();
        this.beginRecoveryTimeout();
        this.expectedIncoming = true;
        this.answerStarted = false;
        const connected = await this.dependencies.connect(callId, "registered");
        if (!connected.ok) throw proxyError(connected);
        return true;
      } catch (error) {
        this.requireAudioReconnect(error);
        return false;
      }
    })();
    this.audioReconnectPromise = attempt;
    void attempt.finally(() => {
      if (this.audioReconnectPromise === attempt) this.audioReconnectPromise = null;
    });
    return attempt;
  }

  async hold(on: boolean): Promise<boolean> {
    if (!this.holdCapability) {
      this.emit("hold_reload_required");
      return false;
    }
    if (this.holdTransition) return false;
    let call = this.currentCall;
    if (!call) return false;
    const initialCall = call;
    this.holdTransition = true;
    this.digitEpoch += 1;
    let changed = false;
    try {
      for (let attempt = 0; attempt < JITTER_RECOVERY_CONTROL_ATTEMPTS; attempt += 1) {
        const result = await Promise.resolve(on ? call.hold() : call.unhold());
        // The pinned Telnyx SDK catches provider control errors and resolves
        // `false` instead of rejecting. Treat that concrete return contract as
        // a failed control operation so the UI and health state stay truthful.
        if (result === false) return false;
        const replacement = this.currentCall;
        if (!replacement) return false;
        if (replacement === call) break;
        call = replacement;
        if (attempt === JITTER_RECOVERY_CONTROL_ATTEMPTS - 1) {
          this.requireAudioReconnect(
            new Error("Telnyx call recovery did not stabilize during hold control."),
          );
          return false;
        }
      }
      this.desiredHold = on;
      this.audioHealthResumeBaselinePending = !on;
      this.audioHealthResumeFailures = 0;
      changed = true;
      return true;
    } catch {
      return false;
    } finally {
      this.holdTransition = false;
      // Provider control and durable watchdog state cannot be one transaction.
      // Report immediately after provider acknowledgement; Jitter's latch is
      // non-terminating if the watchdog linearizes inside this narrow window.
      const replacement = this.currentCall;
      if (!changed && replacement && replacement !== initialCall) {
        void this.completeRecoveredCall(replacement);
      }
      if (changed) {
        if (!on && !hasUsablePeer(this.currentCall)) this.beginRecoveryTimeout();
        await this.sampleAudioHealth();
      }
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
      this.holdCapability = token.data.capabilities?.audio_health_media_state === "v1";
      if (this.hangupRequested) {
        await this.cancel("hangup");
        throw new Error("Call start was canceled.");
      }

      this.remoteAudio = this.dependencies.createRemoteAudio();
      this.removeRemoteAudioDiagnostics = this.bindRemoteAudioDiagnostics(this.remoteAudio);
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
      if (
        this.liveAt !== null &&
        this.callId &&
        !this.terminal &&
        !this.hangupRequested &&
        !this.cancelPromise
      ) {
        this.handleOperationalFailure(error);
        return { id: this.callId };
      }
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
        // An explicit ambiguous:false is authoritative regardless of status —
        // delivered 4xx and deterministic config 5xx never retry and never
        // trigger cancel-by-key fallback.
        if (result.ambiguous === false) return result;
        if (result.ambiguous === true || result.status >= 500) continue;
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
        if (this.rtcClient !== client) return;
        if (this.liveAt === null) this.clearRecoveryTimer();
        this.finishRegistration();
      })
      .on("telnyx.socket.close", () => {
        if (this.rtcClient !== client) return;
        if (!this.terminal && !this.hangupRequested)
          this.beginRecoveryTimeout();
      })
      .on("telnyx.error", (event) => {
        if (this.rtcClient !== client) return;
        if (this.terminal || this.hangupRequested) return;
        const code = eventErrorCode(event);
        if (code !== undefined && TELNYX_RECOVERABLE_ERRORS.has(code)) {
          this.beginRecoveryTimeout();
          return;
        }
        if (code === TELNYX_RECONNECTION_EXHAUSTED) {
          this.requireAudioReconnect(eventError(event));
          return;
        }
        if (code === TELNYX_HOLD_FAILED) {
          // The hold/unhold promise is authoritative for the control state.
          // A failed hold must never tear down an otherwise healthy live call.
          return;
        }
        if (code === TELNYX_BYE_SEND_FAILED) return;
        this.handleOperationalFailure(eventError(event));
      })
      .on("telnyx.warning", (event) => {
        if (this.rtcClient !== client) return;
        if (warningCode(event) === TELNYX_TOKEN_EXPIRING_SOON)
          void this.refreshRtcToken();
      })
      .on("telnyx.notification", (notification) => {
        if (this.rtcClient !== client) return;
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
      this.handleOperationalFailure(
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
    if (
      !this.currentCall &&
      this.rehydrating &&
      (mapped === "live" || mapped === "ended" || mapped === "failed")
    ) {
      if (call.state?.trim().toLowerCase() === "held") {
        this.desiredHold = true;
        this.audioHealthResumeBaselinePending = false;
        this.emit("hold_restored");
      }
      this.currentCall = call;
      this.currentCallId = call.id ?? "recovered-call";
      recovered = true;
    }
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
    if (
      this.currentCallId &&
      call.id &&
      this.currentCallId !== call.id &&
      this.currentState !== "audio_reconnecting"
    ) return;
    this.currentCall = call;
    this.currentCallId = call.id ?? "incoming-call";
    this.expectedIncoming = false;
    this.emit("ringing");
    if (this.answerStarted) return;
    this.answerStarted = true;
    void Promise.resolve(call.answer()).catch((error) =>
      this.handleOperationalFailure(error),
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
      if (firstLive) void this.applyDesiredControls(call);
      if (firstLive) void this.acceptActiveCall(call);
      if (firstLive) this.startAudioHealth();
      if (firstLive) {
        void this.markAudioRecovered(call);
      } else if (recovered || this.recoveryTimer || this.audioRecoveryRequired) {
        this.beginRecoveryTimeout();
        if (hasUsablePeer(call)) void this.completeRecoveredCall(call);
      } else {
        this.emit("live");
      }
      return;
    }
    if (mapped === "failed") {
      if (this.liveAt !== null) {
        if (isTerminalCallState(call.state)) {
          void this.reconcileLocalSdkTerminal(call, "failed");
          return;
        }
        this.handleOperationalFailure(
          new Error(
            call.sipReason?.trim() ||
              call.cause?.trim() ||
              "Telnyx reported a recoverable live-call failure.",
          ),
        );
        return;
      }
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
      if (this.liveAt !== null) {
        void this.reconcileLocalSdkTerminal(call, "ended");
        return;
      }
      this.terminal = "ended";
      this.terminalAt ??= this.dependencies.now();
      this.emit("ended");
      void this.cancel("hangup");
      return;
    }
    if (mapped === "connecting") this.emit("connecting");
  }

  private async reconcileLocalSdkTerminal(
    call: TelnyxCallLike,
    outcome: "ended" | "failed",
  ): Promise<void> {
    const callId = this.callId;
    if (!callId || this.currentCall !== call || this.terminal || this.hangupRequested)
      return;
    this.localTerminalProofCall = call;
    const proofGeneration = ++this.providerProofGeneration;
    if (this.providerProofRetryTimer) clearTimeout(this.providerProofRetryTimer);
    this.providerProofRetryTimer = null;
    this.providerProofInFlight = true;
    try {
      for (let attempt = 0; attempt <= JITTER_PROVIDER_PROOF_BACKOFF_MS.length; attempt += 1) {
      let result: JitterProxyResult<JitterProviderStatusResponse> | undefined;
      try {
        result = await this.dependencies.getProviderStatus(callId);
      } catch {
        // A lost proof response is not terminal proof.
      }
      if (this.callId !== callId || this.currentCall !== call || this.providerProofGeneration !== proofGeneration || this.terminal || this.hangupRequested)
        return;
      if (result?.ok && result.data.state === "terminal") {
        const exactOutcome = result.data.outcome ?? outcome;
        this.terminal = exactOutcome;
        this.terminalAt ??= this.dependencies.now();
        this.emit(exactOutcome);
        // Signed Jitter state tied to this exact call proves the destination
        // provider leg terminal. No second cancel is sent.
        this.destroyRtc();
        return;
      }
      // Active can be a briefly stale observation while the signed provider
      // callback/reconciliation transaction is still converging.
      const delayMs = JITTER_PROVIDER_PROOF_BACKOFF_MS[attempt];
      if (delayMs !== undefined) await this.dependencies.sleep(delayMs);
      }
      this.requireAudioReconnect(
        new Error("Local Telnyx call cleanup was not authoritative provider termination."),
      );
      if (this.providerProofGeneration === proofGeneration)
        this.scheduleProviderProofRetry(call, outcome);
    } finally {
      if (this.providerProofGeneration === proofGeneration) this.providerProofInFlight = false;
    }
  }

  private scheduleProviderProofRetry(
    call: TelnyxCallLike,
    outcome: "ended" | "failed",
  ): void {
    if (this.providerProofRetryTimer || this.currentCall !== call || this.terminal || this.hangupRequested)
      return;
    this.providerProofRetryTimer = setTimeout(() => {
      this.providerProofRetryTimer = null;
      if (this.currentCall === call && !this.terminal && !this.hangupRequested)
        void this.reconcileLocalSdkTerminal(call, outcome);
    }, 10_000);
  }

  private async reconcileRetainedProviderProof(callId: string): Promise<void> {
    if (this.providerProofInFlight || this.callId !== callId || this.terminal || this.hangupRequested)
      return;
    this.providerProofInFlight = true;
    const proofGeneration = this.providerProofGeneration;
    try {
      for (let attempt = 0; attempt <= JITTER_PROVIDER_PROOF_BACKOFF_MS.length; attempt += 1) {
        let result: JitterProxyResult<JitterProviderStatusResponse> | undefined;
        try {
          result = await this.dependencies.getProviderStatus(callId);
        } catch {
          // Missing proof is recoverable and retried persistently.
        }
        if (
          this.callId !== callId ||
          this.providerProofGeneration !== proofGeneration ||
          this.terminal ||
          this.hangupRequested
        ) return;
        if (result?.ok && result.data.state === "terminal") {
          const outcome = result.data.outcome ?? "ended";
          this.terminal = outcome;
          this.terminalAt ??= this.dependencies.now();
          this.emit(outcome);
          this.destroyRtc();
          return;
        }
        const delayMs = JITTER_PROVIDER_PROOF_BACKOFF_MS[attempt];
        if (delayMs !== undefined) await this.dependencies.sleep(delayMs);
      }
      if (this.providerProofGeneration !== proofGeneration) return;
      this.requireAudioReconnect(new Error("Retained call provider proof is still pending."));
      if (!this.providerProofRetryTimer && this.callId === callId && this.providerProofGeneration === proofGeneration && !this.terminal && !this.hangupRequested) {
        this.providerProofRetryTimer = setTimeout(() => {
          this.providerProofRetryTimer = null;
          void this.reconcileRetainedProviderProof(callId);
        }, 10_000);
      }
    } finally {
      if (this.providerProofGeneration === proofGeneration) this.providerProofInFlight = false;
    }
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
        this.handleOperationalFailure(error);
      }
    }
  }

  private async completeRecoveredCall(call: TelnyxCallLike): Promise<void> {
    if (this.recoveryControlsCall === call && this.recoveryControlsPromise) {
      return this.recoveryControlsPromise;
    }
    const attempt = this.completeRecoveredCallOnce(call);
    this.recoveryControlsCall = call;
    this.recoveryControlsPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.recoveryControlsPromise === attempt) {
        this.recoveryControlsCall = null;
        this.recoveryControlsPromise = null;
      }
    }
  }

  private async completeRecoveredCallOnce(call: TelnyxCallLike): Promise<void> {
    if (this.holdTransition) return;
    const peer = call.peer?.instance ?? null;
    if (this.currentCall !== call || !peer) return;
    let providerHeld = call.state?.trim().toLowerCase() === "held";
    if (providerHeld && !this.desiredHold) {
      // A recovered leg may still reflect the provider's old held truth. Apply
      // the desired resume first; only then can advancing RTP prove recovery.
      if (!await this.applyDesiredControls(call)) return;
      if (this.currentCall !== call || call.peer?.instance !== peer) return;
      providerHeld = call.state?.trim().toLowerCase() === "held";
    }
    const heldMediaProven = this.desiredHold && providerHeld &&
      peer.connectionState === "connected" &&
      hasLiveInboundAudioTrack(peer);
    if (!heldMediaProven && !await proveUsableInboundMedia(peer, this.dependencies.sleep)) return;
    if (this.currentCall !== call || call.peer?.instance !== peer) return;
    const controlsReconciled = await this.applyDesiredControls(call);
    if (
      controlsReconciled &&
      this.currentCall === call &&
      call.peer?.instance === peer &&
      this.localTerminalProofCall !== call &&
      !this.terminal &&
      !this.hangupRequested
    ) {
      this.rehydrating = false;
      this.startAudioHealth();
      await this.markAudioRecovered(call);
    }
  }

  private async applyDesiredControls(call: TelnyxCallLike): Promise<boolean> {
    if (this.currentCall !== call) return false;
    if (this.desiredMute) {
      try {
        call.muteAudio();
      } catch (error) {
        this.handleOperationalFailure(error);
        return false;
      }
    }
    // The operator control in flight owns replacement-leg reconciliation. It
    // observes currentCall after every acknowledgement before reporting success.
    if (this.holdTransition) return false;
    const providerHeld = call.state?.trim().toLowerCase() === "held";
    if (this.desiredHold === providerHeld) return true;
    const wantedHeld = this.desiredHold;
    try {
      const result = await Promise.resolve(
        wantedHeld ? call.hold() : call.unhold(),
      );
      if (result === false) throw new Error("Telnyx rejected recovered hold state.");
      return true;
    } catch {
      if (this.currentCall !== call) return false;
      // Media is usable, so provider truth wins and is reported immediately.
      this.desiredHold = !wantedHeld;
      this.audioHealthResumeBaselinePending = wantedHeld;
      this.audioHealthResumeFailures = 0;
      this.emit(wantedHeld ? "hold_reapply_failed" : "resume_reapply_failed");
      void this.sampleAudioHealth();
      return false;
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
      this.holdCapability = token.data.capabilities?.audio_health_media_state === "v1";
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
        this.handleOperationalFailure(error);
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

  private handleOperationalFailure(error: unknown): void {
    if (this.liveAt !== null && !this.terminal && !this.hangupRequested) {
      this.requireAudioReconnect(error);
      return;
    }
    void this.failAndCancel(error);
  }

  private requireAudioReconnect(error: unknown): void {
    if (this.liveAt === null || this.terminal || this.hangupRequested) {
      void this.failAndCancel(error);
      return;
    }
    this.clearRecoveryTimer();
    this.audioRecoveryRequired = true;
    this.emit("audio_reconnect_required");
  }

  private async markAudioRecovered(call: TelnyxCallLike): Promise<boolean> {
    const peer = call.peer?.instance ?? null;
    try {
      const playback = this.remoteAudio?.play?.();
      if (playback) await playback;
    } catch (error) {
      this.requireAudioReconnect(error);
      return false;
    }
    if (
      this.currentCall !== call ||
      (call.peer?.instance ?? null) !== peer ||
      this.localTerminalProofCall === call ||
      this.terminal ||
      this.hangupRequested
    ) return false;
    this.clearRecoveryTimer();
    this.providerProofGeneration += 1;
    if (this.providerProofRetryTimer) clearTimeout(this.providerProofRetryTimer);
    this.providerProofRetryTimer = null;
    this.audioRecoveryRequired = false;
    this.emit("live");
    return true;
  }

  private bindRemoteAudioDiagnostics(audio: HTMLAudioElement | null): (() => void) | null {
    if (!audio) return null;
    const degraded = () => {
      if (this.liveAt !== null && !this.terminal && !this.hangupRequested)
        this.requireAudioReconnect(new Error("Remote browser audio playback was interrupted."));
    };
    for (const event of ["pause", "stalled", "error", "abort"])
      audio.addEventListener(event, degraded);
    return () => {
      for (const event of ["pause", "stalled", "error", "abort"])
        audio.removeEventListener(event, degraded);
    };
  }

  private async hangupInternal(): Promise<CallResult> {
    if (this.terminal) {
      if (!this.lastTeardownConfirmed) {
        const confirmed = await this.cancel("hangup");
        if (confirmed) this.emit("teardown_confirmed");
      }
      return {
        durationSeconds: this.duration(),
        outcome: this.terminal === "ended" && this.liveAt !== null
          ? "connected_human"
          : "failed",
      };
    }
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
        // An ambiguous start with no fallback available must fail closed:
        // Jitter may hold a provisioned call this browser can no longer reach.
        this.lastTeardownConfirmed = false;
        this.emit("teardown_unconfirmed");
        this.destroyRtc(true);
        return Promise.resolve(false);
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
    if (this.liveAt !== null && !this.terminal && !this.hangupRequested) {
      // Browser navigation is not an operator hangup and is not authoritative
      // provider termination. Leave the provider leg and Jitter call active;
      // a restored page may reconnect its browser audio explicitly.
      this.requireAudioReconnect(
        new Error("Browser audio detached while the homeowner call remained live."),
      );
      return;
    }
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
    this.audioHealthResumeBaselinePending = false;
    this.audioHealthResumeFailures = 0;
    this.audioRecoveryRequired = false;
    this.removeRemoteAudioDiagnostics?.();
    this.removeRemoteAudioDiagnostics = null;
    if (!preservePageHideListener) {
      this.removePageHideListener?.();
      this.removePageHideListener = null;
    }
    this.clearRegistration();
    this.clearRecoveryTimer();
    if (this.providerProofRetryTimer) clearTimeout(this.providerProofRetryTimer);
    this.providerProofRetryTimer = null;
    const client = this.rtcClient;
    this.rtcClient = null;
    if (client)
      void Promise.resolve(client.disconnect()).catch(() => undefined);
    this.remoteAudio?.remove();
    this.remoteAudio = null;
  }

  private emit(state: CallTransportState): void {
    const informational = state === "hold_reload_required" ||
      state === "hold_sync_pending" ||
      state === "resume_sync_pending" ||
      state === "hold_restored" ||
      state === "hold_reapply_failed" ||
      state === "resume_reapply_failed";
    if (!informational && this.currentState === state) return;
    if (informational) {
      this.listener?.(state);
      return;
    }
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
      this.handleOperationalFailure(new Error("Telnyx WebRTC recovery timed out."));
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
    if (this.holdTransition) return;
    if (this.audioHealthInFlight) {
      this.audioHealthQueued = true;
      await this.audioHealthInFlight;
      return;
    }
    const attempt = (async () => {
      do {
        this.audioHealthQueued = false;
        await this.sampleAudioHealthOnce();
      } while (this.audioHealthQueued && !this.holdTransition);
    })();
    this.audioHealthInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.audioHealthInFlight === attempt) this.audioHealthInFlight = null;
    }
  }

  private async sampleAudioHealthOnce(): Promise<void> {
    const callId = this.callId;
    const call = this.currentCall;
    if (!callId || !call || this.terminal || this.hangupRequested) return;
    try {
      const peer = call.peer?.instance ?? null;
      if (!peer || peer.connectionState === "closed") {
        if (this.audioHealthResumeBaselinePending) this.beginRecoveryTimeout();
        return;
      }
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
      const mediaState = this.desiredHold
        ? "held"
        : this.audioHealthResumeBaselinePending
          ? "resumed"
          : "active";
      let resumeAccepted = false;
      let reportAccepted = false;
      let reportedStatus: JitterAudioHealthResponse["status"];
      await settleBeforeDeadline(
        Promise.resolve()
          .then(async () => {
            const result = await this.dependencies.reportAudioHealth(callId, {
              media_state: mediaState,
              controller_id: this.audioHealthControllerId,
              peer_connection_generation: this.audioHealthPeerGeneration,
              sample_sequence: this.audioHealthSequence,
              packets_received: counters.packetsReceived,
              bytes_received: counters.bytesReceived,
            });
            if (result.ok) {
              reportedStatus = result.data.status;
              reportAccepted = result.data.accepted;
            }
            resumeAccepted = result.ok && result.data.accepted && result.data.status !== "suspect";
          })
          .catch(() => undefined),
        JITTER_AUDIO_HEALTH_REPORT_TIMEOUT_MS,
      );
      if (
        this.callId !== callId ||
        this.currentCall !== call ||
        call.peer?.instance !== peer ||
        this.terminal ||
        this.hangupRequested
      ) return;
      if (mediaState === "held" && !reportAccepted) this.emit("hold_sync_pending");
      if (mediaState === "resumed" && !reportAccepted) this.emit("resume_sync_pending");
      if (mediaState !== "held" && reportedStatus === "suspect") {
        this.requireAudioReconnect(
          new Error("Jitter detected stalled or missing browser audio."),
        );
      }
      if (
        mediaState === "resumed" &&
        resumeAccepted &&
        this.callId === callId &&
        this.currentCall === call &&
        !this.desiredHold
      ) {
        this.audioHealthResumeBaselinePending = false;
        this.audioHealthResumeFailures = 0;
      } else if (
        mediaState === "resumed" &&
        this.callId === callId &&
        this.currentCall === call &&
        !this.desiredHold
      ) {
        this.audioHealthResumeFailures += 1;
        if (this.audioHealthResumeFailures >= JITTER_AUDIO_HEALTH_RESUME_FAILURE_LIMIT) {
          this.requireAudioReconnect(
            new Error("Jitter did not acknowledge the resumed audio baseline."),
          );
        }
      }
    } finally {
      // The outer sampler owns the in-flight promise and release.
    }
  }
}

function hasUsablePeer(call: TelnyxCallLike | null): boolean {
  return call?.peer?.instance?.connectionState === "connected";
}

async function proveUsableInboundMedia(
  peer: RTCPeerConnection,
  sleep: (delayMs: number) => Promise<void>,
): Promise<boolean> {
  if (peer.connectionState !== "connected") return false;
  if (!hasLiveInboundAudioTrack(peer)) return false;
  const before = await inboundAudioCounters(peer).catch(() => undefined);
  if (!before) return false;
  await sleep(250);
  if (peer.connectionState !== "connected") return false;
  const after = await inboundAudioCounters(peer).catch(() => undefined);
  return Boolean(
    after &&
      (after.packetsReceived > before.packetsReceived ||
        after.bytesReceived > before.bytesReceived),
  );
}

function hasLiveInboundAudioTrack(peer: RTCPeerConnection): boolean {
  return peer.getReceivers?.().some((receiver) => {
    const track = receiver.track;
    return track?.kind === "audio" && track.readyState === "live" && track.enabled;
  }) ?? false;
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
        hangupOnBeforeUnload?: boolean;
      }): TelnyxRtcLike;
      webRTCInfo?: () => { supportWebRTCAudio?: boolean } | string;
    };
  };
  const support = sdk.TelnyxRTC.webRTCInfo?.();
  if (typeof support === "string" || support?.supportWebRTCAudio === false) {
    throw new Error("Browser audio is not supported in this browser.");
  }
  const client = new sdk.TelnyxRTC(telnyxRtcClientOptions(token));
  if (remoteAudio) client.remoteElement = remoteAudio;
  return client;
}

export function telnyxRtcClientOptions(token: string): {
  login_token: string;
  keepConnectionAliveOnSocketClose: true;
  hangupOnBeforeUnload: false;
} {
  return {
    login_token: token,
    keepConnectionAliveOnSocketClose: true,
    // The SDK defaults this to true. A browser lifecycle event is not proof
    // that either participant ended the connected provider call.
    hangupOnBeforeUnload: false,
  };
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
