import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('@/lib/errors/report', () => ({ reportError }));

import {
  ADMISSION,
  AUDIO_BUCKET,
  RecordingTimeoutError,
  keyFingerprint,
  parseCallRecording,
  parseRetryAfterMs,
  parseShareLink,
  runRecordingTick,
  type AttemptReason,
  type AttemptState,
  type AudioFailKind,
  type AudioFetchInit,
  type AudioStorage,
  type DecodeResult,
  type DiscoveryOutcome,
  type QueueAttempt,
  type RecordingAudioDb,
  type RecordingAudioDeps,
  type RecordingQueue,
  type TakeResult,
} from './recording-audio';

// ---- fakes ---------------------------------------------------------------------------------------------------

const KEY = 'dialpad-test-key-0123456789abcdef';
const KEY_REF = 'env:DIALPAD_CTI_DIRECTORY_KEY_TEST';
const ENV = { DIALPAD_CTI_DIRECTORY_KEY_TEST: KEY };
const ORG = '11111111-1111-4111-8111-111111111111';
const REC = '5185307806048256';
const CALL = '5359947450982400';
const BYTES = new Uint8Array(40_000).fill(7);
const body = (b: Uint8Array) => b as unknown as BodyInit;
const SHA = createHash('sha256').update(BYTES).digest('hex');

class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  sleep = async (ms: number) => { this.t += ms; };
}

interface Audio {
  id: string; orgId: string; callActivityId: string; providerCallId: string; providerRecordingId: string; durationMs: number;
  state: string; attempts: number; failKinds: string[]; expectedSha?: string; expectedSize?: number; path?: string; warning?: string;
}
interface Attempt {
  id: string; audioId: string; orgId: string; state: string; reason?: string; shareLinkId?: string; itemId?: string; createdById?: string; callId?: string; holder: string;
}

class Env {
  clock = new Clock();
  /** Per-call latency applied to every DB/RPC call, and to every Storage call, and to every fake Dialpad response. */
  dbLatency = 0;
  storageLatency = 0;
  /** Extra latency for DB calls whose name starts with the key (e.g. 'block', 'audioFail'). */
  dbExtra: Record<string, number> = {};
  httpLatency = 0;
  dbTimesOut = false;
  httpHangs = false;
  flagOn = true;
  canary: string[] = [];
  audio = new Map<string, Audio>();
  attempts = new Map<string, Attempt>();
  objects = new Map<string, Uint8Array>();
  worker = { holder: null as string | null, until: 0, lastRequestAt: null as number | null, lastCallGetAt: null as number | null, blockedUntil: null as number | null };
  denied: { orgId: string; keyRef: string | null }[] = [];
  discoveryDue: { id: string; orgId: string; providerCallId: string; endedAt: string; attempts: number; keyRef: string }[] = [];
  discoveryResults: { audioId: string; outcome: DiscoveryOutcome; extra?: unknown }[] = [];
  requeues: { orgId: string; fp: string }[] = [];
  dbCalls: string[] = [];
  requests: { at: number; method: string; path: string; auth: string | null; host: string; call: 'call_get' | 'other' }[] = [];
  /** Hooks */
  failRegisterOnce = false;
  afterRegister: (() => void) | null = null;
  beforeStepB: number | null = null;
  onStorageDownload: (() => void) | null = null;
  registerAt: number | null = null;
  server: (req: { method: string; url: URL; headers: Record<string, string> }) => Response | Promise<Response> = () => new Response('not found', { status: 404 });
  decodeResult: DecodeResult = { ok: true, durationMs: 36_000 };
  decodeCalls = 0;

  private async tick(ms: number): Promise<void> {
    this.clock.t += ms;
  }
  private async dbCall<T>(name: string, run: () => T): Promise<T> {
    this.dbCalls.push(name);
    if (this.dbTimesOut) {
      this.clock.t += 1500;
      throw new RecordingTimeoutError();
    }
    await this.tick(this.dbLatency + Object.entries(this.dbExtra).filter(([k]) => name.startsWith(k)).reduce((n, [, v]) => n + v, 0));
    return run();
  }

  addAudio(over: Partial<Audio> = {}): Audio {
    const id = `audio-${this.audio.size + 1}`;
    const a: Audio = {
      id, orgId: ORG, callActivityId: `call-${id}`, providerCallId: CALL, providerRecordingId: REC, durationMs: 36_000,
      state: 'discovered', attempts: 0, failKinds: [], ...over,
    };
    this.audio.set(a.id, a);
    return a;
  }

  eligible(a: Audio): boolean {
    return this.flagOn && (this.canary.length === 0 || this.canary.includes(a.providerCallId));
  }
  unresolved(audioId: string): boolean {
    return [...this.attempts.values()].some((t) => t.audioId === audioId && ['requested', 'live', 'downloaded', 'ambiguous'].includes(t.state));
  }

