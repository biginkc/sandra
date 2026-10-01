import type {
  DirectActionResult,
  DirectCallControl,
  DirectCallStatus,
  DirectCallStatusView,
  DirectRtcToken,
  StartDirectCallInput,
  StartDirectCallResult,
} from "@/lib/direct-calling/contract";
import { DIRECT_CALL_TERMINAL_STATUSES } from "@/lib/direct-calling/contract";
import {
  controlDirectCall,
  getDirectCallStatus,
  getDirectRtcToken,
  startDirectCall,
} from "@/lib/direct-calling/client-actions";

import type {
  CallHandle,
  CallResult,
  CallTarget,
  CallTransport,
  CallTransportState,
  DtmfDigit,
  ProviderStatusPollError,
} from "./transport";

const REGISTER_TIMEOUT_MS = 25_000;
const STATUS_POLL_MS = 1_000;
const HANGUP_CONFIRM_ATTEMPTS = 8;
const HANGUP_CONFIRM_MS = 500;
const CORRELATION_HEADER = "x-sandra-direct-call-id";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TelnyxCallLike = {
  id?: string;
  direction?: string;
  state?: string;
  telnyxIDs?: { telnyxCallControlId?: string };
  options?: { customHeaders?: Array<{ name?: string; value?: string }> };
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
  on(eventName: string, handler: (...args: unknown[]) => void): TelnyxRtcLike;
};

type TelnyxNotificationLike = {
  type?: string;
  call?: TelnyxCallLike;
  error?: unknown;
};

export type DirectTransportDependencies = {
  prepareMicrophone(): Promise<void>;
  getToken(): Promise<DirectActionResult<DirectRtcToken>>;
  startCall(
    input: StartDirectCallInput,
  ): Promise<DirectActionResult<StartDirectCallResult>>;
  getStatus(id: string): Promise<DirectActionResult<DirectCallStatusView>>;
  control(
    id: string,
    control: DirectCallControl,
  ): Promise<DirectActionResult<{ accepted: true }>>;
  createRtcClient(
    token: string,
    remoteAudio: HTMLAudioElement | null,
  ): Promise<TelnyxRtcLike>;
  createRemoteAudio(): HTMLAudioElement | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  registrationTimeoutMs: number;
};

const defaultDependencies: DirectTransportDependencies = {
  prepareMicrophone,
  getToken: getDirectRtcToken,
  startCall: startDirectCall,
  getStatus: getDirectCallStatus,
  control: controlDirectCall,
  createRtcClient: createTelnyxRtcClient,
  createRemoteAudio,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  registrationTimeoutMs: REGISTER_TIMEOUT_MS,
};

export function mapDirectStatus(
  status: DirectCallStatus,
): CallTransportState | null {
  switch (status) {
    case "browser_connecting":
      return "connecting";
    case "seller_dialing":
      return "ringing";
    case "connected":
      return "live";
    case "ended":
      return "ended";
    case "failed":
      return "failed";
    default:
      // "ending" keeps whatever state the call was already showing.
      return null;
  }
}

export class TelnyxDirectCallTransport implements CallTransport {
  private listener: ((state: CallTransportState) => void) | null = null;
  private statusErrorListener: ((e: ProviderStatusPollError) => void) | null =
    null;
  private state: CallTransportState | null = null;
  private directCallId: string | null = null;
  private browserLegId: string | null = null;
  private correlationValue: string | null = null;
  private startInFlight = false;
  private startPromise: Promise<CallHandle> | null = null;
  // Invites that arrive while startDirectCall is still resolving: the server
  // dials this browser before the action returns, so they are decided only
  // once the matching identifiers are known.
  private bufferedInvites: TelnyxCallLike[] = [];
  private decidedInvites = new WeakSet<object>();
  private currentCall: TelnyxCallLike | null = null;
  private client: TelnyxRtcLike | null = null;
  private audio: HTMLAudioElement | null = null;
  private terminal: "ended" | "failed" | null = null;
  private connectedAtMs: number | null = null;
  private serverConnectedAt: string | null = null;
  private serverEndedAt: string | null = null;
  private polling = false;
  private disposed = false;
  private hangupPromise: Promise<CallResult> | null = null;
  private registration: {
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;

  constructor(
    private readonly deps: DirectTransportDependencies = defaultDependencies,
  ) {}

  onStateChange(cb: (state: CallTransportState) => void): void {
    this.listener = cb;
  }

  onProviderStatusError(cb: (error: ProviderStatusPollError) => void): void {
    this.statusErrorListener = cb;
  }

  callHandle(): CallHandle | null {
    return this.directCallId ? { id: this.directCallId } : null;
  }

  terminalIsAuthoritative(): boolean {
    return this.terminal !== null;
  }

  start(target: CallTarget): Promise<CallHandle> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.runStart(target);
    return this.startPromise;
  }

