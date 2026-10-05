import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/errors/report', () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));

import {
  DialpadDbError,
  failStaleDialpadIntents,
  handleDialpadVoiceWebhook,
  processDialpadCallEvent,
  redactDialpadUnmatchedEvents,
  sweepDialpadCallEvents,
  type DialpadConnectionRecord,
  type DialpadCtiDb,
} from './event-processing';
import { DIALPAD_WEBHOOK_MAX_BYTES, verifyDialpadWebhookJwt } from './webhook-jwt';
import { resolveDialpadWebhookSecrets } from './webhook-secret';

const SECRET = 'test-secret-value-000000000001';
const OTHER_SECRET = 'test-secret-value-000000000002';
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const REF = 'env:DIALPAD_CTI_WEBHOOK_SECRET_TEST';

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function sign(payloadText: string, secret = SECRET, header: object = { alg: 'HS256', typ: 'JWT' }): string {
  const input = `${b64(JSON.stringify(header))}.${b64(payloadText)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

const PAYLOAD = '{"call_id":9007199254740993123,"state":"calling","event_timestamp":1790000000000}';

describe('verifyDialpadWebhookJwt', () => {
  it('accepts a valid HS256 token and returns the payload text byte-for-byte (64-bit ids intact)', () => {
    const result = verifyDialpadWebhookJwt(sign(PAYLOAD), [SECRET]);
    expect(result).toEqual({ ok: true, payloadText: PAYLOAD, secretIndex: 0 });
    expect(JSON.parse(PAYLOAD).call_id.toString()).not.toBe('9007199254740993123');
    expect((result as { payloadText: string }).payloadText).toContain('9007199254740993123');
  });

  it('rejects unsigned JSON bodies', () => {
    expect(verifyDialpadWebhookJwt(PAYLOAD, [SECRET])).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects alg none, other algorithms and crit headers', () => {
    const input = (header: object) => `${b64(JSON.stringify(header))}.${b64(PAYLOAD)}`;
    expect(verifyDialpadWebhookJwt(`${input({ alg: 'none' })}.`, [SECRET]).ok).toBe(false);
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, SECRET, { alg: 'none' }), [SECRET])).toEqual({ ok: false, reason: 'unsupported_alg' });
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, SECRET, { alg: 'HS384' }), [SECRET])).toEqual({ ok: false, reason: 'unsupported_alg' });
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, SECRET, { alg: 'hs256' }), [SECRET])).toEqual({ ok: false, reason: 'unsupported_alg' });
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, SECRET, { alg: 'HS256', crit: ['x'] }), [SECRET])).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('rejects a wrong secret, a tampered payload and a truncated or non-canonical signature', () => {
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, OTHER_SECRET), [SECRET])).toEqual({ ok: false, reason: 'bad_signature' });
    const [h, , s] = sign(PAYLOAD).split('.') as [string, string, string];
    const tampered = `${h}.${b64(PAYLOAD.replace('calling', 'hangup'))}.${s}`;
    expect(verifyDialpadWebhookJwt(tampered, [SECRET])).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyDialpadWebhookJwt(`${h}.${b64(PAYLOAD)}.${s.slice(0, 20)}`, [SECRET]).ok).toBe(false);
    const good = sign(PAYLOAD);
    expect(verifyDialpadWebhookJwt(`${good}=`, [SECRET]).ok).toBe(false);
  });

  it('never accepts with no or empty secrets', () => {
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, ''), [])).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, ''), [''])).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects malformed segment counts, non-object payloads and invalid UTF-8', () => {
    expect(verifyDialpadWebhookJwt('a.b', [SECRET]).ok).toBe(false);
    expect(verifyDialpadWebhookJwt('a.b.c.d', [SECRET]).ok).toBe(false);
    expect(verifyDialpadWebhookJwt(sign('[1,2]'), [SECRET])).toEqual({ ok: false, reason: 'bad_payload' });
    expect(verifyDialpadWebhookJwt(sign('"str"'), [SECRET])).toEqual({ ok: false, reason: 'bad_payload' });
    const input = `${b64('{"alg":"HS256"}')}.${b64(Buffer.from([0xff, 0xfe]))}`;
    const badUtf8 = `${input}.${createHmac('sha256', SECRET).update(input).digest('base64url')}`;
    expect(verifyDialpadWebhookJwt(badUtf8, [SECRET])).toEqual({ ok: false, reason: 'bad_payload' });
  });

  it('caps the body size', () => {
    expect(verifyDialpadWebhookJwt('x'.repeat(DIALPAD_WEBHOOK_MAX_BYTES + 1), [SECRET])).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reports which secret verified so rotation records the right version', () => {
    expect(verifyDialpadWebhookJwt(sign(PAYLOAD, OTHER_SECRET), [SECRET, OTHER_SECRET])).toMatchObject({ ok: true, secretIndex: 1 });
  });
});

describe('resolveDialpadWebhookSecrets', () => {
  const env = { DIALPAD_CTI_WEBHOOK_SECRET_TEST: SECRET, DIALPAD_CTI_WEBHOOK_SECRET_TEST_PREVIOUS: OTHER_SECRET, SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40) };

  it('resolves the current secret at its version and the previous one at version-1', () => {
    expect(resolveDialpadWebhookSecrets(REF, 3, env)).toEqual([
      { secret: SECRET, version: 3 },
      { secret: OTHER_SECRET, version: 2 },
    ]);
    expect(resolveDialpadWebhookSecrets(REF, 1, env)).toEqual([{ secret: SECRET, version: 1 }]);
  });

  it('only reads variables inside the CTI webhook secret namespace', () => {
    expect(resolveDialpadWebhookSecrets('env:SUPABASE_SERVICE_ROLE_KEY', 1, env)).toEqual([]);
    expect(resolveDialpadWebhookSecrets('env:DIALPAD_CTI_WEBHOOK_SECRET_test', 1, env)).toEqual([]);
    expect(resolveDialpadWebhookSecrets('DIALPAD_CTI_WEBHOOK_SECRET_TEST', 1, env)).toEqual([]);
    expect(resolveDialpadWebhookSecrets('op://vault/item/field', 1, env)).toEqual([]);
  });

  it('refuses missing or short secrets and invalid versions', () => {
    expect(resolveDialpadWebhookSecrets(REF, 1, {})).toEqual([]);
    expect(resolveDialpadWebhookSecrets(REF, 1, { DIALPAD_CTI_WEBHOOK_SECRET_TEST: 'short' })).toEqual([]);
    expect(resolveDialpadWebhookSecrets(REF, 0, env)).toEqual([]);
  });
});

const connection: DialpadConnectionRecord = {
  id: CONNECTION_ID,
  orgId: ORG_ID,
  status: 'active',
  webhookSecretRef: REF,
  webhookSecretVersion: 2,
};
const env = { DIALPAD_CTI_WEBHOOK_SECRET_TEST: SECRET, DIALPAD_CTI_WEBHOOK_SECRET_TEST_PREVIOUS: OTHER_SECRET };
const ingestOk = { eventId: EVENT_ID, disposition: 'received', replayed: false, conflict: false };
const processOk = { eventId: EVENT_ID, disposition: 'matched', intentId: null, reason: null, projected: true, callActivityId: null, attemptId: null, replayed: false };

function makeDb(overrides: Partial<DialpadCtiDb> = {}, calls: string[] = []): DialpadCtiDb {
  return {
    loadConnection: vi.fn(async () => { calls.push('load'); return connection; }),
    ingest: vi.fn(async () => { calls.push('ingest'); return ingestOk; }),
    process: vi.fn(async () => { calls.push('process'); return processOk; }),
    recordProcessFailure: vi.fn(async () => { calls.push('recordFailure'); }),
    listPending: vi.fn(async () => []),
    failStaleIntents: vi.fn(async () => 0),
    redactUnmatched: vi.fn(async () => 0),
    ...overrides,
  };
}

const dbError = (code: string, details: string | null = null) =>
  new DialpadDbError(code === '22023' ? { kind: 'invalid_input', detail: details } : code === '42501' ? { kind: 'forbidden', detail: null } : { kind: 'unknown' }, code);

describe('handleDialpadVoiceWebhook', () => {
  it('persists the verified payload text under the connection org and secret version before processing and acknowledging', async () => {
    const calls: string[] = [];
    const db = makeDb({}, calls);
    const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db, env });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['load', 'ingest', 'process']);
    expect(db.ingest).toHaveBeenCalledWith(ORG_ID, CONNECTION_ID, 2, PAYLOAD);
  });

  it('records the previous secret version when a rotated-out secret signed the event', async () => {
    const db = makeDb();
    await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD, OTHER_SECRET), db, env });
    expect(db.ingest).toHaveBeenCalledWith(ORG_ID, CONNECTION_ID, 1, PAYLOAD);
  });

  it('401s an invalid signature, unsigned JSON and alg none without touching the database beyond the lookup', async () => {
    for (const rawBody of [sign(PAYLOAD, OTHER_SECRET + 'x'), PAYLOAD, sign(PAYLOAD, SECRET, { alg: 'none' })]) {
      const db = makeDb();
      const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody, db, env });
      expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(db.ingest).not.toHaveBeenCalled();
      expect(db.process).not.toHaveBeenCalled();
    }
  });

  it('rejects another org\'s secret against this connection and answers unknown, inactive and malformed ids identically', async () => {
    const db = makeDb();
    const cross = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD, 'org-b-secret-value-0000000000'), db, env });
    expect(cross.status).toBe(401);
    expect(db.ingest).not.toHaveBeenCalled();

    const unknown = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db: makeDb({ loadConnection: async () => null }), env });
    const inactive = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db: makeDb({ loadConnection: async () => ({ ...connection, status: 'disabled' }) }), env });
    const malformed = await handleDialpadVoiceWebhook({ connectionId: 'not-a-uuid', rawBody: sign(PAYLOAD), db, env });
    expect(unknown).toEqual(cross);
    expect(inactive).toEqual(cross);
    expect(malformed).toEqual(cross);
  });

  it('503s when the connection secret is not configured, and never accepts a body then', async () => {
    const db = makeDb();
    const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD, ''), db, env: {} });
    expect(res.status).toBe(503);
    expect(db.ingest).not.toHaveBeenCalled();
  });

  it('does not acknowledge success when persistence fails, and does not process', async () => {
    const db = makeDb({ ingest: async () => { throw dbError('57014'); } });
    const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db, env });
    expect(res.status).toBe(503);
    expect(db.process).not.toHaveBeenCalled();
  });

  it('does not acknowledge success when the ingest response is malformed', async () => {
    const db = makeDb({ ingest: async () => ({ nope: true }) });
    const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db, env });
    expect(res.status).toBe(503);
  });

  it('maps a database-side inactive connection to 401 and a signed non-call event to a non-retried 200', async () => {
    const forbidden = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db: makeDb({ ingest: async () => { throw dbError('42501'); } }), env });
    expect(forbidden.status).toBe(401);
    const ignored = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db: makeDb({ ingest: async () => { throw dbError('22023', 'missing_event_identity'); } }), env });
    expect(ignored).toEqual({ status: 200, body: { ok: true, ignored: true } });
    const invalid = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db: makeDb({ ingest: async () => { throw dbError('22023', 'secret_version'); } }), env });
    expect(invalid.status).toBe(422);
  });

  it('still acknowledges 200 after persistence when projection fails, recording the failure for the sweep', async () => {
    const calls: string[] = [];
    const db = makeDb({ process: async () => { calls.push('process'); throw dbError('40P01'); } }, calls);
    const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db, env });
    expect(res).toEqual({ status: 200, body: { ok: true, eventId: EVENT_ID, disposition: 'received', pendingProjection: true } });
    expect(calls).toEqual(['load', 'ingest', 'process', 'recordFailure']);
    expect(db.recordProcessFailure).toHaveBeenCalledWith(EVENT_ID, '40P01');
  });

  it('acknowledges a conflicting duplicate without reprocessing it', async () => {
    const db = makeDb({ ingest: async () => ({ ...ingestOk, disposition: 'conflict', conflict: true }) });
    const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: sign(PAYLOAD), db, env });
    expect(res.status).toBe(200);
    expect(db.process).not.toHaveBeenCalled();
  });

  it('rejects oversize bodies before any lookup', async () => {
    const db = makeDb();
    const res = await handleDialpadVoiceWebhook({ connectionId: CONNECTION_ID, rawBody: 'x'.repeat(DIALPAD_WEBHOOK_MAX_BYTES + 1), db, env });
    expect(res.status).toBe(413);
    expect(db.loadConnection).not.toHaveBeenCalled();
  });
});

describe('processDialpadCallEvent and sweepDialpadCallEvents', () => {
  it('records only the SQLSTATE on failure and rethrows', async () => {
    const db = makeDb({ process: async () => { throw dbError('40001'); } });
    await expect(processDialpadCallEvent(db, EVENT_ID)).rejects.toBeInstanceOf(DialpadDbError);
    expect(db.recordProcessFailure).toHaveBeenCalledWith(EVENT_ID, '40001');
  });

  it('sweeps pending events, isolating one failure from the rest', async () => {
    const ids = [EVENT_ID, '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
    const process = vi.fn(async (id: string) => {
      if (id === ids[1]) throw dbError('40P01');
      return { ...processOk, eventId: id };
    });
    const db = makeDb({ listPending: async () => ids, process });
    expect(await sweepDialpadCallEvents(db, 10)).toEqual({ candidates: 3, processed: 2, failed: 1 });
    expect(process).toHaveBeenCalledTimes(3);
    expect(db.recordProcessFailure).toHaveBeenCalledWith(ids[1], '40P01');
  });
});

describe('failStaleDialpadIntents', () => {
  it('asks the database for a 120 second cutoff by default and returns how many it marked', async () => {
    const failStaleIntents = vi.fn(async () => 2);
    const db = makeDb({ failStaleIntents });
    expect(await failStaleDialpadIntents(db)).toBe(2);
    expect(failStaleIntents).toHaveBeenCalledWith(120);
    await failStaleDialpadIntents(db, 300);
    expect(failStaleIntents).toHaveBeenLastCalledWith(300);
  });
});

describe('redactDialpadUnmatchedEvents', () => {
  it('defaults to 30 days and 500 rows and returns the count', async () => {
    const redactUnmatched = vi.fn(async () => 4);
    const db = makeDb({ redactUnmatched });
    expect(await redactDialpadUnmatchedEvents(db)).toBe(4);
    expect(redactUnmatched).toHaveBeenCalledWith(30, 500);
  });

  it('passes the given days and limit to the port', async () => {
    const redactUnmatched = vi.fn(async () => 1);
    const db = makeDb({ redactUnmatched });
    expect(await redactDialpadUnmatchedEvents(db, 7, 25)).toBe(1);
    expect(redactUnmatched).toHaveBeenCalledWith(7, 25);
  });

  it('rejects under one day so fresh rows can never be redacted', async () => {
    const redactUnmatched = vi.fn(async () => 0);
    const db = makeDb({ redactUnmatched });
    await expect(redactDialpadUnmatchedEvents(db, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(redactDialpadUnmatchedEvents(db, 0.5)).rejects.toBeInstanceOf(RangeError);
    await expect(redactDialpadUnmatchedEvents(db, -3)).rejects.toBeInstanceOf(RangeError);
    expect(redactUnmatched).not.toHaveBeenCalled();
  });
});