  db: RecordingAudioDb = {
    take: (holder) => this.dbCall('take', (): TakeResult => {
      if (this.worker.until >= this.clock.t) return { taken: false, lastRequestAt: null, lastCallGetAt: null, blockedUntil: null };
      this.worker.holder = holder;
      this.worker.until = this.clock.t + 90_000;
      return { taken: true, lastRequestAt: this.worker.lastRequestAt, lastCallGetAt: this.worker.lastCallGetAt, blockedUntil: this.worker.blockedUntil };
    }),
    release: (holder, lastRequestAt, lastCallGetAt) => this.dbCall('release', () => {
      if (this.worker.holder !== holder) return;
      this.worker.until = this.clock.t;
      this.worker.lastRequestAt = Math.max(this.worker.lastRequestAt ?? 0, lastRequestAt ?? 0) || null;
      this.worker.lastCallGetAt = Math.max(this.worker.lastCallGetAt ?? 0, lastCallGetAt ?? 0) || null;
    }),
    block: (_holder, untilMs) => this.dbCall('block', () => { this.worker.blockedUntil = Math.max(this.worker.blockedUntil ?? 0, untilMs); }),
    queue: (holder) => this.dbCall('queue', (): RecordingQueue => {
      for (const t of this.attempts.values()) if (t.state === 'requested' && t.holder !== holder) { t.state = 'ambiguous'; t.reason = 'unknown_outcome'; }
      const cleanup: QueueAttempt[] = [...this.attempts.values()].filter((t) => t.state === 'live' || t.state === 'downloaded').map((t) => ({
        id: t.id, audioId: t.audioId, orgId: t.orgId, state: t.state as 'live' | 'downloaded', shareLinkId: t.shareLinkId!, itemId: t.itemId!,
        createdById: t.createdById!, callId: t.callId!, keyRef: KEY_REF,
      }));
      const ambiguous = [...this.attempts.values()].filter((t) => t.state === 'ambiguous').map((t) => ({ id: t.id, audioId: t.audioId, reason: t.reason!, shareLinkId: t.shareLinkId ?? null }));
      const uploading = [...this.audio.values()].filter((a) => a.state === 'uploading').map((a) => ({
        id: a.id, orgId: a.orgId, callActivityId: a.callActivityId, providerRecordingId: a.providerRecordingId, storagePath: a.path!,
        expectedSha256: a.expectedSha!, expectedSize: a.expectedSize!, providerDurationMs: a.durationMs,
      }));
      const ready = [...this.audio.values()].find((a) => a.state === 'discovered' && this.eligible(a) && !this.unresolved(a.id));
      return {
        cleanup, ambiguous, uploading,
        download: ready ? { id: ready.id, orgId: ready.orgId, callActivityId: ready.callActivityId, providerCallId: ready.providerCallId, providerRecordingId: ready.providerRecordingId, providerDurationMs: ready.durationMs, keyRef: KEY_REF } : null,
        discovery: this.flagOn ? this.discoveryDue : [],
        deniedOrgs: this.denied,
      };
    }),
    discoveryResult: (_h, audioId, outcome, extra) => this.dbCall('discoveryResult', () => { this.discoveryResults.push({ audioId, outcome, extra }); }),
    requeueDenied: (_h, orgId, fp) => this.dbCall('requeueDenied', () => { this.requeues.push({ orgId, fp }); return 1; }),
    attemptBegin: (holder, audioId) => this.dbCall('attemptBegin', () => {
      if (this.unresolved(audioId)) return { blocked: true as const };
      const id = `attempt-${this.attempts.size + 1}`;
      this.attempts.set(id, { id, audioId, orgId: ORG, state: 'requested', holder });
      return { blocked: false as const, attemptId: id };
    }),
    attemptSet: (_h, attemptId, to: AttemptState, extra = {}) => this.dbCall(`attemptSet:${to}`, () => {
      const t = this.attempts.get(attemptId)!;
      t.state = to;
      if (extra.reason) t.reason = extra.reason as AttemptReason;
      if (extra.shareLinkId) t.shareLinkId = extra.shareLinkId;
      if (extra.itemId) t.itemId = extra.itemId;
      if (extra.createdById) t.createdById = extra.createdById;
      if (extra.callId) t.callId = extra.callId;
    }),
    audioFail: (_h, audioId, kind: AudioFailKind, extra) => this.dbCall(`audioFail:${kind}`, () => {
      const a = this.audio.get(audioId)!;
      a.failKinds.push(kind);
      if (extra?.warning) a.warning = extra.warning;
      if (kind === 'rate_limited') a.state = 'discovered';
      else if (kind === 'too_large' || kind === 'decode_timeout' || kind === 'denied' || kind === 'invalid_media') a.state = kind === 'invalid_media' ? 'invalid_media' : kind;
      else { a.state = 'discovered'; a.attempts += 1; }
    }),
    markUploading: (_h, audioId, sha, size) => this.dbCall('markUploading', () => {
      const a = this.audio.get(audioId)!;
      a.state = 'uploading'; a.expectedSha = sha; a.expectedSize = size; a.path = `${a.orgId}/${a.callActivityId}/${a.providerRecordingId}.mp3`;
    }),
    registerStored: (_h, audioId) => this.dbCall('registerStored', () => {
      if (this.failRegisterOnce) { this.failRegisterOnce = false; throw new Error('register failed'); }
      this.audio.get(audioId)!.state = 'stored';
      this.afterRegister?.();
    }),
  };

  storage: AudioStorage = {
    upload: async (path, bytes) => {
      this.dbCalls.push('storage:upload');
      await this.tick(this.storageLatency);
      if (this.objects.has(path)) return 'exists';
      this.objects.set(path, bytes);
      return 'ok';
    },
    download: async (path) => {
      this.dbCalls.push('storage:download');
      this.onStorageDownload?.();
      await this.tick(this.storageLatency);
      return this.objects.get(path) ?? null;
    },
    remove: async (path) => { this.dbCalls.push('storage:remove'); await this.tick(this.storageLatency); this.objects.delete(path); },
  };

  fetchImpl = async (url: string, init: AudioFetchInit): Promise<Response> => {
    const u = new URL(url);
    const headers = init.headers;
    const path = u.pathname;
    this.requests.push({ at: this.clock.t, method: init.method, path, auth: headers.Authorization ?? null, host: u.hostname, call: path.startsWith('/api/v2/call/') ? 'call_get' : 'other' });
    if (this.httpHangs) {
      this.clock.t += (init.signal as unknown as { timeoutMs: number }).timeoutMs;
      throw new RecordingTimeoutError();
    }
    const response = await this.server({ method: init.method, url: u, headers });
    this.clock.t += this.httpLatency;
    return response;
  };

  deps = (over: Partial<RecordingAudioDeps> = {}): RecordingAudioDeps => ({
    db: this.db,
    storage: this.storage,
    fetchImpl: this.fetchImpl,
    clock: this.clock,
    decode: async () => { this.decodeCalls += 1; return this.decodeResult; },
    env: ENV,
    schemaReady: async () => { this.dbCalls.push('schemaReady'); this.clock.t += this.dbLatency; if (this.dbTimesOut) { this.clock.t += 1500; throw new RecordingTimeoutError(); } return true; },
    bucketReady: async () => { this.dbCalls.push('bucketReady'); this.clock.t += this.dbLatency; return true; },
    bound: (_ms, run) => run(),
    signalFor: (ms) => Object.assign(new AbortController().signal, { timeoutMs: ms }),
    ...over,
  });

  tickOnce(over: Partial<RecordingAudioDeps> = {}, t0 = this.clock.t) {
    return runRecordingTick(this.deps(over), t0);
  }
  /** Request starts, in order, excluding nothing. */
  starts(): number[] { return this.requests.map((r) => r.at); }
  gaps(): number[] { return this.starts().slice(1).map((t, i) => t - this.starts()[i]!); }
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const linkBody = (over: Record<string, unknown> = {}) => ({ id: '9001', access_link: 'https://dialpad.com/blob/abc/abc.mp3', item_id: REC, created_by_id: '77', call_id: CALL, privacy: 'company', type: 'admincallrecording', ...over });
const audioResponse = (init: ResponseInit = {}, bytes: Uint8Array = BYTES) =>
  new Response(body(bytes), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }, ...init });

/** The proven flow: POST -> access_link (redirect once) -> audio, DELETE 200 then 404. */
function happyServer(env: Env, over: { audio?: (n: number) => Response; post?: () => Response; del?: () => Response; getById?: () => Response } = {}) {
  let hop = 0;
  env.server = ({ method, url }) => {
    if (method === 'POST' && url.pathname === '/api/v2/recordingsharelink') return over.post?.() ?? json(linkBody());
    if (method === 'DELETE' && url.pathname.startsWith('/api/v2/recordingsharelink/')) return over.del?.() ?? json({});
    if (method === 'GET' && url.pathname.startsWith('/api/v2/recordingsharelink/')) return over.getById?.() ?? json(linkBody());
    if (method === 'GET' && url.pathname === '/blob/abc/abc.mp3') {
      hop += 1;
      return new Response(null, { status: 302, headers: { location: 'https://dialpad.com/blob/cdn/final.mp3' } });
    }
    if (method === 'GET' && url.pathname === '/blob/cdn/final.mp3') return over.audio?.(hop) ?? audioResponse();
    return new Response('not found', { status: 404 });
  };
}

beforeEach(() => {
  reportError.mockClear();
});

// ---- tests ---------------------------------------------------------------------------------------------------