  private async runStart(target: CallTarget): Promise<CallHandle> {
    // Mic first: on denial nothing has been requested from the server.
    await this.deps.prepareMicrophone();

    const token = await this.deps.getToken();
    if (!token.ok) throw directError(token);

    this.startInFlight = true;
    try {
      const audio = this.deps.createRemoteAudio();
      this.audio = audio;
      const client = await this.deps.createRtcClient(token.data.token, audio);
      this.client = client;
      this.bindEvents(client);
      await this.register(client);

      const input: StartDirectCallInput = target.propertyId
        ? {
            kind: "lead",
            propertyId: target.propertyId,
            clientRequestId: requestId(target.callToken),
          }
        : {
            kind: "manual",
            phone: target.phoneE164,
            clientRequestId: requestId(target.callToken),
          };
      const started = await this.deps.startCall(input);
      if (!started.ok) {
        const error = directError(started);
        this.releaseClient();
        const refusal = refusalState(started.errorCode);
        if (refusal) {
          this.emit(refusal);
          return { id: "" };
        }
        throw error;
      }
      this.directCallId = started.data.directCallId;
      this.browserLegId = started.data.browserLegId;
      this.correlationValue = started.data.correlationHeader.value;
    } catch (error) {
      this.startInFlight = false;
      this.bufferedInvites = [];
      this.releaseClient();
      throw error;
    }
    this.startInFlight = false;
    this.emit("connecting");
    const buffered = this.bufferedInvites;
    this.bufferedInvites = [];
    for (const invite of buffered) this.decideInvite(invite);
    void this.pollLoop();
    return { id: this.directCallId };
  }

  private bindEvents(client: TelnyxRtcLike): void {
    client
      .on("telnyx.ready", () => {
        if (this.client !== client) return;
        this.registration?.resolve();
        this.registration = null;
      })
      .on("telnyx.error", (event) => {
        if (this.client !== client) return;
        // Before registration completes a signaling error is fatal to start.
        // Afterwards the server-side status stays the source of truth.
        this.registration?.reject(eventError(event));
        this.registration = null;
      })
      .on("telnyx.notification", (notification) => {
        if (this.client !== client) return;
        this.handleNotification(notification as TelnyxNotificationLike);
      });
  }

