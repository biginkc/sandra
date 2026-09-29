import {
  DIALPAD_BROWSER_PROTOCOL,
  encodeDialpadBrowserBinary,
  parseDialpadBrowserServerMessage,
  type DialpadBrowserCaptureStateMessage,
  type DialpadBrowserMeasurementSnapshotMessage,
  type DialpadBrowserServerMessage,
  type DialpadBrowserTrack,
} from './browser-protocol';
import { encodeDialpadTimingBatch, type DialpadTimingReason, type DialpadTimingRecord } from './timing-evidence';
import type {
  ActiveDialpadCapture,
  BrowserCaptureError,
  BrowserCaptureSinks,
  EncodedMediaChunk,
  PreparedDialpadCapture,
} from './browser-capture';
import type { PcmFrame, PcmTailReport } from './pcm-audio-worklet';

const TRACKS = ['tab', 'mic'] as const satisfies readonly DialpadBrowserTrack[];
type Track = (typeof TRACKS)[number];

export type DialpadBrowserSocketMessage = { readonly data?: string | ArrayBuffer | Uint8Array };
export type DialpadBrowserSocketEvent = { readonly type?: string; readonly code?: number; readonly reason?: string };

/** Minimal WebSocket surface so session tests never need a real browser socket. */
export interface DialpadBrowserSocket {
  readonly readyState: number;
  /** Native browser queue depth. Fake transports may omit it. */
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent) => void): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent) => void): void;
}

export type DialpadBrowserSocketFactory = (endpoint: string) => DialpadBrowserSocket;

export type BrowserSessionFailureCode = 'protocol' | 'socket' | 'timeout' | 'queue_overflow' | 'capture' | 'interrupted';

export class DialpadBrowserSessionError extends Error {
  readonly code: BrowserSessionFailureCode;

  constructor(code: BrowserSessionFailureCode, message: string) {
    super(message);
    this.name = 'DialpadBrowserSessionError';
    this.code = code;
  }
}

export type DialpadBrowserSessionState = 'idle' | 'authenticating' | 'hydrating' | 'recording' | 'stopping' | 'stopped' | 'failed';

export type DialpadBrowserSessionOptions = {
  readonly endpoint: string;
  readonly token: string;
  readonly epoch: number;
  readonly capture: PreparedDialpadCapture | ActiveDialpadCapture;
  readonly socketFactory?: DialpadBrowserSocketFactory;
  readonly ackTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  /** Separate deadline for draining an authenticated local prefix. */
  readonly attachmentTimeoutMs?: number;
  readonly maxPendingRecordingChunks?: number;
  readonly maxPendingPackets?: number;
  readonly maxBufferedBytes?: number;
  /** Opt in only after the compatible Jitter endpoint has been deployed. */
  readonly enableTiming?: boolean;
  readonly onSnapshot?: (snapshot: DialpadBrowserMeasurementSnapshotMessage) => void;
  readonly onCaptureState?: (state: DialpadBrowserCaptureStateMessage) => void;
  readonly onServerMessage?: (message: DialpadBrowserServerMessage) => void;
  readonly onFailure?: (error: DialpadBrowserSessionError) => void;
};

export type DialpadBrowserSession = {
  readonly state: () => DialpadBrowserSessionState;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly dispose: () => Promise<void>;
};

const OPEN = 1;
const DEFAULT_ACK_TIMEOUT_MS = 2_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_ATTACHMENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PENDING_CHUNKS = 8;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_PCM_FRAMES = 32;

function defaultSocketFactory(endpoint: string): DialpadBrowserSocket {
  return new WebSocket(endpoint) as unknown as DialpadBrowserSocket;
}

function isTrack(value: string): value is Track {
  return value === 'tab' || value === 'mic';
}

function key(track: Track, sequence: number): string {
  return `${track}:${sequence}`;
}

function asBinaryData(value: string | ArrayBuffer | Uint8Array): string | ArrayBuffer | Uint8Array {
  return value;
}

function byteLength(value: string | ArrayBuffer | Uint8Array): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  return value.byteLength;
}

function failureFromCapture(error: unknown): DialpadBrowserSessionError {
  const capture = error as Partial<BrowserCaptureError>;
  return new DialpadBrowserSessionError('capture', capture.message ?? 'Browser capture failed.');
}

function boundedTail(tail: PcmTailReport): number | null {
  if (!Number.isSafeInteger(tail.uncreditedTailSamples) || tail.uncreditedTailSamples < 0 || tail.uncreditedTailSamples > 319) return null;
  return tail.uncreditedTailSamples;
}