describe('parsers', () => {
  it('Retry-After: delta-seconds or HTTP date, floor 30 s, missing/unparseable 60 s, no upper clamp', () => {
    const now = Date.UTC(2026, 9, 6, 12, 0, 0);
    expect(parseRetryAfterMs('7200', now)).toBe(7_200_000);
    expect(parseRetryAfterMs('5', now)).toBe(30_000);
    expect(parseRetryAfterMs(null, now)).toBe(60_000);
    expect(parseRetryAfterMs('soon', now)).toBe(60_000);
    expect(parseRetryAfterMs(new Date(now + 3 * 3_600_000).toUTCString(), now)).toBe(3 * 3_600_000);
    expect(parseRetryAfterMs(new Date(now - 1000).toUTCString(), now)).toBe(30_000);
    expect(parseRetryAfterMs('999999', now)).toBe(999_999_000);
  });

  it('call GET: exactly one admin recording with a duration is `one`; none, null duration and callrecording are `none`; two admin is `multi`; int64 ids stay exact', () => {
    const body = (details: unknown) => JSON.stringify({ call_id: 5359947450982400, recording_details: details });
    expect(parseCallRecording(body([{ id: 5185307806048256, recording_type: 'admincallrecording', duration: 36000 }]))).toEqual({ kind: 'one', recordingId: '5185307806048256', durationMs: 36000 });
    expect(parseCallRecording('{"recording_details":[{"id":9223372036854775807,"recording_type":"admincallrecording","duration":5000}]}')).toEqual({ kind: 'one', recordingId: '9223372036854775807', durationMs: 5000 });
    expect(parseCallRecording(body([{ id: 1, recording_type: 'admincallrecording', duration: null }]))).toEqual({ kind: 'none' });
    expect(parseCallRecording(body([{ id: 1, recording_type: 'callrecording', duration: 36000 }]))).toEqual({ kind: 'none' });
    expect(parseCallRecording(body([]))).toEqual({ kind: 'none' });
    expect(parseCallRecording('{"state":"hangup"}')).toEqual({ kind: 'none' });
    expect(parseCallRecording(body([{ id: 1, recording_type: 'admincallrecording', duration: 1 }, { id: 2, recording_type: 'admincallrecording', duration: 2 }]))).toEqual({ kind: 'multi' });
    expect(parseCallRecording('not json')).toBeNull();
    expect(parseCallRecording(body('x'))).toBeNull();
    expect(parseCallRecording(body([{ id: 'bad id!', recording_type: 'admincallrecording', duration: 5 }]))).toBeNull();
  });

  it('share link: keeps int64 ids as text; unusable ids are null', () => {
    expect(parseShareLink('{"id":9223372036854775807,"item_id":5185307806048256,"created_by_id":"77","call_id":5359947450982400,"access_link":"https://dialpad.com/x"}'))
      .toEqual({ id: '9223372036854775807', accessLink: 'https://dialpad.com/x', itemId: '5185307806048256', createdById: '77', callId: '5359947450982400' });
    expect(parseShareLink('{"id":"a b"}')).toMatchObject({ id: null });
    expect(parseShareLink('[]')).toBeNull();
  });
});

describe('readiness and singleton', () => {
  it('a missing schema is `disabled` before any RPC, key use or Storage call', async () => {
    const env = new Env();
    env.addAudio();
    const result = await env.tickOnce({ schemaReady: async () => { env.dbCalls.push('schemaReady'); return false; } });
    expect(result).toMatchObject({ status: 'disabled', reason: 'schema', requests: 0 });
    expect(env.dbCalls).toEqual(['schemaReady']);
  });

  it('a missing or wrong bucket is `disabled` (bucket) with no take and no request; schemaReady is not asked to check it', async () => {
    const env = new Env();
    const result = await env.tickOnce({ bucketReady: async () => { env.dbCalls.push('bucketReady'); return false; } });
    expect(result).toMatchObject({ status: 'disabled', reason: 'bucket', requests: 0 });
    expect(env.dbCalls).toEqual(['schemaReady', 'bucketReady']);
  });

  it('two overlapping invocations: the second is `busy` and makes no request; an expired holder can be taken over', async () => {
    const env = new Env();
    env.addAudio();
    happyServer(env);
    env.worker.until = env.clock.t + 60_000;
    expect(await env.tickOnce()).toMatchObject({ status: 'busy', requests: 0 });
    expect(env.requests).toHaveLength(0);
    env.clock.t += 61_000;
    expect((await env.tickOnce()).status).toBe('ok');
  });

  it('an empty queue is `idle` with no request', async () => {
    const env = new Env();
    expect(await env.tickOnce()).toMatchObject({ status: 'idle', requests: 0 });
    expect(env.dbCalls).toEqual(['schemaReady', 'bucketReady', 'take', 'queue', 'release']);
  });

  it('flag OFF: no discovery, no download and no POST', async () => {
    const env = new Env();
    env.flagOn = false;
    env.addAudio();
    env.discoveryDue.push({ id: 'd1', orgId: ORG, providerCallId: CALL, endedAt: '2026-10-06T12:00:00Z', attempts: 0, keyRef: KEY_REF });
    happyServer(env);
    expect(await env.tickOnce()).toMatchObject({ status: 'idle', requests: 0 });
  });
});

