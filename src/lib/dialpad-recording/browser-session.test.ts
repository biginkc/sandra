import { describe, expect, it } from 'vitest';

import type { BrowserCaptureSinks, EncodedMediaChunk, PreparedDialpadCapture } from './browser-capture';
import { decodeDialpadBrowserBinary } from './browser-protocol';
import {
  createDialpadBrowserSession,
  type DialpadBrowserSocket,
  type DialpadBrowserSocketEvent,
  type DialpadBrowserSocketMessage,
} from './browser-session';

const ENDPOINT = 'wss://recording.example.test/dialpad-browser-ingest';

class FakeSocket implements DialpadBrowserSocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: (string | ArrayBuffer | Uint8Array)[] = [];
  private readonly listeners = new Map<string, Set<(event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent) => void>>();

  send(data: string | ArrayBuffer | Uint8Array): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  open(): void { this.readyState = 1; this.emit('open', {}); }
  message(data: string): void { this.emit('message', { data }); }
  error(reason = 'socket failed'): void { this.emit('error', { reason }); }
  private emit(type: string, event: DialpadBrowserSocketMessage & DialpadBrowserSocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

function serverHydrate(socket: FakeSocket): void {
  socket.message(JSON.stringify({ type: 'ready', epoch: 1, controlVersion: 2 }));
  socket.message(JSON.stringify({
    type: 'measurement_snapshot', epoch: 1, revision: 0, totalSamples: 0,
    measurementStatus: 'provisional', threshold: { crossed: false, crossingEpoch: null, crossingSample: null }, degradedReasons: [],
  }));
  socket.message(JSON.stringify({ type: 'capture_state', epoch: 1, latestConsumedEpoch: 1, state: 'open', drainDeadlineAt: null }));
}

function fakeCapture(onStart: (sinks: BrowserCaptureSinks) => void): PreparedDialpadCapture {
  return {
    proof: { handle: 'h', origin: 'https://app.example.test' },
    start: async (sinks) => {
      if (!sinks) throw new Error('fake capture requires network sinks');
      onStart(sinks);
      return { state: () => 'recording', stop: async () => undefined, dispose: async () => undefined };
    },
    dispose: async () => undefined,
  };
}

const format = (track: 'tab' | 'mic') => ({
  track, contextSampleRateHz: 48_000, inputChannels: 1, recordingMimeType: 'audio/webm;codecs=opus' as const,
  pcmSampleRateHz: 16_000 as const, pcmChannels: 1 as const, pcmEncoding: 's16le' as const,
});

const pcmFrame = (track: 'tab' | 'mic', frameIndex: number) => ({
  track, epoch: 1, frameIndex, samples: new Int16Array(320), bytes: new Uint8Array(640),
});

function binarySent(socket: FakeSocket): Uint8Array[] {
  return socket.sent.filter((entry): entry is Uint8Array => entry instanceof Uint8Array);
}

describe('Dialpad browser session', () => {
  it('authenticates first, hydrates authoritative state, and sends formats before PCM', async () => {
    const socket = new FakeSocket();
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket,
      capture: fakeCapture((sinks) => {
        void sinks.onTrackFormat?.(format('tab'));
        void sinks.onTrackFormat?.(format('mic'));
        void sinks.onPcmFrame({ track: 'tab', epoch: 1, frameIndex: 0, samples: new Int16Array(320), bytes: new Uint8Array(640) });
      }),
    });
    const started = session.start();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: 'auth', token: 'token', epoch: 1, controlVersion: 2 });
    serverHydrate(socket);
    await started;
    const controls = socket.sent.filter((entry): entry is string => typeof entry === 'string').map((entry) => JSON.parse(entry).type);
    expect(controls).toEqual(['auth', 'track_format', 'track_format']);
    expect(binarySent(socket)).toHaveLength(1);
    expect(session.state()).toBe('recording');
  });

  it('holds a recording chunk until its matching ACK and finishes both tracks only after drain responses', async () => {
    const socket = new FakeSocket();
    let chunk: EncodedMediaChunk | null = null;
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, ackTimeoutMs: 100,
      capture: fakeCapture((sinks) => {
        void sinks.onTrackFormat?.(format('tab'));
        void sinks.onTrackFormat?.(format('mic'));
        void sinks.onPcmTail?.({ track: 'tab', epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 320, creditedSamples: 320, uncreditedTailSamples: 0 });
        void sinks.onPcmTail?.({ track: 'mic', epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 320, creditedSamples: 320, uncreditedTailSamples: 0 });
        chunk = { track: 'tab', epoch: 1, seq: 0, blob: new Blob([new Uint8Array([1, 2, 3])]), byteLength: 3 };
        void sinks.onWebmChunk(chunk);
      }),
    });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await started;
    const firstBinary = binarySent(socket);
    expect(firstBinary).toHaveLength(1);
    socket.message(JSON.stringify({ type: 'recording_chunk_ack', track: 'tab', epoch: 1, seq: 0, status: 'recorded' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.stop();
    expect(chunk).not.toBeNull();
    const controls = socket.sent.filter((entry): entry is string => typeof entry === 'string').map((entry) => JSON.parse(entry).type);
    expect(controls).toContain('recording_eof');
    expect(controls).toContain('pcm_eof');
    socket.message(JSON.stringify({ type: 'recording_eof_ack', track: 'tab', epoch: 1, lastSeq: 0 }));
    socket.message(JSON.stringify({ type: 'pcm_eof_drained', track: 'tab', epoch: 1, endSample: 0 }));
    socket.message(JSON.stringify({ type: 'pcm_eof_drained', track: 'mic', epoch: 1, endSample: 0 }));
  });

  it('fails closed when a chunk ACK does not arrive before the bounded deadline', async () => {
    const failures: string[] = [];
    const socket = new FakeSocket();
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, ackTimeoutMs: 10,
      onFailure: (error) => failures.push(error.code),
      capture: fakeCapture((sinks) => {
        void sinks.onTrackFormat?.(format('tab'));
        void sinks.onTrackFormat?.(format('mic'));
        void sinks.onWebmChunk({ track: 'tab', epoch: 1, seq: 0, blob: new Blob([new Uint8Array([1])]), byteLength: 1 });
      }),
    });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.state()).toBe('failed');
    expect(failures).toContain('timeout');
  });

  it('pipelines a dual-track prefix beyond 64 frames behind a global 32-frame PCM receipt window', async () => {
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    const sentSequences: Record<'tab' | 'mic', number[]> = { tab: [], mic: [] };
    const events: string[] = [];
    const failures: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let captureDrain = Promise.resolve();
    socket.send = (data) => {
      originalSend(data);
      if (data instanceof Uint8Array) {
        const frame = decodeDialpadBrowserBinary(data);
        if (frame.kind === 'pcm') {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          sentSequences[frame.track].push(frame.sequence);
          setTimeout(() => {
            events.push(`ack:pcm:${frame.track}:${frame.sequence}`);
            inFlight -= 1;
            socket.message(JSON.stringify({ type: 'pcm_frame_ack', epoch: 1, track: frame.track, seq: frame.sequence }));
          }, 5);
        } else {
          setTimeout(() => socket.message(JSON.stringify({ type: 'recording_chunk_ack', track: frame.track, epoch: 1, seq: frame.sequence, status: 'recorded' })), 5);
        }
        return;
      }
      if (typeof data !== 'string') return;
      const message = JSON.parse(data) as { type?: string; epoch?: number; track?: 'tab' | 'mic'; lastSeq?: number; endSample?: number };
      events.push(`send:${message.type ?? 'unknown'}`);
      if (message.type === 'recording_eof') {
        setTimeout(() => socket.message(JSON.stringify({ type: 'recording_eof_ack', epoch: 1, track: message.track, lastSeq: message.lastSeq })), 5);
      } else if (message.type === 'pcm_eof') {
        setTimeout(() => socket.message(JSON.stringify({ type: 'pcm_eof_drained', epoch: 1, track: message.track, endSample: message.endSample })), 5);
      }
    };
    const capture: PreparedDialpadCapture = {
      proof: { handle: 'h', origin: 'https://app.example.test' },
      start: async (maybeSinks) => {
        if (!maybeSinks) throw new Error('fake capture requires network sinks');
        const sinks = maybeSinks;
        await sinks.onTrackFormat?.(format('tab'));
        await sinks.onTrackFormat?.(format('mic'));
        const inputs: Promise<void>[] = [];
        for (let index = 0; index < 96; index += 1) {
          inputs.push(Promise.resolve(sinks.onPcmFrame(pcmFrame('tab', index))));
          inputs.push(Promise.resolve(sinks.onPcmFrame(pcmFrame('mic', index))));
        }
        inputs.push(Promise.resolve(sinks.onWebmChunk({ track: 'tab', epoch: 1, seq: 0, blob: new Blob([new Uint8Array([1])]), byteLength: 1 })));
        inputs.push(Promise.resolve(sinks.onWebmChunk({ track: 'mic', epoch: 1, seq: 0, blob: new Blob([new Uint8Array([2])]), byteLength: 1 })));
        captureDrain = Promise.all(inputs).then(async () => {
          await sinks.onPcmTail?.({ track: 'tab', epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 96 * 320, creditedSamples: 96 * 320, uncreditedTailSamples: 0 });
          await sinks.onPcmTail?.({ track: 'mic', epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 96 * 320, creditedSamples: 96 * 320, uncreditedTailSamples: 0 });
        });
        return { state: () => 'recording', stop: async () => captureDrain, dispose: async () => captureDrain };
      },
      dispose: async () => captureDrain,
    };
    const session = createDialpadBrowserSession({ endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, ackTimeoutMs: 500, capture, onFailure: (error) => failures.push(`${error.code}:${error.message}`) });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await started;
    await session.stop();
    expect(failures).toEqual([]);
    expect(maxInFlight).toBeLessThanOrEqual(32);
    expect(sentSequences.tab).toEqual(Array.from({ length: 96 }, (_, index) => index));
    expect(sentSequences.mic).toEqual(Array.from({ length: 96 }, (_, index) => index));
    const lastPcmAck = Math.max(...events.map((event, index) => event.startsWith('ack:pcm:') ? index : -1));
    const firstPcmEof = events.findIndex((event) => event === 'send:pcm_eof');
    expect(lastPcmAck).toBeGreaterThanOrEqual(0);
    expect(firstPcmEof).toBeGreaterThan(lastPcmAck);
    expect(session.state()).toBe('stopped');
  });

  it('fails closed on an unknown PCM ACK and ignores a duplicate of an acknowledged frame', async () => {
    const socket = new FakeSocket();
    let frameSent!: Promise<void>;
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, ackTimeoutMs: 100,
      capture: fakeCapture((sinks) => { frameSent = Promise.resolve(sinks.onPcmFrame(pcmFrame('tab', 0))); }),
    });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await started;
    socket.message(JSON.stringify({ type: 'pcm_frame_ack', epoch: 1, track: 'tab', seq: 0 }));
    await frameSent;
    socket.message(JSON.stringify({ type: 'pcm_frame_ack', epoch: 1, track: 'tab', seq: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state()).toBe('recording');
    socket.message(JSON.stringify({ type: 'pcm_frame_ack', epoch: 1, track: 'mic', seq: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state()).toBe('failed');
    await session.dispose();
  });

  it('times out a PCM receipt and settles the pending frame on abortive disposal', async () => {
    const socket = new FakeSocket();
    let frameSent!: Promise<void>;
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, ackTimeoutMs: 15,
      capture: fakeCapture((sinks) => { frameSent = Promise.resolve(sinks.onPcmFrame(pcmFrame('tab', 0))); }),
    });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await frameSent;
    expect(session.state()).toBe('failed');

    const secondSocket = new FakeSocket();
    let secondFrame!: Promise<void>;
    const second = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => secondSocket, ackTimeoutMs: 200,
      capture: fakeCapture((sinks) => { secondFrame = Promise.resolve(sinks.onPcmFrame(pcmFrame('tab', 0))); }),
    });
    const secondStarted = second.start();
    secondSocket.open();
    serverHydrate(secondSocket);
    await secondStarted;
    const began = Date.now();
    await second.dispose();
    expect(Date.now() - began).toBeLessThan(100);
    await secondFrame;
  });

  it('rejects a server epoch mismatch before capture starts', async () => {
    const socket = new FakeSocket();
    let captureStarted = false;
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket,
      capture: fakeCapture(() => { captureStarted = true; }),
    });
    const started = session.start();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready', epoch: 2, controlVersion: 2 }));
    await expect(started).rejects.toMatchObject({ code: 'protocol' });
    expect(captureStarted).toBe(false);
  });

  it('stops during startup without waiting for the hydration timeout or reopening the socket', async () => {
    const socket = new FakeSocket();
    let disposed = 0;
    const capture = fakeCapture(() => {});
    const prepared = { ...capture, dispose: async () => { disposed += 1; } };
    const session = createDialpadBrowserSession({ endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, readyTimeoutMs: 1000, capture: prepared });
    const started = session.start();
    socket.open();
    await session.stop();
    await expect(started).rejects.toMatchObject({ code: 'interrupted' });
    expect(session.state()).toBe('stopped');
    expect(disposed).toBe(1);
    await session.dispose();
    expect(disposed).toBe(1);
  });

  it('rejects untrusted endpoint shapes before opening a socket', () => {
    expect(() => createDialpadBrowserSession({ endpoint: 'https://recording.example.test/dialpad-browser-ingest', token: 'token', epoch: 1, capture: fakeCapture(() => {}) })).toThrowError(/trusted WSS/);
    expect(() => createDialpadBrowserSession({ endpoint: 'wss://recording.example.test/dialpad-browser-ingest?token=secret', token: 'token', epoch: 1, capture: fakeCapture(() => {}) })).toThrowError(/trusted WSS/);
  });

  it('fails closed when the native WebSocket buffer is already over the byte budget', async () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 128;
    const failures: string[] = [];
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, maxBufferedBytes: 64,
      onFailure: (error) => failures.push(error.code), capture: fakeCapture(() => {}),
    });
    const started = session.start();
    socket.open();
    await expect(started).rejects.toMatchObject({ code: 'queue_overflow' });
    expect(failures).toEqual(['queue_overflow']);
    expect(session.state()).toBe('failed');
  });

  it('rejects an EOF acknowledgement that was not requested for the exact range', async () => {
    const socket = new FakeSocket();
    const failures: string[] = [];
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket,
      onFailure: (error) => failures.push(error.code), capture: fakeCapture(() => {}),
    });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await started;
    socket.message(JSON.stringify({ type: 'recording_eof_ack', track: 'tab', epoch: 1, lastSeq: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.state()).toBe('failed');
    expect(failures).toContain('protocol');
  });

  it('owns chunk ACK rejection when the native socket send throws', async () => {
    const socket = new FakeSocket();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    socket.send = (data) => {
      if (data instanceof Uint8Array) throw new Error('native send failed');
      socket.sent.push(data);
    };
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket,
      capture: fakeCapture((sinks) => {
        void sinks.onTrackFormat?.(format('tab'));
        void sinks.onTrackFormat?.(format('mic'));
        void sinks.onWebmChunk({ track: 'tab', epoch: 1, seq: 0, blob: new Blob([new Uint8Array([1])]), byteLength: 1 });
      }),
    });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await expect(started).rejects.toMatchObject({ code: 'socket' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.removeListener('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('aborts promptly during a held prefix ACK instead of waiting for graceful drain', async () => {
    const socket = new FakeSocket();
    let chunkDelivery: Promise<void> | undefined;
    const session = createDialpadBrowserSession({
      endpoint: ENDPOINT, token: 'token', epoch: 1, socketFactory: () => socket, ackTimeoutMs: 200,
      capture: fakeCapture((sinks) => {
        void sinks.onTrackFormat?.(format('tab'));
        void sinks.onTrackFormat?.(format('mic'));
        chunkDelivery = Promise.resolve(sinks.onWebmChunk({ track: 'tab', epoch: 1, seq: 0, blob: new Blob([new Uint8Array([1])]), byteLength: 1 }));
      }),
    });
    const started = session.start();
    socket.open();
    serverHydrate(socket);
    await started;
    const began = Date.now();
    await session.dispose();
    expect(Date.now() - began).toBeLessThan(100);
    await chunkDelivery;
    expect(session.state()).toBe('stopped');
  });
});
