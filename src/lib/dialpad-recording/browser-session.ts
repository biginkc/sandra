import {
  DIALPAD_BROWSER_PROTOCOL,
  encodeDialpadBrowserBinary,
  parseDialpadBrowserServerMessage,
  type DialpadBrowserCaptureStateMessage,
  type DialpadBrowserMeasurementSnapshotMessage,
  type DialpadBrowserServerMessage,
  type DialpadBrowserTrack,
} from './browser-protocol';
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
  readonly maxPendingRecordingChunks?: number;
  readonly maxPendingPackets?: number;
  readonly maxBufferedBytes?: number;
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
const DEFAULT_MAX_PENDING_CHUNKS = 8;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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
  const maxPendingChunks = options.maxPendingRecordingChunks ?? DEFAULT_MAX_PENDING_CHUNKS;
  const maxPendingPackets = options.maxPendingPackets ?? 64;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  if (!Number.isSafeInteger(options.epoch) || options.epoch < DIALPAD_BROWSER_PROTOCOL.minEpoch || options.epoch > DIALPAD_BROWSER_PROTOCOL.maxEpoch) {
    throw new DialpadBrowserSessionError('protocol', 'Invalid recording epoch.');
  }
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw new DialpadBrowserSessionError('protocol', 'Recording transport endpoint is invalid.'); }
  if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/dialpad-browser-ingest') throw new DialpadBrowserSessionError('protocol', 'Recording transport must use the trusted WSS endpoint.');
  if (!options.token || !Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1 || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || !Number.isSafeInteger(maxPendingChunks) || maxPendingChunks < 1 || !Number.isSafeInteger(maxPendingPackets) || maxPendingPackets < 1 || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
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

  async function onOpen(): Promise<void> {
    if (!socket || opened || failed) return;
    opened = true;
    state = 'authenticating';
    try {
      await enqueueSend(JSON.stringify({ type: 'auth', token: options.token, epoch: options.epoch, controlVersion: DIALPAD_BROWSER_PROTOCOL.controlVersion }));
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
          await options.capture.attach(sinks, options.epoch);
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
    if (frame.epoch !== options.epoch || !isTrack(frame.track) || frame.bytes.byteLength !== DIALPAD_BROWSER_PROTOCOL.pcmPayloadBytes) {
      fail(new DialpadBrowserSessionError('protocol', 'PCM frame did not match the session contract.'));
      return;
    }
    const end = frame.frameIndex * 320 + 320;
    pcmEndSamples.set(frame.track, Math.max(pcmEndSamples.get(frame.track) ?? 0, end));
    await enqueueSend(encodeDialpadBrowserBinary({ kind: 'pcm', track: frame.track, epoch: options.epoch, sequence: frame.frameIndex, sampleClock: frame.frameIndex * 320, payload: frame.bytes }));
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
      try {
        await captureStartPromise;
        await activeCapture?.stop();
        await sendQueue;
        if (!failed && !disposed) await finishControls();
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
    if (socket) {
      detach();
      try { socket.close(1000, 'recording session disposed'); } catch { /* closed */ }
    }
    await disposeCapture();
    if (state !== 'failed') state = 'stopped';
  }

  return { state: () => state, start, stop, dispose };
}