describe('download, the proven flow', () => {
  it('positive-latency empty tick: POST -> 2-hop audio GET -> decode -> upload -> register all complete in one tick and the link is deleted', async () => {
    const env = new Env();
    env.dbLatency = 300;
    env.storageLatency = 300;
    env.httpLatency = 200;
    const a = env.addAudio();
    happyServer(env);
    const t0 = env.clock.t;
    const result = await env.tickOnce();
    expect(env.audio.get(a.id)!.state).toBe('stored');
    expect(result).toMatchObject({ status: 'ok', stored: 1, downloaded: 1, linksDeleted: 1, requests: 4, hosts: ['dialpad.com'] });
    expect(env.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/v2/recordingsharelink', 'GET /blob/abc/abc.mp3', 'GET /blob/cdn/final.mp3', 'DELETE /api/v2/recordingsharelink/9001',
    ]);
    expect([...env.attempts.values()][0]).toMatchObject({ state: 'deleted', shareLinkId: '9001', itemId: REC, callId: CALL });
    expect(env.objects.get(`${ORG}/call-${a.id}/${REC}.mp3`)).toEqual(BYTES);
    expect(env.clock.t - t0).toBeLessThan(55_000);
    for (const gap of env.gaps()) expect(gap).toBeGreaterThanOrEqual(1000);
    // The share-link POST asks for exactly the proven body.
  });

  it('sends the proven POST body, Bearer on every dialpad.com hop, and never logs or reports a key or URL', async () => {
    const env = new Env();
    env.addAudio();
    let posted = '';
    env.server = ({ method, url }) => {
      if (method === 'POST') return json(linkBody());
      if (url.pathname === '/blob/abc/abc.mp3') return new Response(null, { status: 302, headers: { location: 'https://dialpad.com/blob/cdn/final.mp3' } });
      if (url.pathname === '/blob/cdn/final.mp3') return audioResponse();
      return json({});
    };
    const original = env.fetchImpl;
    env.fetchImpl = async (url, init) => { if (init.method === 'POST') posted = String(init.body); return original(url, init); };
    await env.tickOnce();
    expect(JSON.parse(posted)).toEqual({ recording_id: REC, recording_type: 'admincallrecording', privacy: 'company' });
    expect(env.requests.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
    const reported = JSON.stringify(reportError.mock.calls);
    expect(reported).not.toContain(KEY);
    expect(reported).not.toContain('blob/abc');
  });

  it('a hop to another host is refused: the key is never sent there and the row takes a counted error (link stays live for cleanup)', async () => {
    const env = new Env();
    const a = env.addAudio();
    env.server = ({ method, url }) => {
      if (method === 'POST') return json(linkBody());
      if (url.pathname === '/blob/abc/abc.mp3') return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal.mp3' } });
      return json({});
    };
    const result = await env.tickOnce();
    expect(env.requests.some((r) => r.host === 'evil.example.com')).toBe(false);
    expect(result.hosts).toContain('evil.example.com');
    expect(env.audio.get(a.id)).toMatchObject({ state: 'discovered', attempts: 1, failKinds: ['error'] });
    // c' deletes our own link right away when time remains (it was verified in this same tick).
    expect([...env.attempts.values()][0]!.state).toBe('deleted');
  });

  it.each([
    ['plain http link', () => json(linkBody({ access_link: 'http://dialpad.com/blob/abc/abc.mp3' })), 'error'],
    ['link with credentials', () => json(linkBody({ access_link: 'https://u:p@dialpad.com/blob/abc/abc.mp3' })), 'error'],
    ['a host that is not allowed', () => json(linkBody({ access_link: 'https://cdn.example.com/a.mp3' })), 'error'],
  ])('%s is a counted error and nothing is fetched', async (_name, post, kind) => {
    const env = new Env();
    const a = env.addAudio();
    happyServer(env, { post });
    await env.tickOnce();
    expect(env.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/blob'))).toHaveLength(0);
    expect(env.audio.get(a.id)!.failKinds).toEqual([kind]);
  });

  it.each([
    ['an HTML body', () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'error', 'discovered'],
    ['a 206 that does not cover the whole file', () => audioResponse({ headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-99/40000' } }), 'error', 'discovered'],
    ['a short body', () => new Response(body(BYTES.subarray(0, 100)), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '40000' } }), 'error', 'discovered'],
    ['a declared size over the cap', () => new Response(body(BYTES), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(33 * 1024 * 1024) } }), 'too_large', 'too_large'],
    ['a 500', () => new Response('x', { status: 500 }), 'error', 'discovered'],
    ['a 403', () => new Response('x', { status: 403 }), 'error', 'discovered'],
  ])('audio GET returning %s fails the audio, not the link', async (_name, audio, kind, state) => {
    const env = new Env();
    const a = env.addAudio();
    happyServer(env, { audio });
    await env.tickOnce();
    expect(env.audio.get(a.id)).toMatchObject({ state });
    expect(env.audio.get(a.id)!.failKinds).toEqual([kind]);
    expect(env.objects.size).toBe(0);
  });

  it('a stream over 32 MB with no declared size is cut off at the cap', async () => {
    const env = new Env();
    const a = env.addAudio();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 40) return controller.close();
        sent += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    happyServer(env, { audio: () => new Response(stream, { status: 200, headers: { 'content-type': 'audio/mpeg' } }) });
    await env.tickOnce();
    expect(env.audio.get(a.id)).toMatchObject({ state: 'too_large' });
    expect(sent).toBeLessThanOrEqual(34);
  });

  it('a 200 audio response is accepted too, and more than two redirect hops is an error', async () => {
    const env = new Env();
    const a = env.addAudio();
    happyServer(env, { audio: () => new Response(body(BYTES), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(BYTES.length) } }) });
    await env.tickOnce();
    expect(env.audio.get(a.id)!.state).toBe('stored');

    const loop = new Env();
    const b = loop.addAudio();
    loop.server = ({ method, url }) => {
      if (method === 'POST') return json(linkBody());
      if (url.pathname.startsWith('/blob/')) return new Response(null, { status: 302, headers: { location: `https://dialpad.com/blob/h${Math.random()}.mp3` } });
      return json({});
    };
    await loop.tickOnce();
    expect(loop.requests.filter((r) => r.path.startsWith('/blob'))).toHaveLength(3);
    expect(loop.audio.get(b.id)!.failKinds).toEqual(['error']);
  });

  it('decode failure keeps the link `downloaded` (then deleted at the end of the step); decode_timeout is terminal; a duration far from the provider is invalid_media', async () => {
    for (const [decode, kind, state] of [
      [{ ok: false, reason: 'invalid' }, 'invalid_media', 'invalid_media'],
      [{ ok: false, reason: 'timeout' }, 'decode_timeout', 'decode_timeout'],
      [{ ok: true, durationMs: 10_000 }, 'invalid_media', 'invalid_media'],
      [{ ok: true, durationMs: 500 }, 'invalid_media', 'invalid_media'],
    ] as [DecodeResult, string, string][]) {
      const env = new Env();
      const a = env.addAudio();
      happyServer(env);
      env.decodeResult = decode;
      await env.tickOnce();
      expect(env.audio.get(a.id)).toMatchObject({ state });
      expect(env.audio.get(a.id)!.failKinds).toEqual([kind]);
      expect(env.objects.size).toBe(0);
    }
    const ok = new Env();
    const b = ok.addAudio();
    happyServer(ok);
    ok.decodeResult = { ok: true, durationMs: 36_000 + 1_900 }; // within max(2 s, 5%)
    await ok.tickOnce();
    expect(ok.audio.get(b.id)!.state).toBe('stored');
  });

  it('POST outcomes: 429 blocks and stops; 4xx is not_created (403 is denied with the key fingerprint); 5xx and a network error are ambiguous', async () => {
    const run = async (post: () => Response | never) => {
      const env = new Env();
      const a = env.addAudio();
      happyServer(env, { post });
      const result = await env.tickOnce();
      return { env, a, result, attempt: [...env.attempts.values()][0]! };
    };
    const r429 = await run(() => new Response('', { status: 429, headers: { 'retry-after': '7200' } }));
    expect(r429.attempt.state).toBe('not_created');
    expect(r429.result).toMatchObject({ status: 'stopped', reason: 'rate_limited' });
    expect(r429.env.worker.blockedUntil! - r429.env.clock.t).toBeGreaterThan(7_100_000);
    expect(r429.env.audio.get(r429.a.id)!.failKinds).toEqual(['rate_limited']);
    const r400 = await run(() => new Response('', { status: 400 }));
    expect(r400.attempt.state).toBe('not_created');
    expect(r400.env.audio.get(r400.a.id)!.failKinds).toEqual(['error']);
    const r403 = await run(() => new Response('', { status: 403 }));
    expect(r403.attempt.state).toBe('not_created');
    expect(r403.env.audio.get(r403.a.id)!.failKinds).toEqual(['denied']);
    const r500 = await run(() => new Response('', { status: 503 }));
    expect(r500.attempt).toMatchObject({ state: 'ambiguous', reason: 'unknown_outcome' });
    const throwing = await run(() => { throw new TypeError('network'); });
    expect(throwing.attempt).toMatchObject({ state: 'ambiguous', reason: 'unknown_outcome' });
  });

  it('a POST timeout is ambiguous and stops the tick', async () => {
    const env = new Env();
    env.addAudio();
    env.httpHangs = true;
    const result = await env.tickOnce();
    expect([...env.attempts.values()][0]).toMatchObject({ state: 'ambiguous', reason: 'unknown_outcome' });
    expect(result).toMatchObject({ status: 'stopped', reason: 'timeout', requests: 1 });
  });
});

