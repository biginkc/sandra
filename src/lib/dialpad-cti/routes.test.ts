import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sweep = vi.fn();
const failStale = vi.fn();
const redact = vi.fn();
const reportErrorMock = vi.fn();
const artifactSweep = vi.fn();
const ready = vi.fn();
const handle = vi.fn();

vi.mock('@/lib/errors/report', () => ({ reportError: (...args: unknown[]) => reportErrorMock(...args), reportInfo: vi.fn() }));
vi.mock('@/lib/dialpad-cti/artifact-fetch', () => ({
  createSupabaseDialpadArtifactDb: vi.fn(() => ({ marker: 'artifact-db' })),
  sweepDialpadArtifacts: (...args: unknown[]) => artifactSweep(...args),
}));
vi.mock('@/lib/my-leads/schema-ready', () => ({ schemaReady: (...args: unknown[]) => ready(...args) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock('./event-processing', () => ({
  createSupabaseDialpadCtiDb: vi.fn(() => ({ marker: 'db' })),
  sweepDialpadCallEvents: (...args: unknown[]) => sweep(...args),
  failStaleDialpadIntents: (...args: unknown[]) => failStale(...args),
  redactDialpadUnmatchedEvents: (...args: unknown[]) => redact(...args),
  handleDialpadVoiceWebhook: (...args: unknown[]) => handle(...args),
}));

import { GET as artifactGet } from '@/app/api/cron/dialpad-artifact-sweep/route';
import { GET as cronGet } from '@/app/api/cron/dialpad-call-events-sweep/route';
import { POST as voicePost } from '@/app/api/webhooks/dialpad/voice/[connectionId]/route';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

describe('dialpad cti routes', () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    sweep.mockReset();
    failStale.mockReset();
    failStale.mockResolvedValue(0);
    redact.mockReset();
    reportErrorMock.mockReset();
    redact.mockResolvedValue(0);
    artifactSweep.mockReset();
    ready.mockReset();
    ready.mockResolvedValue(true);
    handle.mockReset();
    process.env.CRON_SECRET = 'cron-secret-for-tests';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('cron sweep requires the bearer secret', async () => {
    const denied = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep'));
    expect(denied.status).toBe(401);
    const wrong = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers: { authorization: 'Bearer nope' } }));
    expect(wrong.status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('cron sweep runs with the right bearer and reports the summary', async () => {
    sweep.mockResolvedValue({ candidates: 2, processed: 2, failed: 0 });
    const ok = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers: { authorization: 'Bearer cron-secret-for-tests' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, candidates: 2, processed: 2, failed: 0, failedIntents: 0, redacted: 0 });
  });

  it('cron sweep reports failed intents and still sweeps when the timeout call throws', async () => {
    sweep.mockResolvedValue({ candidates: 0, processed: 0, failed: 0 });
    failStale.mockResolvedValueOnce(3);
    const headers = { authorization: 'Bearer cron-secret-for-tests' };
    const some = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers }));
    expect(await some.json()).toMatchObject({ ok: true, failedIntents: 3 });
    failStale.mockRejectedValueOnce(new Error('rpc down'));
    const thrown = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers }));
    expect(thrown.status).toBe(200);
    expect(await thrown.json()).toMatchObject({ ok: true, failedIntents: null });
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('cron sweep leaves the intent timeout alone until its schema is ready', async () => {
    sweep.mockResolvedValue({ candidates: 0, processed: 0, failed: 0 });
    ready.mockResolvedValue(false);
    const res = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers: { authorization: 'Bearer cron-secret-for-tests' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, failedIntents: null });
    expect(failStale).not.toHaveBeenCalled();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('cron sweep redacts only when event_redaction is ready, after the sweep', async () => {
    const order: string[] = [];
    sweep.mockImplementation(async () => { order.push('sweep'); return { candidates: 0, processed: 0, failed: 0 }; });
    redact.mockImplementation(async () => { order.push('redact'); return 5; });
    ready.mockImplementation(async (feature: string) => feature !== 'event_redaction');
    const headers = { authorization: 'Bearer cron-secret-for-tests' };
    const off = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers }));
    expect(await off.json()).toMatchObject({ ok: true, redacted: null });
    expect(redact).not.toHaveBeenCalled();
    ready.mockResolvedValue(true);
    const on = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers }));
    expect(await on.json()).toMatchObject({ ok: true, redacted: 5 });
    expect(ready).toHaveBeenCalledWith('event_redaction');
    expect(order).toEqual(['sweep', 'sweep', 'redact']);
  });

  it('cron sweep reports a redaction failure and still returns 200 with redacted null', async () => {
    sweep.mockResolvedValue({ candidates: 1, processed: 1, failed: 0 });
    redact.mockRejectedValueOnce(new Error('rpc down'));
    const res = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers: { authorization: 'Bearer cron-secret-for-tests' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processed: 1, redacted: null });
    expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), { tags: { surface: 'cron_dialpad_event_redaction' } });
  });

  it('cron sweep hides internals on failure', async () => {
    sweep.mockRejectedValue(new Error('secret detail'));
    const failed = await cronGet(new Request('http://x/api/cron/dialpad-call-events-sweep', { headers: { authorization: 'Bearer cron-secret-for-tests' } }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'sweep_failed' });
  });

  it('voice webhook passes the raw body and the path connection id to the handler and relays its status', async () => {
    handle.mockResolvedValue({ status: 401, body: { error: 'unauthorized' } });
    const response = await voicePost(
      new Request(`http://x/api/webhooks/dialpad/voice/${CONNECTION_ID}`, { method: 'POST', body: 'a.b.c' }),
      { params: Promise.resolve({ connectionId: CONNECTION_ID }) },
    );
    expect(response.status).toBe(401);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ connectionId: CONNECTION_ID, rawBody: 'a.b.c' }));
  });

  describe('artifact sweep route', () => {
    const url = 'http://x/api/cron/dialpad-artifact-sweep';
    const auth = { headers: { authorization: 'Bearer cron-secret-for-tests' } };

    it('requires the bearer secret and does nothing without it', async () => {
      expect((await artifactGet(new Request(url))).status).toBe(401);
      expect((await artifactGet(new Request(url, { headers: { authorization: 'Bearer nope' } }))).status).toBe(401);
      expect(artifactSweep).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
    });

    it('runs the sweep with the right bearer and reports its summary', async () => {
      artifactSweep.mockResolvedValue({ claimed: 1, available: 1, notReady: 0, denied: 0, errors: 0, linksAvailable: 0, linksFlagged: 0 });
      const ok = await artifactGet(new Request(url, auth));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, claimed: 1, available: 1 });
    });

    it('does not claim anything while the schema is not ready', async () => {
      ready.mockResolvedValue(false);
      const res = await artifactGet(new Request(url, auth));
      expect(await res.json()).toEqual({ ok: true, disabled: 'schema_not_ready' });
      expect(artifactSweep).not.toHaveBeenCalled();
    });

    it('hides internals on failure', async () => {
      artifactSweep.mockRejectedValue(new Error('secret detail'));
      const failed = await artifactGet(new Request(url, auth));
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: 'sweep_failed' });
    });
  });
});
