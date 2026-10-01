import type {
  CancelDirectCallResult,
  DirectActionResult,
  DirectCallControl,
  DirectCallStatus,
  DirectCallStatusView,
  DirectRtcToken,
  StartDirectCallInput,
  DirectCallTarget,
  StartDirectCallResult,
} from "@/lib/direct-calling/contract";
import { DIRECT_CALL_TERMINAL_STATUSES } from "@/lib/direct-calling/contract";
import {
  cancelDirectCallByRequest,
  controlDirectCall,
  getDirectCallStatus,
  getDirectCallStatusByRequest,
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
// Teardown: hangup (retried with backoff until the server accepts it) + status polling until the
// server reports a terminal status with every leg confirmed ended.
const TEARDOWN_BACKOFF_MS = [500, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000];
// A start whose response never arrived: cancel by request id (retried), then watch by request id.
const UNKNOWN_START_BACKOFF_MS = [500, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000];
const UNKNOWN_START_POLLS = 20;
const UNKNOWN_START_BACKGROUND_POLLS = 600;
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
  getStatusByRequest(
    clientRequestId: string,
  ): Promise<DirectActionResult<DirectCallStatusView>>;
  cancelByRequest(
    clientRequestId: string,
  ): Promise<DirectActionResult<CancelDirectCallResult>>;
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
  getStatusByRequest: getDirectCallStatusByRequest,
  cancelByRequest: cancelDirectCallByRequest,
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
  private callCapability: string | null = null;
  private serverTarget: DirectCallTarget | null = null;
  // Set the instant a start request is submitted to the server (never for a start that was not sent).
  private submittedRequestId: string | null = null;
  private requestCancelSent = false;
  // Set the instant hangup() is requested: from then on nothing is started or answered.
  private cancelled = false;
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
  // Last terminal status the server reported (may still have cleanup pending).
  private terminal: "ended" | "failed" | null = null;
  // Terminal AND every leg confirmed ended by the server: the only authoritative end.
  private confirmed = false;
  private teardownUnconfirmedEmitted = false;
  private teardownPromise: Promise<CallResult> | null = null;
  private resolveIdentity: (() => void) | null = null;
  private identity: Promise<void> = new Promise<void>((resolve) => {
    this.resolveIdentity = resolve;
  });
  private pageHideHandler: (() => void) | null = null;
  private connectedAtMs: number | null = null;
  private serverConnectedAt: string | null = null;
  private serverEndedAt: string | null = null;
  private polling = false;
  private disposed = false;
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
    return this.directCallId
      ? {
          id: this.directCallId,
          ...(this.callCapability ? { callCapability: this.callCapability } : {}),
          ...(this.serverTarget ? { target: this.serverTarget } : {}),
        }
      : null;
  }

  terminalIsAuthoritative(): boolean {
    return this.confirmed;
  }

  start(target: CallTarget): Promise<CallHandle> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.runStart(target).finally(() => this.resolveIdentity?.());
    return this.startPromise;
  }

  private async runStart(target: CallTarget): Promise<CallHandle> {
    // Mic first: on denial nothing has been requested from the server.
    await this.deps.prepareMicrophone();
    this.throwIfCancelled();

    const token = await this.deps.getToken();
    if (!token.ok) throw directError(token);
    this.throwIfCancelled();

    this.startInFlight = true;
    this.listenForPageHide();
    let cancelledStart: string | null = null;
    try {
      const audio = this.deps.createRemoteAudio();
      this.audio = audio;
      const client = await this.deps.createRtcClient(token.data.token, audio);
      this.client = client;
      this.bindEvents(client);
      await this.register(client);
      // A hangup during setup must never reach the server's start.
      this.throwIfCancelled();

      const clientRequestId = requestId(target.callToken);
      // Preserve the request kind the UI prepared; never re-derive it from the prepared target.
      const request = target.directRequest;
      const input: StartDirectCallInput =
        request?.kind === "manual"
          ? { kind: "manual", phone: request.phone, clientRequestId }
          : request?.kind === "lead"
            ? { kind: "lead", propertyId: request.propertyId, clientRequestId }
            : target.propertyId
              ? { kind: "lead", propertyId: target.propertyId, clientRequestId }
              : { kind: "manual", phone: target.phoneE164, clientRequestId };
      // From here the request may have reached the server: a lost response is "submitted, outcome unknown".
      this.submittedRequestId = clientRequestId;
      let started: DirectActionResult<StartDirectCallResult>;
      try {
        started = await this.deps.startCall(input);
      } catch (error) {
        await this.resolveUnknownStart(clientRequestId);
        throw error;
      }
      if (!started.ok) {
        const error = directError(started);
        // Only a proven pre-reservation refusal (`reserved === false`: not enabled, invalid request, operator
        // busy, prepare refused and its reservation discarded) means there is nothing to clean up. Any other
        // start error (an unknown Dial with cleanup still open, a failure after the reservation, a missing
        // flag) goes through the same request-id reconciliation as a lost response: cancel, then wait for
        // terminal + cleanupPending:false before the start counts as torn down.
        if (started.reserved !== false) await this.resolveUnknownStart(clientRequestId);
        this.releaseClient();
        this.resolveIdentity?.();
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
      this.callCapability = started.data.callCapability ?? null;
      this.serverTarget = started.data.target ?? null;
      // Hangup arrived while the start was in flight: the call now exists, so end it. Never answer.
      this.resolveIdentity?.();
      if (this.cancelled) cancelledStart = started.data.directCallId;
    } catch (error) {
      this.startInFlight = false;
      this.bufferedInvites = [];
      this.releaseClient();
      this.resolveIdentity?.();
      throw error;
    }
    this.startInFlight = false;
    if (cancelledStart) {
      for (const invite of this.bufferedInvites) this.decidedInvites.add(invite);
      this.bufferedInvites = [];
      // Same shared teardown-and-confirm path as every other cancellation.
      await this.teardown();
      return { id: cancelledStart };
    }
    this.emit("connecting");
    const buffered = this.bufferedInvites;
    this.bufferedInvites = [];
    for (const invite of buffered) this.decideInvite(invite);
    void this.pollLoop();
    return this.callHandle() as CallHandle;
  }

  /**
   * A start request was sent but its response never arrived: the server may or may not have provisioned a
   * call. Cancel by request id (a late start with that id then dials nothing; an existing call is hung up),
   * retrying, then poll by request id until the server reports terminal with no cleanup pending. If that is
   * not reached, surface the unconfirmed-teardown warning and keep watching in the background.
   */
  private async resolveUnknownStart(clientRequestId: string): Promise<void> {
    let cancelled = false;
    for (let attempt = 0; !cancelled; attempt += 1) {
      cancelled = await this.deps
        .cancelByRequest(clientRequestId)
        .then((r) => r.ok)
        .catch(() => false);
      if (cancelled) break;
      const delay = UNKNOWN_START_BACKOFF_MS[attempt];
      if (delay === undefined) break;
      await this.deps.sleep(delay);
    }
    if (cancelled && (await this.pollRequestUntilConfirmed(clientRequestId, UNKNOWN_START_POLLS))) return;
    this.emitTeardownUnconfirmed();
    void this.watchRequestInBackground(clientRequestId, cancelled);
  }

  private async pollRequestUntilConfirmed(clientRequestId: string, polls: number): Promise<boolean> {
    for (let i = 0; i < polls; i += 1) {
      const view = await this.deps.getStatusByRequest(clientRequestId).catch(() => null);
      if (view?.ok && DIRECT_CALL_TERMINAL_STATUSES.has(view.data.status) && view.data.cleanupPending === false) return true;
      await this.deps.sleep(STATUS_POLL_MS);
    }
    return false;
  }

  private async watchRequestInBackground(clientRequestId: string, cancelled: boolean): Promise<void> {
    let sent = cancelled;
    for (let i = 0; i < UNKNOWN_START_BACKGROUND_POLLS && !this.disposed; i += 1) {
      if (!sent) {
        sent = await this.deps
          .cancelByRequest(clientRequestId)
          .then((r) => r.ok)
          .catch(() => false);
      }
      if (sent && (await this.pollRequestUntilConfirmed(clientRequestId, 1))) {
        this.confirmed = true;
        this.terminal = "failed";
        this.stopListeningForPageHide();
        if (this.teardownUnconfirmedEmitted) {
          this.teardownUnconfirmedEmitted = false;
          this.emit("teardown_confirmed");
        }
        this.emit("failed");
        return;
      }
      if (!sent) await this.deps.sleep(STATUS_POLL_MS);
    }
  }

  /** Hangup/cancel while a start is in flight: tell the server by request id so it cannot be left dialing. */
  private cancelSubmittedStart(): void {
    const id = this.submittedRequestId;
    if (!id || this.directCallId || this.requestCancelSent) return;
    this.requestCancelSent = true;
    void this.deps.cancelByRequest(id).catch(() => undefined);
  }

  private throwIfCancelled(): void {
    if (!this.cancelled) return;
    this.bufferedInvites = [];
    this.releaseClient();
    this.resolveIdentity?.();
    throw new Error("Call cancelled.");
  }

  /** Page unload: best-effort start of the shared teardown (the server sweep covers a lost request). */
  private listenForPageHide(): void {
    if (this.pageHideHandler || typeof window === "undefined") return;
    this.pageHideHandler = () => this.cancelCall();
    window.addEventListener("pagehide", this.pageHideHandler);
  }

  private stopListeningForPageHide(): void {
    if (this.pageHideHandler && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.pageHideHandler);
    }
    this.pageHideHandler = null;
  }

  /** Every non-user cancellation (socket loss, SDK error, failed answer, pagehide) goes through here. */
  private cancelCall(): void {
    if (this.confirmed || this.disposed) return;
    this.cancelled = true;
    this.cancelSubmittedStart();
    void this.teardown().catch(() => undefined);
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
        if (this.registration) {
          this.registration.reject(eventError(event));
          this.registration = null;
          return;
        }
        // Afterwards there is no recovery: a lost browser connection ends the call.
        this.onClientLost();
      })
      .on("telnyx.socket.close", () => {
        if (this.client !== client) return;
        if (this.registration) return; // reported through the registration timeout/error
        this.onClientLost();
      })
      .on("telnyx.socket.error", () => {
        if (this.client !== client) return;
        if (this.registration) return;
        this.onClientLost();
      })
      .on("telnyx.notification", (notification) => {
        if (this.client !== client) return;
        this.handleNotification(notification as TelnyxNotificationLike);
      });
  }

  /** Pilot has no mid-call recovery: signalling loss during a call tears the server call down. */
  private onClientLost(): void {
    this.cancelCall();
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
    if (this.cancelled || !this.matches(call) || this.currentCall || this.terminal) {
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
        this.cancelCall();
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
      while (!this.confirmed && !this.disposed) {
        await this.pollOnce();
        if (this.confirmed || this.disposed) break;
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
    if (this.confirmed) return;
    this.serverConnectedAt = view.connectedAt ?? this.serverConnectedAt;
    this.serverEndedAt = view.endedAt ?? this.serverEndedAt;
    const mapped = mapDirectStatus(view.status);
    if (view.status === "connected" && this.connectedAtMs === null) {
      this.connectedAtMs = this.deps.now();
    }
    if (DIRECT_CALL_TERMINAL_STATUSES.has(view.status)) {
      this.terminal = view.status === "ended" ? "ended" : "failed";
      // Fail closed: a server that does not say cleanup is finished has not confirmed it.
      if (view.cleanupPending !== false) {
        // Over, but a leg may still be up: not authoritative. Keep polling and let the
        // provider surface the unconfirmed-teardown warning (and its retry control).
        this.emitTeardownUnconfirmed();
        return;
      }
      this.confirmed = true;
      this.stopListeningForPageHide();
      if (this.teardownUnconfirmedEmitted) {
        this.teardownUnconfirmedEmitted = false;
        this.emit("teardown_confirmed");
      }
      this.releaseClient();
      this.emit(mapped as CallTransportState);
      return;
    }
    if (mapped) this.emit(mapped);
  }

  private emitTeardownUnconfirmed(): void {
    if (this.teardownUnconfirmedEmitted) return;
    this.teardownUnconfirmedEmitted = true;
    this.state = "teardown_unconfirmed";
    this.listener?.("teardown_unconfirmed");
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
    this.cancelled = true;
    this.cancelSubmittedStart();
    return this.teardown();
  }

  /**
   * The single teardown-and-confirm path (user hangup, socket loss, SDK error, failed answer,
   * pagehide). Sends the server hangup (retrying with backoff until accepted), keeps polling the
   * status, and publishes the final state: teardown_confirmed + ended/failed once the server says
   * terminal with every leg confirmed, teardown_unconfirmed if that did not happen in time.
   * Memoized while in flight; after an unconfirmed outcome a new call starts a fresh attempt.
   */
  private teardown(): Promise<CallResult> {
    if (this.teardownPromise) return this.teardownPromise;
    const attempt = this.runTeardown().finally(() => {
      if (this.teardownPromise === attempt && !this.confirmed) this.teardownPromise = null;
    });
    this.teardownPromise = attempt;
    return attempt;
  }

  private async runTeardown(): Promise<CallResult> {
    // A cancellation issued while start() is still resolving waits for the server identity
    // so the right call is ended.
    if (this.startInFlight || (this.startPromise && !this.directCallId)) await this.identity;
    const id = this.directCallId;
    if (!id && this.submittedRequestId && this.teardownUnconfirmedEmitted && !this.confirmed) {
      // A start of unknown outcome is still being reconciled by request id: not confirmed yet.
      return this.result();
    }
    if (!id) {
      // Nothing was provisioned on the server; there is nothing to confirm.
      this.terminal = "failed";
      this.confirmed = true;
      this.stopListeningForPageHide();
      this.releaseClient();
      return this.result();
    }
    const call = this.currentCall;
    let accepted = false;
    for (let attempt = 0; !this.confirmed; attempt += 1) {
      if (!accepted) {
        accepted = await this.deps
          .control(id, { action: "hangup" })
          .then((r) => r.ok)
          .catch(() => false);
        if (attempt === 0 && call) {
          await Promise.resolve()
            .then(() => call.hangup())
            .catch(() => undefined);
        }
      }
      await this.pollOnce();
      if (this.confirmed) break;
      const delay = TEARDOWN_BACKOFF_MS[attempt];
      if (delay === undefined) break;
      await this.deps.sleep(delay);
    }
    if (!this.confirmed) {
      this.emitTeardownUnconfirmed();
      // Keep watching in the background: a late confirmation still publishes the final state.
      void this.pollLoop();
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
    this.disposed = this.confirmed;
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

// The backend refuses a second concurrent call with `call_in_progress`; that is the only
// refusal it reports as a code (eligibility failures come back as plain error text).
function refusalState(errorCode: string | undefined): "operator_busy" | null {
  return errorCode === "call_in_progress" ? "operator_busy" : null;
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

export async function createTelnyxRtcClient(
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
    // No recovery in the pilot: a lost socket or unloaded page ends the call.
    keepConnectionAliveOnSocketClose: false,
    hangupOnBeforeUnload: true,
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