describe('share-link identity', () => {
  it.each([
    ['a different recording', { item_id: '123' }],
    ['a different call', { call_id: '999' }],
    ['no created_by', { created_by_id: null }],
    ['no access link', { access_link: null }],
  ])('a POST response with %s is ambiguous/post_mismatch, never deleted, and blocks later POSTs for three ticks', async (_name, over) => {
    const env = new Env();
    const a = env.addAudio();
    happyServer(env, { post: () => json(linkBody(over)) });
    await env.tickOnce();
    const attempt = [...env.attempts.values()][0]!;
    expect(attempt).toMatchObject({ state: 'ambiguous', reason: 'post_mismatch' });
    expect(env.requests.map((r) => r.method)).toEqual(['POST']);
    const before = { ...attempt };
    for (let i = 0; i < 3; i += 1) {
      env.clock.t += 61_000;
      reportError.mockClear();
      const result = await env.tickOnce();
      expect(result).toMatchObject({ requests: 0, ambiguous: 1 });
      expect(reportError.mock.calls.some(([, ctx]) => (ctx as { tags: { surface: string } }).tags.surface === 'dialpad_share_link_ambiguous')).toBe(true);
    }
    expect(env.requests).toHaveLength(1);
    expect([...env.attempts.values()][0]).toEqual(before);
    expect(env.audio.get(a.id)!.state).toBe('discovered');
  });

  it('a failed download leaves the link live; cleanup finds a different owner, marks it ambiguous/mismatch and keeps it for three ticks with no DELETE and no POST', async () => {
    const env = new Env();
    const a = env.addAudio();
    // The audio GET fails late, so too little time remains to delete our own link in the same tick (< 10.5 s).
    happyServer(env, { audio: () => { env.clock.t += 45_000; return new Response('x', { status: 500 }); }, del: () => { throw new Error('must not delete'); } });
    await env.tickOnce();
    const attempt = [...env.attempts.values()][0]!;
    expect(attempt.state).toBe('live');
    env.server = ({ method }) => (method === 'GET' ? json(linkBody({ created_by_id: 'someone-else' })) : new Response('', { status: 500 }));
    env.requests.length = 0;
    env.clock.t += 61_000;
    await env.tickOnce();
    expect(env.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v2/recordingsharelink/9001']);
    expect(attempt).toMatchObject({ state: 'ambiguous', reason: 'mismatch' });
    const retained = { ...attempt };
    for (let i = 0; i < 3; i += 1) {
      env.clock.t += 61_000;
      reportError.mockClear();
      const result = await env.tickOnce();
      expect(result.requests).toBe(0);
      expect(reportError).toHaveBeenCalled();
    }
    expect(env.requests).toHaveLength(1);
    expect(attempt).toEqual(retained);
    expect(env.audio.get(a.id)!.state).toBe('discovered');
  });
});

describe('cleanup (step a)', () => {
  it('flag OFF, canary excluded and a terminal audio row: a `downloaded` link is still GET-by-id verified then DELETEd, with no discovery or POST', async () => {
    const env = new Env();
    env.flagOn = false;
    env.canary = ['999'];
    const a = env.addAudio({ state: 'invalid_media' });
    env.attempts.set('t1', { id: 't1', audioId: a.id, orgId: ORG, state: 'downloaded', shareLinkId: '9001', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
    happyServer(env);
    const result = await env.tickOnce();
    expect(env.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v2/recordingsharelink/9001', 'DELETE /api/v2/recordingsharelink/9001']);
    expect(env.attempts.get('t1')!.state).toBe('deleted');
    expect(result.linksDeleted).toBe(1);
    expect(env.audio.get(a.id)!.state).toBe('invalid_media');
  });

  it('GET-by-id 404 is deleted without a DELETE; 5xx and 401 leave the link for the next tick', async () => {
    for (const [status, expected, methods] of [[404, 'deleted', ['GET']], [500, 'live', ['GET']], [401, 'live', ['GET']]] as const) {
      const env = new Env();
      env.flagOn = false;
      const a = env.addAudio({ state: 'stored' });
      env.attempts.set('t1', { id: 't1', audioId: a.id, orgId: ORG, state: 'live', shareLinkId: '9001', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
      env.server = () => new Response('', { status });
      await env.tickOnce();
      expect(env.attempts.get('t1')!.state).toBe(expected);
      expect(env.requests.map((r) => r.method)).toEqual(methods);
    }
  });

  it('a DELETE that fails leaves the link `downloaded`; the next tick deletes it; the audio stays stored', async () => {
    const env = new Env();
    env.flagOn = false;
    const a = env.addAudio({ state: 'stored' });
    env.attempts.set('t1', { id: 't1', audioId: a.id, orgId: ORG, state: 'downloaded', shareLinkId: '9001', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
    let deletes = 0;
    happyServer(env, { del: () => (++deletes === 1 ? new Response('', { status: 500 }) : json({})) });
    await env.tickOnce();
    expect(env.attempts.get('t1')!.state).toBe('downloaded');
    env.clock.t += 61_000;
    await env.tickOnce();
    expect(env.attempts.get('t1')!.state).toBe('deleted');
    expect(env.audio.get(a.id)!.state).toBe('stored');
  });

  it('a link whose GET-by-id body does not parse is never deleted', async () => {
    const env = new Env();
    env.flagOn = false;
    const a = env.addAudio({ state: 'stored' });
    env.attempts.set('t1', { id: 't1', audioId: a.id, orgId: ORG, state: 'live', shareLinkId: '9001', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
    env.server = ({ method }) => (method === 'GET' ? new Response('<html>', { status: 200 }) : new Response('', { status: 200 }));
    await env.tickOnce();
    expect(env.attempts.get('t1')).toMatchObject({ state: 'ambiguous', reason: 'mismatch' });
    expect(env.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('a dead holder\'s `requested` POST becomes ambiguous at the next tick without any request', async () => {
    const env = new Env();
    const a = env.addAudio();
    env.attempts.set('t1', { id: 't1', audioId: a.id, orgId: ORG, state: 'requested', holder: 'dead-holder' });
    happyServer(env);
    const result = await env.tickOnce();
    expect(env.attempts.get('t1')).toMatchObject({ state: 'ambiguous', reason: 'unknown_outcome' });
    expect(result.requests).toBe(0);
  });
});

describe('timing', () => {
  it('registration at the deadline: the audio is stored, the link stays `downloaded` (no DELETE in the tick), and the next tick deletes it without touching the audio', async () => {
    const env = new Env();
    const a = env.addAudio();
    happyServer(env);
    const t0 = env.clock.t;
    env.afterRegister = () => { env.clock.t = t0 + 54_000; };
    await env.tickOnce({}, t0);
    expect(env.audio.get(a.id)!.state).toBe('stored');
    expect([...env.attempts.values()][0]!.state).toBe('downloaded');
    expect(env.requests.map((r) => r.method)).toEqual(['POST', 'GET', 'GET']);
    env.afterRegister = null;
    env.clock.t += 61_000;
    await env.tickOnce();
    expect([...env.attempts.values()][0]!.state).toBe('deleted');
    expect(env.audio.get(a.id)!.state).toBe('stored');
  });

  it('bounded timeout: every Dialpad request hangs to its timeout and every DB call is slow; the handler returns before t0 + 55 s with recoverable rows', async () => {
    const env = new Env();
    env.dbLatency = 1_000;
    env.httpHangs = true;
    const a = env.addAudio();
    env.attempts.set('t1', { id: 't1', audioId: a.id, orgId: ORG, state: 'live', shareLinkId: '9001', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
    env.addAudio({ providerCallId: '2' });
    const t0 = env.clock.t;
    const result = await env.tickOnce({}, t0);
    expect(env.clock.t - t0).toBeLessThan(55_000);
    expect(result.status).toBe('stopped');
    expect(env.requests).toHaveLength(1); // the first timeout stops the tick
    expect(env.attempts.get('t1')!.state).toBe('live');
    expect(env.dbCalls.at(-1)).toBe('release');
  });

  it('every DB call timing out: the tick answers slow_start within 2 s with zero Dialpad requests', async () => {
    const env = new Env();
    env.addAudio();
    env.dbTimesOut = true;
    const t0 = env.clock.t;
    const result = await env.tickOnce({}, t0);
    expect(result).toMatchObject({ status: 'slow_start', requests: 0 });
    expect(env.clock.t - t0).toBeLessThan(2_000);
    expect(env.requests).toHaveLength(0);
  });

  it('startup over 5 s releases and answers slow_start with zero Dialpad requests', async () => {
    const env = new Env();
    env.dbLatency = 1_400; // schema + bucket + take + queue = 5.6 s
    env.addAudio();
    happyServer(env);
    const result = await env.tickOnce();
    expect(result).toMatchObject({ status: 'slow_start', reason: 'startup', requests: 0 });
    expect(env.dbCalls.at(-1)).toBe('release');
  });

  it('admission edges: cleanup at 21 s remaining and not at 20.9 s; the download at 49.5 s and not at 49.4 s; discovery at 18 s', async () => {
    const withRemaining = async (remaining: number, setup: (env: Env) => void) => {
      const env = new Env();
      // A first cleanup that uses up exactly (55 s - remaining) before the step under test is considered.
      const burner = env.addAudio({ state: 'stored', providerCallId: '1' });
      env.attempts.set('burn', { id: 'burn', audioId: burner.id, orgId: ORG, state: 'live', shareLinkId: '1', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
      setup(env);
      const original = env.server;
      env.server = (req) => {
        if (req.method === 'GET' && req.url.pathname === '/api/v2/recordingsharelink/1') {
          env.clock.t += 55_000 - remaining - 0; // time consumed by the burner's GET
          return new Response('', { status: 404 });
        }
        return original(req);
      };
      await env.tickOnce();
      return env;
    };
    // cleanup
    for (const [remaining, ran] of [[ADMISSION.cleanup, true], [ADMISSION.cleanup - 100, false]] as const) {
      const env = await withRemaining(remaining, (e) => {
        const a = e.addAudio({ state: 'stored', providerCallId: '2' });
        e.attempts.set('second', { id: 'second', audioId: a.id, orgId: ORG, state: 'live', shareLinkId: '2', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
        e.server = () => new Response('', { status: 404 });
      });
      expect(env.requests.some((r) => r.path.endsWith('/recordingsharelink/2'))).toBe(ran);
    }
    // download
    for (const [remaining, ran] of [[ADMISSION.download, true], [ADMISSION.download - 100, false]] as const) {
      const env = await withRemaining(remaining, (e) => { e.addAudio(); happyServer(e); });
      expect(env.requests.some((r) => r.method === 'POST')).toBe(ran);
    }
    // discovery
    for (const [remaining, ran] of [[ADMISSION.discovery, true], [ADMISSION.discovery - 100, false]] as const) {
      const env = await withRemaining(remaining, (e) => {
        e.discoveryDue.push({ id: 'd1', orgId: ORG, providerCallId: CALL, endedAt: '2026-10-06T12:00:00Z', attempts: 0, keyRef: KEY_REF });
        happyServer(e);
        const base = e.server;
        e.server = (req) => (req.url.pathname.startsWith('/api/v2/call/') ? json({ recording_details: [] }) : base(req));
      });
      expect(env.requests.some((r) => r.path.startsWith('/api/v2/call/'))).toBe(ran);
    }
  });

  it('the own-link DELETE after a download runs at 10.5 s remaining and is deferred to the next tick at 10.4 s', async () => {
    for (const [leftover, deleted] of [[ADMISSION.deleteOwn, true], [ADMISSION.deleteOwn - 100, false]] as const) {
      const env = new Env();
      env.addAudio();
      happyServer(env);
      const t0 = env.clock.t;
      env.afterRegister = () => { env.clock.t = t0 + 55_000 - leftover; };
      await env.tickOnce({}, t0);
      expect([...env.attempts.values()][0]!.state).toBe(deleted ? 'deleted' : 'downloaded');
    }
  });

  it('the widest recovery branch (matching object, decode fails, object removed) is admitted at 29.5 s and finishes before 55 s; at 29.4 s it is not started', async () => {
    for (const [remaining, ran] of [[ADMISSION.recover, true], [ADMISSION.recover - 100, false]] as const) {
      const env = new Env();
      env.storageLatency = 10_000; // read 10 s, remove 10 s
      env.dbExtra = { audioFail: 1_500 };
      const burner = env.addAudio({ state: 'stored', providerCallId: '1' });
      env.attempts.set('burn', { id: 'burn', audioId: burner.id, orgId: ORG, state: 'live', shareLinkId: '1', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
      const a = env.addAudio({ state: 'uploading', expectedSha: SHA, expectedSize: BYTES.length });
      a.path = `${a.orgId}/${a.callActivityId}/${a.providerRecordingId}.mp3`;
      env.objects.set(a.path, BYTES); // sha and size match, so decode runs
      const t0 = env.clock.t;
      env.server = () => { env.clock.t += 55_000 - remaining; return new Response('', { status: 404 }); };
      await env.tickOnce({ decode: async () => { env.clock.t += 8_000; return { ok: false, reason: 'invalid' }; } }, t0);
      expect(env.objects.has(a.path)).toBe(!ran);
      if (ran) {
        expect(env.audio.get(a.id)).toMatchObject({ state: 'discovered', failKinds: ['recovery_reset'] });
        expect(env.clock.t - t0).toBeLessThanOrEqual(55_000);
      }
    }
  });

  it('a discovery that hits a 429 (wait 8 s + GET 8 s + block 1.5 s + record 1.5 s) is admitted at 19 s and finishes before 55 s; at 18.9 s it is not started', async () => {
    for (const [remaining, ran] of [[ADMISSION.discovery, true], [ADMISSION.discovery - 100, false]] as const) {
      const env = new Env();
      env.dbExtra = { block: 1_500, discoveryResult: 1_500 };
      const burner = env.addAudio({ state: 'stored', providerCallId: '1' });
      env.attempts.set('burn', { id: 'burn', audioId: burner.id, orgId: ORG, state: 'live', shareLinkId: '1', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
      env.discoveryDue.push({ id: 'd1', orgId: ORG, providerCallId: CALL, endedAt: '2026-10-06T12:00:00Z', attempts: 0, keyRef: KEY_REF });
      const t0 = env.clock.t;
      // The previous tick's call GET ended just before this admission, so the 8 s spacing wait is the full 8 s.
      env.worker.lastCallGetAt = t0 + (55_000 - remaining);
      env.server = ({ url }) => {
        if (url.pathname.startsWith('/api/v2/call/')) { env.clock.t += 8_000; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); }
        env.clock.t += 55_000 - remaining;
        return new Response('', { status: 404 });
      };
      await env.tickOnce({}, t0);
      expect(env.requests.some((r) => r.call === 'call_get')).toBe(ran);
      if (ran) {
        expect(env.discoveryResults[0]).toMatchObject({ outcome: 'rate_limited' });
        expect(env.clock.t - t0).toBeLessThanOrEqual(55_000);
      }
    }
  });

  it('a refused redirect host is kept as a hostname only (no path, no query) for the canary to read', async () => {
    const env = new Env();
    const a = env.addAudio();
    env.server = ({ method, url }) => {
      if (method === 'POST') return json(linkBody());
      if (url.pathname === '/blob/abc/abc.mp3') return new Response(null, { status: 302, headers: { location: 'https://storage.googleapis.com/bucket/secret.mp3?token=abc' } });
      return json({});
    };
    await env.tickOnce();
    expect(env.audio.get(a.id)!.warning).toBe('storage.googleapis.com');
    expect(env.requests.some((r) => r.host === 'storage.googleapis.com')).toBe(false);
  });

  it('with the real bound (not the test shim) a normal tick still stores the recording', async () => {
    const env = new Env();
    const a = env.addAudio();
    happyServer(env);
    const result = await env.tickOnce({ bound: undefined });
    expect(result.status).toBe('ok');
    expect(env.audio.get(a.id)!.state).toBe('stored');
  });

  it('with the real bound, a readiness check that never answers gives slow_start after 1.5 s and no Dialpad request', async () => {
    vi.useFakeTimers();
    try {
      const env = new Env();
      env.addAudio();
      const pending = env.tickOnce({ bound: undefined, schemaReady: () => new Promise<boolean>(() => undefined) });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toMatchObject({ status: 'slow_start', requests: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the documented budget table equals the constants', () => {
    expect(ADMISSION).toEqual({ cleanup: 21_000, recover: 29_500, download: 49_500, deleteOwn: 10_500, discovery: 19_000 });
    // An empty tick starts its download at <= t0 + 5 s, leaving >= 50 s against 49.5 s.
    expect(55_000 - 5_000).toBeGreaterThanOrEqual(ADMISSION.download);
  });
})

describe('pacing and 429', () => {
  it('request starts are at least 1 s apart (redirect hop included) and call GETs at least 8 s apart, across ticks', async () => {
    const env = new Env();
    env.httpLatency = 50;
    for (let i = 0; i < 3; i += 1) {
      env.discoveryDue.push({ id: `d${i}`, orgId: ORG, providerCallId: String(100 + i), endedAt: '2026-10-06T12:00:00Z', attempts: 0, keyRef: KEY_REF });
    }
    env.addAudio({ state: 'discovered' });
    happyServer(env);
    const base = env.server;
    env.server = (req) => (req.url.pathname.startsWith('/api/v2/call/') ? json({ recording_details: [] }) : base(req));
    await env.tickOnce();
    env.clock.t += 500; // the next tick starts straight after the previous one's last request
    await env.tickOnce();
    expect(env.requests.length).toBeGreaterThan(6);
    for (const gap of env.gaps()) expect(gap).toBeGreaterThanOrEqual(1000);
    const callGets = env.requests.filter((r) => r.call === 'call_get').map((r) => r.at);
    expect(callGets.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < callGets.length; i += 1) expect(callGets[i]! - callGets[i - 1]!).toBeGreaterThanOrEqual(8000);
    // No 60 s window holds more than 8 call GETs.
    for (let i = 0; i < callGets.length; i += 1) expect(callGets.filter((t) => t >= callGets[i]! && t < callGets[i]! + 60_000).length).toBeLessThanOrEqual(8);
  });

  it.each([
    ['the POST', (env: Env) => { env.addAudio(); happyServer(env, { post: () => new Response('', { status: 429, headers: { 'retry-after': '7200' } }) }); }],
    ['hop 2 of the audio GET', (env: Env) => {
      env.addAudio();
      happyServer(env);
      const base = env.server;
      env.server = (req) => (req.url.pathname === '/blob/cdn/final.mp3' ? new Response('', { status: 429, headers: { 'retry-after': '7200' } }) : base(req));
    }],
    ['the GET-by-id', (env: Env) => {
      const a = env.addAudio({ state: 'stored' });
      env.attempts.set('t1', { id: 't1', audioId: a.id, orgId: ORG, state: 'live', shareLinkId: '9001', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
      env.server = () => new Response('', { status: 429, headers: { 'retry-after': '7200' } });
    }],
    ['the call GET', (env: Env) => {
      env.flagOn = true;
      env.discoveryDue.push({ id: 'd1', orgId: ORG, providerCallId: CALL, endedAt: '2026-10-06T12:00:00Z', attempts: 0, keyRef: KEY_REF });
      env.server = () => new Response('', { status: 429, headers: { 'retry-after': '7200' } });
    }],
  ])('a 429 on %s stops the tick and persists an unclamped block; the next tick is `blocked` with zero requests', async (_name, setup) => {
    const env = new Env();
    setup(env);
    const result = await env.tickOnce();
    expect(result).toMatchObject({ status: 'stopped', reason: 'rate_limited' });
    expect(env.worker.blockedUntil).toBeGreaterThanOrEqual(env.clock.t - 1000 + 7_200_000 - 60_000);
    expect(env.worker.blockedUntil! - env.clock.t).toBeGreaterThan(7_000_000);
    const count = env.requests.length;
    env.clock.t += 61_000;
    expect(await env.tickOnce()).toMatchObject({ status: 'blocked', requests: 0 });
    expect(env.requests).toHaveLength(count);
  });

  it('an HTTP-date Retry-After three hours ahead is honoured exactly', async () => {
    const env = new Env();
    env.addAudio();
    const date = new Date(env.clock.t + 3 * 3_600_000).toUTCString();
    happyServer(env, { post: () => new Response('', { status: 429, headers: { 'retry-after': date } }) });
    await env.tickOnce();
    expect(Math.abs(env.worker.blockedUntil! - (env.clock.t + 3 * 3_600_000))).toBeLessThan(5_000);
  });
});

describe('upload recovery (step b)', () => {
  const uploadingRow = (env: Env) => {
    const a = env.addAudio({ state: 'uploading', expectedSha: SHA, expectedSize: BYTES.length });
    a.path = `${a.orgId}/${a.callActivityId}/${a.providerRecordingId}.mp3`;
    return a;
  };

  it('upload ok but register failed: the next tick registers it with zero Dialpad requests from step b and no new attempt', async () => {
    const env = new Env();
    const a = env.addAudio();
    happyServer(env);
    env.failRegisterOnce = true;
    await env.tickOnce();
    expect(env.audio.get(a.id)!.state).toBe('uploading');
    expect([...env.attempts.values()][0]!.state).toBe('downloaded');
    // Next tick: step a may GET/DELETE the downloaded link; step b alone must make no request.
    let requestsAtB = -1;
    let requestsAfterB = -1;
    env.onStorageDownload = () => { requestsAtB = env.requests.length; };
    env.afterRegister = () => { requestsAfterB = env.requests.length; };
    env.requests.length = 0;
    env.clock.t += 61_000;
    await env.tickOnce();
    expect(env.audio.get(a.id)!.state).toBe('stored');
    expect(requestsAfterB).toBe(requestsAtB);
    expect(env.attempts.size).toBe(1);
    expect(env.requests.map((r) => r.method)).toEqual(['GET', 'DELETE']); // step a, for the link only
  });

  it('a different object is removed and the row returns to `discovered`; a missing object returns it to `discovered`; neither makes a request', async () => {
    const mismatch = new Env();
    const a = uploadingRow(mismatch);
    mismatch.objects.set(a.path!, new Uint8Array([1, 2, 3]));
    const r1 = await mismatch.tickOnce();
    expect(mismatch.objects.has(a.path!)).toBe(false);
    expect(mismatch.audio.get(a.id)).toMatchObject({ state: 'discovered', failKinds: ['recovery_reset'] });
    expect(r1.requests).toBe(0);

    const missing = new Env();
    const b = uploadingRow(missing);
    const r2 = await missing.tickOnce();
    expect(missing.audio.get(b.id)).toMatchObject({ state: 'discovered', failKinds: ['recovery_reset'] });
    expect(r2.requests).toBe(0);
  });

  it('a matching object that decodes is registered `stored` with the decoded duration, and an object that fails decode is removed', async () => {
    const ok = new Env();
    const a = uploadingRow(ok);
    ok.objects.set(a.path!, BYTES);
    const result = await ok.tickOnce();
    expect(ok.audio.get(a.id)!.state).toBe('stored');
    expect(result).toMatchObject({ recovered: 1, requests: 0 });

    const bad = new Env();
    const b = uploadingRow(bad);
    bad.objects.set(b.path!, BYTES);
    bad.decodeResult = { ok: false, reason: 'invalid' };
    await bad.tickOnce();
    expect(bad.objects.has(b.path!)).toBe(false);
    expect(bad.audio.get(b.id)!.state).toBe('discovered');
  });

  it('recovery with the widest branch (read 10 + remove 10 + DB) is admitted at 21.5 s and not at 21.4 s', async () => {
    for (const [remaining, ran] of [[ADMISSION.recover, true], [ADMISSION.recover - 100, false]] as const) {
      const env = new Env();
      const burner = env.addAudio({ state: 'stored', providerCallId: '1' });
      env.attempts.set('burn', { id: 'burn', audioId: burner.id, orgId: ORG, state: 'live', shareLinkId: '1', itemId: REC, createdById: '77', callId: CALL, holder: 'old' });
      const a = uploadingRow(env);
      env.objects.set(a.path!, new Uint8Array([9]));
      env.server = () => { env.clock.t += 55_000 - remaining; return new Response('', { status: 404 }); };
      await env.tickOnce();
      expect(env.objects.has(a.path!)).toBe(!ran);
    }
  });
});

describe('discovery (step d)', () => {
  const due = (env: Env) => env.discoveryDue.push({ id: 'd1', orgId: ORG, providerCallId: CALL, endedAt: '2026-10-06T12:00:00Z', attempts: 0, keyRef: KEY_REF });

  it.each([
    ['one admin recording', 200, { recording_details: [{ id: 5185307806048256, recording_type: 'admincallrecording', duration: 36000 }] }, 'one'],
    ['none yet', 200, { recording_details: [] }, 'not_ready'],
    ['a second segment', 200, { recording_details: [{ id: 1, recording_type: 'admincallrecording', duration: 1 }, { id: 2, recording_type: 'admincallrecording', duration: 1 }] }, 'multi'],
    ['404', 404, {}, 'not_ready'],
    ['403', 403, {}, 'denied'],
    ['500', 500, {}, 'error'],
  ])('%s', async (_name, status, body, outcome) => {
    const env = new Env();
    due(env);
    env.server = () => new Response(JSON.stringify(body), { status });
    await env.tickOnce();
    expect(env.discoveryResults).toHaveLength(1);
    expect(env.discoveryResults[0]).toMatchObject({ audioId: 'd1', outcome });
    if (outcome === 'one') expect(env.discoveryResults[0]!.extra).toEqual({ recordingId: '5185307806048256', durationMs: 36000 });
    if (outcome === 'denied') expect(env.discoveryResults[0]!.extra).toMatchObject({ keyFp: keyFingerprint(KEY) });
    expect(env.requests[0]).toMatchObject({ method: 'GET', path: `/api/v2/call/${CALL}`, auth: `Bearer ${KEY}` });
  });

  it('a call GET that hangs is recorded as an error and stops the tick', async () => {
    const env = new Env();
    due(env);
    env.httpHangs = true;
    const result = await env.tickOnce();
    expect(env.discoveryResults[0]).toMatchObject({ outcome: 'error' });
    expect(result).toMatchObject({ status: 'stopped', reason: 'timeout' });
  });

  it('a row whose org has no key is a counted error with no request', async () => {
    const env = new Env();
    due(env);
    env.discoveryDue[0]!.keyRef = 'env:DIALPAD_CTI_DIRECTORY_KEY_MISSING';
    await env.tickOnce();
    expect(env.requests).toHaveLength(0);
    expect(env.discoveryResults[0]).toMatchObject({ outcome: 'error', extra: { error: 'no_key' } });
  });
});

describe('credential repair', () => {
  it('requeues denied rows with the fingerprint of the key VALUE, with no Dialpad request', async () => {
    const env = new Env();
    env.denied.push({ orgId: ORG, keyRef: KEY_REF });
    const result = await env.tickOnce();
    expect(env.requeues).toEqual([{ orgId: ORG, fp: createHash('sha256').update(KEY).digest('hex').slice(0, 16) }]);
    expect(result.requests).toBe(0);
    const other = new Env();
    other.denied.push({ orgId: ORG, keyRef: KEY_REF });
    await other.tickOnce({ env: { DIALPAD_CTI_DIRECTORY_KEY_TEST: `${KEY}-rotated` } });
    expect(other.requeues[0]!.fp).not.toBe(env.requeues[0]!.fp);
  });
});

describe('bucket constant', () => {
  it('uses the private bucket the migration creates', () => {
    expect(AUDIO_BUCKET).toBe('dialpad-call-audio');
  });
});
