import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock('../../_lib/auth', () => ({ authenticateJitterWriteback: mocks.auth }));
import { POST } from './route';
const body = {
  eventId:'10000000-0000-4000-8000-000000000001',eventVersion:1,
  orgId:'10000000-0000-4000-8000-000000000002',propertyId:'10000000-0000-4000-8000-000000000003',
  actorUserId:'10000000-0000-4000-8000-000000000004',assignmentEpisodeId:null,
  sandraCallToken:'10000000-0000-4000-8000-000000000005',jitterCallId:'jitter-call',sellerProviderCallId:'seller-call',
  occurredAt:'2026-09-11T15:00:00Z',evidence:'seller_call_create_succeeded',
};
const request = () => new Request('http://localhost/api/internal/jitter/my-leads/call-started', { method: 'POST' });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ ok:true, orgId:body.orgId, rawBody:JSON.stringify(body), serviceClient:{rpc:mocks.rpc} });
  mocks.rpc.mockResolvedValue({data:{ok:true,attemptId:'attempt',duplicate:false},error:null});
});
describe('internal seller-start receiver', () => {
  it('authenticates before accepting or writing facts', async () => {
    mocks.auth.mockResolvedValue({ok:false,response:new Response(null,{status:401})});
    expect((await POST(request())).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('sends only token digest to the service-only transaction', async () => {
    expect((await POST(request())).status).toBe(200);
    const input=mocks.rpc.mock.calls[0][1].p_event;
    expect(input.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(input).not.toHaveProperty('sandraCallToken');
    expect(input.sellerProviderCallId).toBe('seller-call');
  });
  it('rejects cross-tenant and operator events', async () => {
    for(const changed of [{orgId:body.actorUserId},{evidence:'operator_connected'}]) {
      mocks.auth.mockResolvedValue({ok:true,orgId:body.orgId,rawBody:JSON.stringify({...body,...changed}),serviceClient:{rpc:mocks.rpc}});
      expect((await POST(request())).status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('returns retryable failure instead of successful persistence on database failure', async () => {
    mocks.rpc.mockResolvedValue({data:null,error:{code:'08006',message:'internal detail'}});
    const response=await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:'evidence_pending'});
  });
  it('returns the database replay result unchanged', async () => {
    mocks.rpc.mockResolvedValue({data:{ok:true,duplicate:true,attemptId:'original'},error:null});
    expect(await (await POST(request())).json()).toEqual({ok:true,duplicate:true,attemptId:'original'});
  });
});
