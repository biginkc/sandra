import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sweep = vi.fn();
const handle = vi.fn();

vi.mock('@/lib/errors/report', () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock('./event-processing', () => ({
  createSupabaseDialpadCtiDb: vi.fn(() => ({ marker: 'db' })),
  sweepDialpadCallEvents: (...args: unknown[]) => sweep(...args),
  handleDialpadVoiceWebhook: (...args: unknown[]) => handle(...args),
}));

import { GET as cronGet } from '@/app/api/cron/dialpad-call-events-sweep/route';
import { POST as voicePost } from '@/app/api/webhooks/dialpad/voice/[connectionId]/route';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

describe('dialpad cti routes', () => {
  const original = process.env.CRON_SECRET;
  beforeEach(() => {
    sweep.mockReset();
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
    expect(await ok.json()).toEqual({ ok: true, candidates: 2, processed: 2, failed: 0 });
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
});
