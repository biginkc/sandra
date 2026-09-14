import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ users: vi.fn(), grants: vi.fn(), roster: vi.fn(), viewer: vi.fn(), replay: vi.fn(), admin: vi.fn(), from: vi.fn(), rpc: vi.fn(), member: vi.fn(), verify: vi.fn(), client: vi.fn(), eq: vi.fn(), is: vi.fn(), single: vi.fn() }));
vi.mock('@/lib/my-leads/queries', () => ({ getAcquisitionRoster: m.roster, myLeadsViewer: m.viewer }));
vi.mock('./database', () => ({ createDialpadVoiceAdminClient: m.admin }));
vi.mock('./client', () => ({ DialpadVoiceClient: class { constructor(key: string) { m.client(key); } listUsersByEmail(email: string, cursor?: string) { return m.users(email,cursor); } } }));
vi.mock('./verified-inventory', () => ({ verifyDialpadInventory: m.verify }));
import { loadDialpadMemberCallerOptions, saveDialpadMemberCallerAssignment } from './configuration';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const org = id(1), owner = id(2), member = id(3), connectionId = id(4);
const office = { identity_type: 'office', provider_identity_id: '301', number_e164: '+12025550101' };
const input = () => ({ memberId: member, providerUserId: '201', connectionVersion: 2, expectedBindingRevision: 1, requestId: id(5), selectedCallers: [{ ...office }] });
const roster = () => ({ viewer: { isOwner: true, orgId: org, userId: owner }, roster: { isOwner: true, settings: { enabled: true }, members: [{ id: member, active: true, acquisitionsEnabled: true }] } });
const connection = () => ({ id: connectionId, org_id: org, provider_company_id: '101', enabled: true, config_version: 2, verified_at: '2026-09-13T12:00:00Z', credential_reference: 'env:DIALPAD_TEST_API_KEY' });
beforeEach(() => {
 vi.resetAllMocks(); vi.unstubAllEnvs(); vi.stubEnv('DIALPAD_TEST_API_KEY', 'test-key');
 const query = { select: vi.fn().mockReturnThis(), eq: m.eq, is: m.is, maybeSingle: m.single };
 m.eq.mockReturnValue(query); m.is.mockReturnValue(query); m.from.mockImplementation((table: string) => table === 'dialpad_number_grants' ? { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: m.grants } : query);
 m.grants.mockResolvedValue({data:[office],error:null}); m.users.mockResolvedValue({items:[{id:'201',company_id:'101',state:'active',emails:['REP@example.test']}],cursor:null});
 m.single.mockResolvedValueOnce({ data: connection(), error: null }).mockResolvedValue({ data: { id: id(6), provider_user_id: '201', revision: 1 }, error: null });
 m.viewer.mockResolvedValue(roster().viewer); m.replay.mockResolvedValue({data:null,error:null});
 m.roster.mockResolvedValue(roster()); m.admin.mockReturnValue({ from: m.from, rpc: (name: string, args: unknown) => name === 'fn_replay_dialpad_member_configuration' ? m.replay(name,args) : m.rpc(name,args), auth: { admin: { getUserById: m.member } } });
 m.member.mockResolvedValue({ data: { user: { id: member, email: 'rep@example.test' } }, error: null });
 m.verify.mockResolvedValue({ inventory: { orgId: org, providerUserId: '201', callers: [{ number: office.number_e164, identity: { type: 'office', id: '301' }, active: true }] }, provenance: { providerCompanyId: '101', providerUserId: '201', verifiedAt: '2026-09-13T12:00:01Z' } });
 m.rpc.mockResolvedValue({ data: { bindingId: id(6), bindingRevision: 2 }, error: null });
});
describe('owner Dialpad configuration actions', () => {
 it('discovers member provider ID using complete email-filtered pages', async () => {
  m.users.mockResolvedValueOnce({items:[],cursor:'next'}).mockResolvedValueOnce({items:[{id:'201',company_id:'101',state:'active',emails:['REP@example.test']}],cursor:''});
  const result = await loadDialpadMemberCallerOptions({memberId:member});
  expect(result).toMatchObject({ok:true,providerUserId:'201',selectedCallers:[office]});
  expect(m.users.mock.calls).toEqual([['rep@example.test',undefined],['rep@example.test','next']]);
 });
 it.each(['ambiguous','wrong_company','wrong_email','inactive','malformed','cycle','limit'])('rejects unsafe discovery %s', async kind => {
  const user={id:'201',company_id:'101',state:'active',emails:['rep@example.test']};
  if(kind==='ambiguous') m.users.mockResolvedValue({items:[user,{...user,id:'202'}]});
  if(kind==='wrong_company') m.users.mockResolvedValue({items:[{...user,company_id:'999'}]});
  if(kind==='wrong_email') m.users.mockResolvedValue({items:[{...user,emails:['rep@example.test.evil']}]});
  if(kind==='inactive') m.users.mockResolvedValue({items:[{...user,state:'suspended'}]});
  if(kind==='malformed') m.users.mockResolvedValue({items:[{...user,id:201}]});
  if(kind==='cycle') m.users.mockResolvedValue({items:[user],cursor:'same'});
  if(kind==='limit') m.users.mockImplementation(async()=>({items:[user],cursor:String(m.users.mock.calls.length)}));
  expect(await loadDialpadMemberCallerOptions({memberId:member})).toEqual({ok:false,error:'configuration_unavailable'});
  expect(m.verify).not.toHaveBeenCalled(); expect(m.users.mock.calls.length).toBeLessThanOrEqual(20);
 });
 it('preselects only exact still-authorized active grant identities', async () => {
  m.grants.mockResolvedValue({data:[{...office,provider_identity_id:'302'}],error:null});
  expect(await loadDialpadMemberCallerOptions({memberId:member})).toMatchObject({ok:true,selectedCallers:[]});
 });
 it('loads fresh persona options using server member email and org company', async () => {
  expect(await loadDialpadMemberCallerOptions(input())).toEqual({ ok: true, connectionVersion: 2, providerUserId: '201', bindingRevision: 1, callers: [office], selectedCallers: [office] });
  expect(m.verify).toHaveBeenCalledWith(expect.anything(), { orgId: org, providerCompanyId: '101', providerUserId: '201', memberEmail: 'rep@example.test' });
  expect(m.eq).toHaveBeenCalledWith('org_id', org); expect(m.member).toHaveBeenCalledWith(member);
  expect(m.client).toHaveBeenCalledWith('test-key'); expect(m.rpc).not.toHaveBeenCalled();
 });
 it.each(['viewer', 'roster', 'settings', 'active', 'acquisitions', 'member'])('rejects unauthorized %s before admin/provider work', async gate => {
  const r = roster();
  if (gate === 'viewer') { r.viewer.isOwner = false; m.viewer.mockResolvedValue(r.viewer); }
  if (gate === 'roster') r.roster.isOwner = false;
  if (gate === 'settings') r.roster.settings.enabled = false;
  if (gate === 'active') r.roster.members[0].active = false;
  if (gate === 'acquisitions') r.roster.members[0].acquisitionsEnabled = false;
  if (gate === 'member') r.roster.members = [];
  m.roster.mockResolvedValue(r);
  expect((await saveDialpadMemberCallerAssignment(input())).ok).toBe(false);
  expect(m.verify).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
 });
 it.each([{ org_id: id(99) }, { enabled: false }, { verified_at: null }, { config_version: 0 }, { credential_reference: 'env:SUPABASE_SERVICE_ROLE_KEY' }, { credential_reference: 'env:DIALPAD_MISSING' }, { credential_reference: 'raw-secret' }])('rejects unsafe connection %j', async patch => {
  m.single.mockReset().mockResolvedValue({ data: { ...connection(), ...patch }, error: null });
  expect((await loadDialpadMemberCallerOptions(input())).ok).toBe(false);
  expect(m.member).not.toHaveBeenCalled(); expect(m.client).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
 });
 it('rejects mismatched server member record before provider work', async () => {
  m.member.mockResolvedValue({ data: { user: { id: id(99), email: 'other@example.test' } }, error: null });
  expect((await saveDialpadMemberCallerAssignment(input())).ok).toBe(false); expect(m.verify).not.toHaveBeenCalled();
 });
 it('rejects same phone under an unverified group', async () => {
  expect(await saveDialpadMemberCallerAssignment({ ...input(), selectedCallers: [{ ...office, provider_identity_id: '302' }] })).toEqual({ ok: false, error: 'invalid_selection' });
  expect(m.rpc).not.toHaveBeenCalled();
 });
 it('rejects extra selection fields', async () => {
  const selected = { ...office, untrusted: true };
  expect(await saveDialpadMemberCallerAssignment({ ...input(), selectedCallers: [selected] })).toEqual({ ok: false, error: 'invalid_selection' }); expect(m.rpc).not.toHaveBeenCalled();
 });
 it('sanitizes provider failure before persistence', async () => {
  m.verify.mockRejectedValue(new Error('sensitive provider payload'));
  expect(await saveDialpadMemberCallerAssignment(input())).toEqual({ ok: false, error: 'configuration_save_unconfirmed' }); expect(m.rpc).not.toHaveBeenCalled();
 });
 it('persists server scope and fetched inventory despite injected browser identity fields, deduplicating selections', async () => {
  const hostile = { ...input(), orgId: id(99), ownerId: id(99), providerCompanyId: '999', verifiedAt: '2000', callers: [], selectedCallers: [{ ...office }, { ...office }] };
  expect(await saveDialpadMemberCallerAssignment(hostile)).toEqual({ ok: true, bindingId: id(6), bindingRevision: 2 });
  expect(m.rpc).toHaveBeenCalledWith('fn_configure_dialpad_member', {
   p_org_id: org, p_owner_user_id: owner, p_member_user_id: member, p_connection_id: connectionId,
   p_expected_connection_version: 2, p_provider_company_id: '101', p_provider_user_id: '201',
   p_verified_at: '2026-09-13T12:00:01Z', p_callers: [office], p_selected_callers: [office], p_expected_binding_revision: 1, p_request_id: id(5),
  });
 });
 it('rejects stale connection before mutation', async () => {
  expect(await saveDialpadMemberCallerAssignment({ ...input(), connectionVersion: 1 })).toEqual({ ok: false, error: 'stale_configuration' }); expect(m.rpc).not.toHaveBeenCalled();
 });
 it.each([{ data: null, error: { code: '23514', message: 'DIALPAD_CONFIGURATION_BINDING_STALE' } }, { data: null, error: null }, { data: { bindingId: id(6), bindingRevision: '2' }, error: null }])('reports uncertain save without inventing success: %j', async response => {
  m.rpc.mockResolvedValue(response);
  expect(await saveDialpadMemberCallerAssignment(input())).toEqual({ ok: false, error: 'configuration_save_unconfirmed' }); expect(m.rpc).toHaveBeenCalledTimes(1);
 });
 it('sanitizes provider and lost RPC response failures without retry', async () => {
  m.rpc.mockRejectedValue(new Error('sensitive response'));
  expect(await saveDialpadMemberCallerAssignment(input())).toEqual({ ok: false, error: 'configuration_save_unconfirmed' }); expect(m.rpc).toHaveBeenCalledTimes(1);
 });
 it('replays after lost response despite provider outage, revoked number and disabled acquisitions', async () => {
  m.replay.mockResolvedValue({ data: { bindingId: id(6), bindingRevision: 2 }, error: null });
  m.roster.mockRejectedValue(new Error('Acquisitions disabled')); m.verify.mockRejectedValue(new Error('Provider outage'));
  expect(await saveDialpadMemberCallerAssignment(input())).toEqual({ ok: true, bindingId: id(6), bindingRevision: 2 });
  expect(m.roster).not.toHaveBeenCalled(); expect(m.verify).not.toHaveBeenCalled(); expect(m.from).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  expect(m.replay).toHaveBeenCalledWith('fn_replay_dialpad_member_configuration', expect.objectContaining({ p_org_id: org, p_owner_user_id: owner, p_member_user_id: member, p_request_id: id(5) }));
 });
 it('does not fall through to provider writes on replay scope conflict', async () => {
  m.replay.mockResolvedValue({data:null,error:{code:'23514'}});
  expect(await saveDialpadMemberCallerAssignment(input())).toEqual({ok:false,error:'configuration_save_unconfirmed'});
  expect(m.verify).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
 });
 it('rejects invalid request before auth work', async () => {
  expect(await saveDialpadMemberCallerAssignment({ ...input(), requestId: 'bad' })).toEqual({ ok: false, error: 'invalid_input' }); expect(m.roster).not.toHaveBeenCalled();
 });
});