  private register(client: TelnyxRtcLike): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registration = null;
        reject(new Error("Browser audio registration timed out."));
      }, this.deps.registrationTimeoutMs);
      this.registration = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(
            error instanceof Error
              ? error
              : new Error("Browser audio registration failed."),
          );
        },
      };
      Promise.resolve(client.connect()).catch((error: unknown) => {
        clearTimeout(timer);
        this.registration = null;
        reject(error);
      });
    });
  }

  private handleNotification(notification: TelnyxNotificationLike): void {
    if (notification.type !== "callUpdate" || !notification.call) return;
    const call = notification.call;
    if (call === this.currentCall) return;
    if (call.direction !== "inbound") return;
    if ((call.state ?? "").toLowerCase() !== "ringing") return;
    if (this.decidedInvites.has(call)) return;
    if (this.startInFlight) {
      if (!this.bufferedInvites.includes(call)) this.bufferedInvites.push(call);
      return;
    }
    this.decideInvite(call);
  }

  private decideInvite(call: TelnyxCallLike): void {
    if (this.decidedInvites.has(call)) return;
    this.decidedInvites.add(call);
    if (!this.matches(call) || this.currentCall || this.terminal) {
      // Never answer anything that is not this operator's pending call.
      void Promise.resolve()
        .then(() => call.hangup())
        .catch(() => undefined);
      return;
    }
    this.currentCall = call;
    void Promise.resolve()
      .then(() => call.answer())
      .catch(() => {
        // Answer failed: end the server call rather than leave it ringing.
        const id = this.directCallId;
        if (id) void this.deps.control(id, { action: "hangup" }).catch(() => undefined);
      });
  }

  private matches(call: TelnyxCallLike): boolean {
    const legId = call.telnyxIDs?.telnyxCallControlId?.trim();
    if (legId && this.browserLegId && legId === this.browserLegId) return true;
    const header = call.options?.customHeaders?.find(
      (h) => h.name?.trim().toLowerCase() === CORRELATION_HEADER,
    );
    return Boolean(
      header?.value && this.correlationValue && header.value === this.correlationValue,
    );
  }

  private async pollLoop(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      while (!this.terminal && !this.disposed) {
        await this.pollOnce();
        if (this.terminal || this.disposed) break;
        await this.deps.sleep(STATUS_POLL_MS);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const id = this.directCallId;
    if (!id) return;
    try {
      const result = await this.deps.getStatus(id);
      if (!result.ok) {
        this.statusErrorListener?.({
          status: 502,
          errorCode: result.errorCode ?? "direct_status_unavailable",
        });
        return;
      }
      this.applyStatus(result.data);
    } catch {
      this.statusErrorListener?.({
        status: 502,
        errorCode: "direct_status_unavailable",
      });
    }
  }

  private applyStatus(view: DirectCallStatusView): void {
    if (this.terminal) return;
    this.serverConnectedAt = view.connectedAt ?? this.serverConnectedAt;
    this.serverEndedAt = view.endedAt ?? this.serverEndedAt;
    const mapped = mapDirectStatus(view.status);
    if (view.status === "connected" && this.connectedAtMs === null) {
      this.connectedAtMs = this.deps.now();
    }
    if (DIRECT_CALL_TERMINAL_STATUSES.has(view.status)) {
      this.terminal = view.status === "ended" ? "ended" : "failed";
      this.emit(mapped as CallTransportState);
      this.releaseClient();
      return;
    }
    if (mapped) this.emit(mapped);
  }

  private emit(state: CallTransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.listener?.(state);
  }

  async mute(on: boolean): Promise<boolean> {
    const call = this.currentCall;
    if (!call || this.state !== "live" || this.terminal) return false;
    try {
      if (on) call.muteAudio();
      else call.unmuteAudio();
      return true;
    } catch {
      return false;
    }
  }

  async hold(on: boolean): Promise<boolean> {
    const call = this.currentCall;
    if (!call || this.state !== "live" || this.terminal) return false;
    try {
      const result = await Promise.resolve(on ? call.hold() : call.unhold());
      // Pinned SDK 2.27.1 resolves `false` on HOLD_FAILED.
      return result !== false;
    } catch {
      return false;
    }
  }

  reconnectAudio(): Promise<boolean> {
    // No mid-call recovery in the pilot: browser loss ends the seller leg.
    return Promise.resolve(false);
  }

  async sendDigit(digit: DtmfDigit): Promise<boolean> {
    const id = this.directCallId;
    if (!id || this.state !== "live" || this.terminal) return false;
    try {
      const result = await this.deps.control(id, { action: "dtmf", digit });
      return result.ok;
    } catch {
      return false;
    }
  }

  hangup(): Promise<CallResult> {
    if (this.hangupPromise && !this.terminal) return this.hangupPromise;
    this.hangupPromise = this.runHangup().finally(() => {
      // Allow a retry when terminal proof did not arrive.
      if (!this.terminal) this.hangupPromise = null;
    });
    return this.hangupPromise;
  }

  private async runHangup(): Promise<CallResult> {
    // A hangup issued while start() is still resolving waits for the server
    // identity so the right call is ended.
    if (this.startPromise && !this.directCallId) {
      await this.startPromise.catch(() => undefined);
    }
    const id = this.directCallId;
    if (id && !this.terminal) {
      await this.deps.control(id, { action: "hangup" }).catch(() => undefined);
    }
    const call = this.currentCall;
    if (call) {
      await Promise.resolve()
        .then(() => call.hangup())
        .catch(() => undefined);
    }
    if (id) {
      for (
        let attempt = 0;
        !this.terminal && attempt < HANGUP_CONFIRM_ATTEMPTS;
        attempt += 1
      ) {
        await this.pollOnce();
        if (this.terminal) break;
        await this.deps.sleep(HANGUP_CONFIRM_MS);
      }
    } else {
      // Nothing was provisioned on the server; there is nothing to confirm.
      this.terminal = "failed";
      this.releaseClient();
    }
    return this.result();
  }

  private result(): CallResult {
    const connected = this.connectedAtMs !== null || this.serverConnectedAt !== null;
    let durationSeconds = 0;
    if (connected) {
      const start = this.serverConnectedAt
        ? Date.parse(this.serverConnectedAt)
        : (this.connectedAtMs as number);
      const end = this.serverEndedAt
        ? Date.parse(this.serverEndedAt)
        : this.deps.now();
      if (Number.isFinite(start) && Number.isFinite(end)) {
        durationSeconds = Math.max(0, Math.floor((end - start) / 1000));
      }
    }
    return { durationSeconds, outcome: connected ? "connected_human" : "failed" };
  }

  private releaseClient(): void {
    const client = this.client;
    const audio = this.audio;
    this.client = null;
    this.audio = null;
    this.disposed = this.terminal !== null;
    try {
      void Promise.resolve(client?.disconnect()).catch(() => undefined);
    } catch {
      /* best-effort teardown */
    }
    audio?.remove();
  }
}

function requestId(callToken: string | undefined): string {
  if (callToken && UUID.test(callToken)) return callToken;
  return crypto.randomUUID();
}

function directError(result: { error: string; errorCode?: string }): Error {
  const error = new Error(result.error);
  if (result.errorCode) error.name = result.errorCode;
  return error;
}

function refusalState(
  errorCode: string | undefined,
): "operator_busy" | "not_callable" | null {
  if (errorCode === "operator_busy") return "operator_busy";
  if (errorCode === "not_callable") return "not_callable";
  return null;
}

function eventError(event: unknown): unknown {
  return event && typeof event === "object" && "error" in event
    ? (event as { error: unknown }).error
    : event;
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
  const client = new sdk.TelnyxRTC({
    login_token: token,
    keepConnectionAliveOnSocketClose: true,
    hangupOnBeforeUnload: false,
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