export function createDialpadBrowserSession(options: DialpadBrowserSessionOptions): DialpadBrowserSession {
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const attachmentTimeoutMs = options.attachmentTimeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
  const maxPendingChunks = options.maxPendingRecordingChunks ?? DEFAULT_MAX_PENDING_CHUNKS;
  const maxPendingPackets = options.maxPendingPackets ?? 64;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const enableTiming = options.enableTiming === true;
  if (!Number.isSafeInteger(options.epoch) || options.epoch < DIALPAD_BROWSER_PROTOCOL.minEpoch || options.epoch > DIALPAD_BROWSER_PROTOCOL.maxEpoch) {
    throw new DialpadBrowserSessionError('protocol', 'Invalid recording epoch.');
  }
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw new DialpadBrowserSessionError('protocol', 'Recording transport endpoint is invalid.'); }
  if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/dialpad-browser-ingest') throw new DialpadBrowserSessionError('protocol', 'Recording transport must use the trusted WSS endpoint.');
  if (!options.token || !Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1 || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || !Number.isSafeInteger(attachmentTimeoutMs) || attachmentTimeoutMs < 1 || !Number.isSafeInteger(maxPendingChunks) || maxPendingChunks < 1 || !Number.isSafeInteger(maxPendingPackets) || maxPendingPackets < 1 || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new DialpadBrowserSessionError('protocol', 'Invalid browser session limits.');
  }

  let state: DialpadBrowserSessionState = 'idle';
  let socket: DialpadBrowserSocket | null = null;
  let activeCapture: ActiveDialpadCapture | null = null;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let failed: DialpadBrowserSessionError | null = null;
  let disposed = false;
  let opened = false;
  let ready = false;
  let snapshot = false;
  let captureState = false;
  let timingNegotiated = false;
  let timingIncomplete = false;
  let timingBarrierSent = false;
  let timingSendQueue = Promise.resolve();
  let timingBatchInFlight: { batchId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let timingProbeInFlight: { seq: number; nonce: string; browserSendMs: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let timingEndInFlight: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let timingProbeTimer: ReturnType<typeof setInterval> | null = null;
  let timingExchangeSeq = 0;
  const pendingTimingRecords: DialpadTimingRecord[] = [];
  let pendingTimingBytes = 0;
  const timingLastSeq = { tabAnchor: -1, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 };
  let queueDepth = 0;
  let queuedBytes = 0;
  let sendQueue = Promise.resolve();
  let captureStartPromise: Promise<void> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let mediaAdmissionOpen = true;
  let snapshotRevision = -1;
  let pendingChunkConversions = 0;
  const pendingChunkAcks = new Map<string, { readonly track: Track; readonly seq: number; readonly resolve: () => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();
  const acknowledgedChunks = new Set<string>();
  const pendingPcmAcks = new Map<string, { readonly track: Track; readonly seq: number; readonly resolve: () => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();
  const pcmAckHistory = new Map<Track, { contiguous: number; readonly outOfOrder: Set<number> }>(TRACKS.map((track) => [track, { contiguous: -1, outOfOrder: new Set<number>() }]));
  const pcmCreditWaiters: { readonly resolve: () => void; readonly reject: (error: Error) => void }[] = [];
  let pcmCreditWakeups = 0;
  const recordingLastSeq = new Map<Track, number>();
  const pcmEndSamples = new Map<Track, number>();
  const pcmTails = new Map<Track, PcmTailReport>();
  const recordingEofAcks = new Map<Track, number>();
  const pcmDrainAcks = new Map<Track, number>();
  const recordingEofRequests = new Map<Track, number>();
  const pcmDrainRequests = new Map<Track, number>();
  const interruptedTracks = new Set<Track>();
  const listener = {
    open: () => { void onOpen(); },
    message: (event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent) => { void onMessage(event); },
    error: (event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent) => { fail(new DialpadBrowserSessionError('socket', event.reason || 'Recording transport failed.')); },
    close: () => { if (state !== 'stopping' && state !== 'stopped' && state !== 'failed') fail(new DialpadBrowserSessionError('socket', 'Recording transport closed unexpectedly.')); },
  };

  const detach = () => {
    if (!socket) return;
    socket.removeEventListener('open', listener.open);
    socket.removeEventListener('message', listener.message);
    socket.removeEventListener('error', listener.error);
    socket.removeEventListener('close', listener.close);
  };

  const settlePendingChunkAcks = (error: DialpadBrowserSessionError) => {
    for (const pending of pendingChunkAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingChunkAcks.clear();
  };

  const drainPcmCreditWaiters = () => {
    while (pcmCreditWaiters.length > 0 && pendingPcmAcks.size + pcmCreditWakeups < MAX_PENDING_PCM_FRAMES) {
      pcmCreditWakeups += 1;
      pcmCreditWaiters.shift()!.resolve();
    }
  };

  const isAcknowledgedPcmFrame = (track: Track, sequence: number): boolean => {
    const history = pcmAckHistory.get(track)!;
    return sequence <= history.contiguous || history.outOfOrder.has(sequence);
  };

  const recordPcmAcknowledgement = (track: Track, sequence: number): void => {
    const history = pcmAckHistory.get(track)!;
    if (sequence <= history.contiguous) return;
    if (sequence === history.contiguous + 1) {
      history.contiguous = sequence;
      while (history.outOfOrder.delete(history.contiguous + 1)) history.contiguous += 1;
      return;
    }
    if (history.outOfOrder.size >= MAX_PENDING_PCM_FRAMES) {
      fail(new DialpadBrowserSessionError('protocol', 'PCM acknowledgement history exceeded its bounded reordering window.'));
      return;
    }
    history.outOfOrder.add(sequence);
  };

  const settlePendingPcmAcks = (error: DialpadBrowserSessionError) => {
    for (const pending of pendingPcmAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingPcmAcks.clear();
    while (pcmCreditWaiters.length > 0) pcmCreditWaiters.shift()!.reject(error);
    pcmCreditWakeups = 0;
  };

  const settleTiming = (error: DialpadBrowserSessionError) => {
    if (timingProbeTimer) {
      clearInterval(timingProbeTimer);
      timingProbeTimer = null;
    }
    if (timingBatchInFlight) {
      clearTimeout(timingBatchInFlight.timer);
      timingBatchInFlight.reject(error);
      timingBatchInFlight = null;
    }
    if (timingProbeInFlight) {
      clearTimeout(timingProbeInFlight.timer);
      timingProbeInFlight.reject(error);
      timingProbeInFlight = null;
    }
    if (timingEndInFlight) {
      clearTimeout(timingEndInFlight.timer);
      timingEndInFlight.reject(error);
      timingEndInFlight = null;
    }
  };

  function disposeCapture(): Promise<void> {
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve().then(() => options.capture.dispose()).catch(() => undefined);
    }
    return cleanupPromise;
  }

  function fail(error: DialpadBrowserSessionError): void {
    if (failed || disposed) return;
    failed = error;
    state = 'failed';
    mediaAdmissionOpen = false;
    lifecycleGeneration += 1;
    settlePendingChunkAcks(error);
    settlePendingPcmAcks(error);
    settleTiming(error);
    try { options.onFailure?.(error); } catch { /* failure remains sticky */ }
    if (socket) {
      detach();
      try { socket.close(1011, 'recording session failed'); } catch { /* socket is already failing */ }
    }
    void disposeCapture();
  }

  function enqueueSend(data: string | ArrayBuffer | Uint8Array, countsAsChunk = false): Promise<void> {
    if (failed || disposed || !socket || socket.readyState !== OPEN) return Promise.reject(failed ?? new DialpadBrowserSessionError('socket', 'Recording transport is not open.'));
    if ((!countsAsChunk && typeof data !== 'string' && queueDepth >= maxPendingPackets) || (countsAsChunk && pendingChunkAcks.size > maxPendingChunks)) {
      const error = new DialpadBrowserSessionError('queue_overflow', 'Recording transport queue capacity was exceeded.');
      fail(error);
      return Promise.reject(error);
    }
    const bytes = byteLength(data);
    const nativeBuffered = socket.bufferedAmount ?? 0;
    if (!Number.isFinite(nativeBuffered) || nativeBuffered < 0 || queuedBytes + bytes + nativeBuffered > maxBufferedBytes) {
      const error = new DialpadBrowserSessionError('queue_overflow', 'Recording transport byte capacity was exceeded.');
      fail(error);
      return Promise.reject(error);
    }
    queueDepth += 1;
    queuedBytes += bytes;
    sendQueue = sendQueue.then(() => {
      if (failed || !socket || socket.readyState !== OPEN) throw failed ?? new DialpadBrowserSessionError('socket', 'Recording transport is not open.');
      if ((socket.bufferedAmount ?? 0) + bytes > maxBufferedBytes) throw new DialpadBrowserSessionError('queue_overflow', 'Native recording transport buffer was full.');
      socket.send(asBinaryData(data));
      if ((socket.bufferedAmount ?? 0) > maxBufferedBytes) throw new DialpadBrowserSessionError('queue_overflow', 'Native recording transport buffer exceeded its limit.');
    }).catch((error: unknown) => {
      const normalized = error instanceof DialpadBrowserSessionError ? error : new DialpadBrowserSessionError('socket', 'Recording transport send failed.');
      fail(normalized);
      throw normalized;
    }).finally(() => { queueDepth -= 1; queuedBytes -= bytes; });
    return sendQueue;
  }

  function sendControl(message: Record<string, unknown>): Promise<void> {
    return enqueueSend(JSON.stringify(message));
  }

  function timingNow(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
  }

  function timingUuid(): string {
    return globalThis.crypto?.randomUUID?.() ?? `00000000-0000-4000-8000-${Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0')}`;
  }

  function timingRecordBytes(record: DialpadTimingRecord): number {
    return new TextEncoder().encode(JSON.stringify(record)).byteLength;
  }

  function noteTimingRecord(record: DialpadTimingRecord): void {
    if (!timingNegotiated || timingBarrierSent || timingIncomplete) return;
    const recordBytes = timingRecordBytes(record);
    if (pendingTimingRecords.length >= 64 || pendingTimingBytes + recordBytes > 64 * 1024) {
      timingIncomplete = true;
      pendingTimingRecords.length = 0;
      pendingTimingBytes = 0;
      return;
    }
    pendingTimingRecords.push(record);
    pendingTimingBytes += recordBytes;
    if (record.kind === 'anchor') timingLastSeq[record.track === 'tab' ? 'tabAnchor' : 'micAnchor'] = Math.max(timingLastSeq[record.track === 'tab' ? 'tabAnchor' : 'micAnchor'], record.seq);
    else if (record.kind === 'context_clock') timingLastSeq[record.track === 'tab' ? 'tabContext' : 'micContext'] = Math.max(timingLastSeq[record.track === 'tab' ? 'tabContext' : 'micContext'], record.seq);
    else timingLastSeq.exchange = Math.max(timingLastSeq.exchange, record.seq);
    void flushTimingBatches();
  }

  async function flushTimingBatches(): Promise<void> {
    if (!timingNegotiated || timingIncomplete) return;
    timingSendQueue = timingSendQueue.then(async () => {
      while (pendingTimingRecords.length > 0 && !timingIncomplete) {
        const batch: DialpadTimingRecord[] = [];
        while (pendingTimingRecords.length > 0 && batch.length < 16) {
          const candidate = pendingTimingRecords[0]!;
          try { encodeDialpadTimingBatch(options.epoch, timingUuid(), [...batch, candidate]); } catch { if (batch.length === 0) { timingIncomplete = true; pendingTimingRecords.length = 0; pendingTimingBytes = 0; } break; }
          batch.push(pendingTimingRecords.shift()!);
          pendingTimingBytes -= timingRecordBytes(candidate);
        }
        if (batch.length === 0) break;
        const batchId = timingUuid();
        const encoded = encodeDialpadTimingBatch(options.epoch, batchId, batch);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { timingBatchInFlight = null; timingIncomplete = true; reject(new DialpadBrowserSessionError('timeout', 'Timing batch acknowledgement timed out.')); }, ackTimeoutMs);
          timingBatchInFlight = { batchId, resolve, reject, timer };
          void enqueueSend(encoded).catch((error) => { timingIncomplete = true; reject(error instanceof Error ? error : new Error('Timing batch send failed.')); });
        }).catch(() => undefined);
      }
    });
    await timingSendQueue;
  }

  async function sendTimingProbe(): Promise<void> {
    if (!timingNegotiated || timingIncomplete || timingProbeInFlight) return;
    const seq = timingExchangeSeq++;
    const nonceBytes = new Uint8Array(32);
    globalThis.crypto?.getRandomValues?.(nonceBytes);
    const nonce = [...nonceBytes].map((value) => value.toString(16).padStart(2, '0')).join('') || `${'0'.repeat(63)}1`;
    const browserSendMs = timingNow();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { timingProbeInFlight = null; timingIncomplete = true; reject(new DialpadBrowserSessionError('timeout', 'Timing exchange timed out.')); }, ackTimeoutMs);
      timingProbeInFlight = { seq, nonce, browserSendMs, resolve, reject, timer };
      void sendControl({ type: 'timing_probe', epoch: options.epoch, seq, browserSendMs }).catch(reject);
    }).catch(() => undefined);
  }

  async function finishTiming(): Promise<void> {
    if (!timingNegotiated || timingBarrierSent) return;
    if (timingProbeTimer) {
      clearInterval(timingProbeTimer);
      timingProbeTimer = null;
    }
    await sendTimingProbe();
    await flushTimingBatches();
    timingBarrierSent = true;
    const outcome = timingIncomplete ? 'incomplete' : 'collected';
    const reasons: DialpadTimingReason[] = timingIncomplete ? ['persistence_failed'] : [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { timingEndInFlight = null; reject(new DialpadBrowserSessionError('timeout', 'Timing end acknowledgement timed out.')); }, ackTimeoutMs);
        timingEndInFlight = { resolve, reject, timer };
        void sendControl({ type: 'timing_end', epoch: options.epoch, lastSeq: timingLastSeq, outcome, reasons }).catch(reject);
      });
    } catch { timingIncomplete = true; }
  }

  async function onOpen(): Promise<void> {
    if (!socket || opened || failed) return;
    opened = true;
    state = 'authenticating';
    try {
      const auth = { type: 'auth', token: options.token, epoch: options.epoch, controlVersion: DIALPAD_BROWSER_PROTOCOL.controlVersion, ...(enableTiming ? { capabilities: ['capture_timing_v1'] as const } : {}) };
      await enqueueSend(JSON.stringify(auth));
    } catch (error) {
      fail(error instanceof DialpadBrowserSessionError ? error : new DialpadBrowserSessionError('socket', 'Authentication could not be sent.'));
    }
  }

  async function onMessage(event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent): Promise<void> {
    if (failed || disposed) return;
    if (typeof event.data !== 'string') {
      fail(new DialpadBrowserSessionError('protocol', 'Unexpected binary server message.'));
      return;
    }
    let message: DialpadBrowserServerMessage;
    try {
      message = parseDialpadBrowserServerMessage(event.data);
      if (message.epoch !== options.epoch) throw new DialpadBrowserSessionError('protocol', 'Server message epoch did not match this session.');
    } catch (error) {
      fail(error instanceof DialpadBrowserSessionError ? error : new DialpadBrowserSessionError('protocol', 'Invalid server message.'));
      return;
    }
    try {
      options.onServerMessage?.(message);
      if (message.type === 'ready') {
        ready = true;
        timingNegotiated = enableTiming && message.capabilities?.includes('capture_timing_v1') === true;
        if (timingNegotiated && timingProbeTimer === null) timingProbeTimer = setInterval(() => { void sendTimingProbe(); }, 10_000);
        state = 'hydrating';
      } else if (message.type === 'measurement_snapshot') {
        if (message.revision < snapshotRevision) return;
        snapshotRevision = message.revision;
        snapshot = true;
        options.onSnapshot?.(message);
      } else if (message.type === 'capture_state') {
        if (message.latestConsumedEpoch !== options.epoch) {
          fail(new DialpadBrowserSessionError('protocol', 'Recording lifecycle epoch fence did not match this session.'));
          return;
        }
        captureState = true;
        options.onCaptureState?.(message);
        if (message.state === 'closed') {
          fail(new DialpadBrowserSessionError('interrupted', 'The recording capture is already closed.'));
          return;
        }
        if (message.state === 'closing' && state !== 'stopping' && state !== 'stopped' && state !== 'failed') void stop();
      } else if (message.type === 'recording_chunk_ack') {
        const ackKey = key(message.track, message.seq);
        acknowledgedChunks.add(ackKey);
        const pending = pendingChunkAcks.get(ackKey);
        if (pending) {
          clearTimeout(pending.timer);
          pendingChunkAcks.delete(ackKey);
          pending.resolve();
        }
      } else if (message.type === 'pcm_frame_ack') {
        const ackKey = key(message.track, message.seq);
        const pending = pendingPcmAcks.get(ackKey);
        if (!pending) {
          if (isAcknowledgedPcmFrame(message.track, message.seq)) return;
          fail(new DialpadBrowserSessionError('protocol', 'Unexpected PCM frame acknowledgement.'));
          return;
        }
        clearTimeout(pending.timer);
        pendingPcmAcks.delete(ackKey);
        recordPcmAcknowledgement(message.track, message.seq);
        if (failed) return;
        pending.resolve();
        drainPcmCreditWaiters();
      } else if (message.type === 'recording_eof_ack') {
        const expected = recordingEofRequests.get(message.track);
        if (expected === undefined || expected !== message.lastSeq) {
          fail(new DialpadBrowserSessionError('protocol', 'Unexpected recording EOF acknowledgement.'));
          return;
        }
        recordingEofAcks.set(message.track, message.lastSeq);
      } else if (message.type === 'pcm_eof_drained') {
        const expected = pcmDrainRequests.get(message.track);
        if (expected === undefined || expected !== message.endSample) {
          fail(new DialpadBrowserSessionError('protocol', 'Unexpected PCM EOF acknowledgement.'));
          return;
        }
        pcmDrainAcks.set(message.track, message.endSample);
      } else if (message.type === 'timing_batch_ack') {
        if (!timingBatchInFlight || timingBatchInFlight.batchId !== message.batchId) throw new DialpadBrowserSessionError('protocol', 'Unexpected timing batch acknowledgement.');
        clearTimeout(timingBatchInFlight.timer); timingBatchInFlight.resolve(); timingBatchInFlight = null;
      } else if (message.type === 'timing_probe_reply') {
        if (!timingProbeInFlight || timingProbeInFlight.seq !== message.seq || timingProbeInFlight.nonce !== message.nonce) throw new DialpadBrowserSessionError('protocol', 'Unexpected timing probe reply.');
        const pending = timingProbeInFlight;
        clearTimeout(pending.timer);
        const browserReceiveMs = timingNow();
        timingLastSeq.exchange = Math.max(timingLastSeq.exchange, message.seq);
        await sendControl({ type: 'timing_confirm', epoch: options.epoch, seq: message.seq, nonce: message.nonce, browserReceiveMs });
        void pending.resolve();
      } else if (message.type === 'timing_exchange_ack') {
        if (!timingProbeInFlight || timingProbeInFlight.seq !== message.seq) return;
        clearTimeout(timingProbeInFlight.timer); timingProbeInFlight.resolve(); timingProbeInFlight = null;
      } else if (message.type === 'timing_end_ack') {
        if (message.status === 'incomplete') timingIncomplete = true;
        if (timingEndInFlight) { clearTimeout(timingEndInFlight.timer); timingEndInFlight.resolve(); timingEndInFlight = null; }
      }
      if (ready && snapshot && captureState && state === 'hydrating') await beginCapture();
    } catch (error) {
      fail(error instanceof DialpadBrowserSessionError ? error : new DialpadBrowserSessionError('protocol', 'Server lifecycle message was rejected.'));
    }
  }

  async function beginCapture(): Promise<void> {
    if (captureStartPromise) return captureStartPromise;
    if (state !== 'hydrating' || failed || disposed || !mediaAdmissionOpen) return;
    const generation = lifecycleGeneration;
    const sinks: BrowserCaptureSinks = {
      onTrackFormat: async (format) => {
        if (!isTrack(format.track) || !Number.isSafeInteger(format.contextSampleRateHz) || format.contextSampleRateHz < 8_000 || format.contextSampleRateHz > 192_000 || !Number.isSafeInteger(format.inputChannels) || format.inputChannels < 1 || format.inputChannels > 2 || format.recordingMimeType !== 'audio/webm;codecs=opus' || format.pcmSampleRateHz !== 16_000 || format.pcmChannels !== 1 || format.pcmEncoding !== 's16le') {
          const error = new DialpadBrowserSessionError('protocol', 'Capture format did not match the browser transport contract.');
          fail(error);
          throw error;
        }
        await sendControl({ type: 'track_format', epoch: options.epoch, track: format.track, contextSampleRateHz: format.contextSampleRateHz, inputChannels: format.inputChannels, recordingMimeType: format.recordingMimeType, pcmSampleRateHz: format.pcmSampleRateHz, pcmChannels: format.pcmChannels, pcmEncoding: format.pcmEncoding });
      },
      onPcmFrame: async (frame) => {
        try { await sendPcmFrame(frame); } catch (error) {
          const normalized = error instanceof DialpadBrowserSessionError ? error : new DialpadBrowserSessionError('socket', 'PCM delivery failed.');
          fail(normalized);
        }
      },
      onPcmTail: async (tail) => { pcmTails.set(tail.track, tail); },
      onTiming: async (record) => { noteTimingRecord(record); },
      onTimingFailure: () => { timingIncomplete = true; },
      onWebmChunk: async (chunk) => {
        try { await sendRecordingChunk(chunk); } catch (error) {
          const normalized = error instanceof DialpadBrowserSessionError ? error : new DialpadBrowserSessionError('socket', 'Recording delivery failed.');
          fail(normalized);
        }
      },
      onFailure: (error) => fail(failureFromCapture(error)),
    };
    captureStartPromise = (async () => {
      try {
        let startedCapture: ActiveDialpadCapture;
        if ('attach' in options.capture && options.capture.attach) {
          activeCapture = options.capture;
          state = 'recording';
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              options.capture.attach(sinks, options.epoch),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new DialpadBrowserSessionError('timeout', 'Authenticated capture attachment exceeded its deadline.')), attachmentTimeoutMs);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          startedCapture = options.capture;
        } else {
          startedCapture = await (options.capture as PreparedDialpadCapture).start(sinks, options.epoch);
        }
        if (failed || disposed || generation !== lifecycleGeneration || !mediaAdmissionOpen || stopPromise) {
          await startedCapture.dispose();
          return;
        }
        activeCapture = startedCapture;
        state = 'recording';
      } catch (error) {
        if (!failed && !disposed && generation === lifecycleGeneration) fail(error instanceof DialpadBrowserSessionError ? error : failureFromCapture(error));
      }
    })();
    await captureStartPromise;
    captureStartPromise = null;
  }

  async function sendPcmFrame(frame: PcmFrame): Promise<void> {
    if (failed || !mediaAdmissionOpen || (state !== 'recording' && state !== 'hydrating' && state !== 'stopping')) return;
    if (frame.epoch !== options.epoch || !isTrack(frame.track) || !Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0 || frame.frameIndex > 0xffff_ffff || frame.bytes.byteLength !== DIALPAD_BROWSER_PROTOCOL.pcmPayloadBytes) {
      fail(new DialpadBrowserSessionError('protocol', 'PCM frame did not match the session contract.'));
      return;
    }
    const ackKey = key(frame.track, frame.frameIndex);
    if (pendingPcmAcks.has(ackKey) || isAcknowledgedPcmFrame(frame.track, frame.frameIndex)) return;
    while (pendingPcmAcks.size + pcmCreditWakeups >= MAX_PENDING_PCM_FRAMES) {
      await new Promise<void>((resolve, reject) => { pcmCreditWaiters.push({ resolve, reject }); });
      pcmCreditWakeups = Math.max(0, pcmCreditWakeups - 1);
      if (failed || disposed || !mediaAdmissionOpen) return;
      if (pendingPcmAcks.has(ackKey) || isAcknowledgedPcmFrame(frame.track, frame.frameIndex)) return;
    }
    const end = frame.frameIndex * 320 + 320;
    pcmEndSamples.set(frame.track, Math.max(pcmEndSamples.get(frame.track) ?? 0, end));
    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    const ackPromise = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    void ackPromise.catch(() => undefined);
    const timer = setTimeout(() => {
      const pending = pendingPcmAcks.get(ackKey);
      if (!pending) return;
      pendingPcmAcks.delete(ackKey);
      const timeout = new DialpadBrowserSessionError('timeout', 'PCM frame acknowledgement timed out.');
      clearTimeout(pending.timer);
      rejectAck(timeout);
      drainPcmCreditWaiters();
      fail(timeout);
    }, ackTimeoutMs);
    pendingPcmAcks.set(ackKey, { track: frame.track, seq: frame.frameIndex, resolve: resolveAck, reject: rejectAck, timer });
    try {
      await enqueueSend(encodeDialpadBrowserBinary({ kind: 'pcm', track: frame.track, epoch: options.epoch, sequence: frame.frameIndex, sampleClock: frame.frameIndex * 320, payload: frame.bytes }));
    } catch (error) {
      clearTimeout(timer);
      pendingPcmAcks.delete(ackKey);
      rejectAck(error instanceof Error ? error : new DialpadBrowserSessionError('socket', 'PCM frame could not be sent.'));
      drainPcmCreditWaiters();
      throw error;
    }
    if (isAcknowledgedPcmFrame(frame.track, frame.frameIndex)) {
      clearTimeout(timer);
      pendingPcmAcks.delete(ackKey);
      resolveAck();
      drainPcmCreditWaiters();
    }
  }

  async function sendRecordingChunk(chunk: EncodedMediaChunk): Promise<void> {
    if (failed || !mediaAdmissionOpen || (state !== 'recording' && state !== 'hydrating' && state !== 'stopping')) return;
    if (chunk.epoch !== options.epoch || !isTrack(chunk.track) || chunk.byteLength < 1 || chunk.byteLength > DIALPAD_BROWSER_PROTOCOL.maxRecordingPayloadBytes) {
      fail(new DialpadBrowserSessionError('protocol', 'Recording chunk did not match the session contract.'));
      return;
    }
    if (pendingChunkConversions >= maxPendingChunks) {
      const error = new DialpadBrowserSessionError('queue_overflow', 'Recording chunk conversion capacity was exceeded.');
      fail(error);
      throw error;
    }
    pendingChunkConversions += 1;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await chunk.blob.arrayBuffer());
    } finally {
      pendingChunkConversions -= 1;
    }
    if (bytes.byteLength !== chunk.byteLength || bytes.byteLength < 1 || bytes.byteLength > DIALPAD_BROWSER_PROTOCOL.maxRecordingPayloadBytes) {
      fail(new DialpadBrowserSessionError('protocol', 'Recording chunk byte length changed before delivery.'));
      return;
    }
    const ackKey = key(chunk.track, chunk.seq);
    if (pendingChunkAcks.has(ackKey) || acknowledgedChunks.has(ackKey)) return;
    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    const ackPromise = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    // The send path can fail before its caller reaches the ACK await. Own the
    // rejection immediately so socket/buffer failures never become unhandled.
    void ackPromise.catch(() => undefined);
    const timer = setTimeout(() => {
      pendingChunkAcks.delete(ackKey);
      const timeout = new DialpadBrowserSessionError('timeout', 'Recording chunk acknowledgement timed out.');
      rejectAck(timeout);
      fail(timeout);
    }, ackTimeoutMs);
    pendingChunkAcks.set(ackKey, { track: chunk.track, seq: chunk.seq, resolve: resolveAck, reject: rejectAck, timer });
    recordingLastSeq.set(chunk.track, chunk.seq);
    try {
      await enqueueSend(encodeDialpadBrowserBinary({ kind: 'recording', track: chunk.track, epoch: options.epoch, sequence: chunk.seq, payloadLength: bytes.byteLength, payload: bytes }), true);
    } catch (error) {
      clearTimeout(timer);
      pendingChunkAcks.delete(ackKey);
      rejectAck(error instanceof Error ? error : new DialpadBrowserSessionError('socket', 'Recording chunk could not be sent.'));
      throw error;
    }
    if (acknowledgedChunks.has(ackKey)) {
      clearTimeout(timer);
      pendingChunkAcks.delete(ackKey);
      resolveAck();
    }
    await ackPromise;
  }

  async function waitForAcks(predicate: () => boolean, label: string): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (failed) throw failed;
      if (Date.now() - started >= ackTimeoutMs) throw new DialpadBrowserSessionError('timeout', `${label} acknowledgement timed out.`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function finishControls(): Promise<void> {
    await waitForAcks(() => pendingPcmAcks.size === 0 && pcmCreditWaiters.length === 0 && pcmCreditWakeups === 0, 'PCM frame');
    await finishTiming();
    for (const track of TRACKS) {
      const tail = pcmTails.get(track);
      const discardedTailSamples = tail ? boundedTail(tail) : null;
      const interrupted = interruptedTracks.has(track) || !tail || Boolean(tail.timedOut || tail.deliveryTimedOut) || discardedTailSamples === null;
      if (interrupted) {
        interruptedTracks.add(track);
        await sendControl({ type: 'capture_interrupted', epoch: options.epoch, track, reason: tail?.timedOut || tail?.deliveryTimedOut ? 'capture_sink_failed' : 'capture_interrupted' });
      }
      const lastSeq = recordingLastSeq.get(track);
      if (lastSeq === undefined) {
        interruptedTracks.add(track);
        if (!interrupted) await sendControl({ type: 'capture_interrupted', epoch: options.epoch, track, reason: 'capture_interrupted' });
      } else if (!interrupted) {
        await waitForAcks(() => pendingChunkAcks.size === 0, 'recording chunk');
        recordingEofRequests.set(track, lastSeq);
        await sendControl({ type: 'recording_eof', epoch: options.epoch, track, lastSeq });
      }
      if (!interrupted) {
        const endSample = pcmEndSamples.get(track) ?? 0;
        pcmDrainRequests.set(track, endSample);
        await sendControl({ type: 'pcm_eof', epoch: options.epoch, track, endSample, discardedTailSamples: discardedTailSamples!, degradedReasons: [] });
      }
    }
    const expectedRecordingAcks = TRACKS.filter((track) => !interruptedTracks.has(track) && recordingLastSeq.has(track));
    const expectedPcmAcks = TRACKS.filter((track) => !interruptedTracks.has(track));
    await waitForAcks(() => expectedRecordingAcks.every((track) => recordingEofAcks.get(track) === recordingEofRequests.get(track)) && expectedPcmAcks.every((track) => pcmDrainAcks.get(track) === pcmDrainRequests.get(track)), 'recording drain');
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    if (state === 'idle') {
      mediaAdmissionOpen = false;
      lifecycleGeneration += 1;
      await disposeCapture();
      state = 'stopped';
      return;
    }
    stopPromise = (async () => {
      if (state === 'failed') {
        mediaAdmissionOpen = false;
        await disposeCapture();
        return;
      }
      state = 'stopping';
      let abortedCaptureStartup = false;
      try {
        const pendingCaptureStart = captureStartPromise;
        // Provider closure is graceful: stop acquisition first, then let an
        // authenticated prefix finish its bounded receipt drain. Abortive
        // disposal remains responsible for settling these waits immediately.
        if (pendingCaptureStart && !activeCapture) {
          // A prepared capture has not become an active resource yet. Fence
          // the generation, release permission resources, and return without
          // waiting on a startup promise that may never observe cancellation.
          abortedCaptureStartup = true;
          mediaAdmissionOpen = false;
          lifecycleGeneration += 1;
          await disposeCapture();
        } else {
          await activeCapture?.stop();
          if (pendingCaptureStart) await pendingCaptureStart;
        }
        await sendQueue;
        if (!failed && !disposed && !abortedCaptureStartup) await finishControls();
        mediaAdmissionOpen = false;
        await disposeCapture();
        state = failed ? 'failed' : 'stopped';
      } catch (error) {
        fail(error instanceof DialpadBrowserSessionError ? error : new DialpadBrowserSessionError('interrupted', 'Recording could not finish cleanly.'));
        await disposeCapture();
      } finally {
        mediaAdmissionOpen = false;
        if (socket) {
          detach();
          try { socket.close(1000, 'recording session stopped'); } catch { /* closed */ }
        }
      }
    })();
    return stopPromise;
  }

  async function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (disposed) throw new DialpadBrowserSessionError('interrupted', 'Recording session has been disposed.');
    if (state === 'stopped' || state === 'stopping') throw new DialpadBrowserSessionError('interrupted', 'Recording session was stopped before it started.');
    startPromise = (async () => {
      socket = (options.socketFactory ?? defaultSocketFactory)(options.endpoint);
      socket.addEventListener('open', listener.open);
      socket.addEventListener('message', listener.message);
      socket.addEventListener('error', listener.error);
      socket.addEventListener('close', listener.close);
      if (socket.readyState === OPEN) await onOpen();
      const started = Date.now();
      while (state !== 'recording') {
        if (failed) throw failed;
        if (stopPromise || disposed) throw new DialpadBrowserSessionError('interrupted', 'Recording session was stopped before it started.');
        if (Date.now() - started >= readyTimeoutMs) {
          const error = new DialpadBrowserSessionError('timeout', 'Recording transport did not hydrate before the deadline.');
          fail(error);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    return startPromise;
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      await disposeCapture();
      return;
    }
    disposed = true;
    mediaAdmissionOpen = false;
    lifecycleGeneration += 1;
    settlePendingChunkAcks(new DialpadBrowserSessionError('interrupted', 'Recording session was disposed.'));
    settlePendingPcmAcks(new DialpadBrowserSessionError('interrupted', 'Recording session was disposed.'));
    settleTiming(new DialpadBrowserSessionError('interrupted', 'Recording session was disposed.'));
    if (socket) {
      detach();
      try { socket.close(1000, 'recording session disposed'); } catch { /* closed */ }
    }
    await disposeCapture();
    if (state !== 'failed') state = 'stopped';
  }

  return { state: () => state, start, stop, dispose };
}
