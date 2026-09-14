import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({roster:vi.fn(),admin:vi.fn(),from:vi.fn(),eq:vi.fn(),connection:vi.fn(),binding:vi.fn(),grants:vi.fn(),user:vi.fn(),verify:vi.fn(),client:vi.fn()}));
vi.mock('@/lib/my-leads/queries',()=>({getAcquisitionRoster:m.roster}));
vi.mock('./database',()=>({createDialpadVoiceAdminClient:m.admin}));
vi.mock('./client',()=>({DialpadVoiceClient:class{constructor(key:string){m.client(key);}}}));
vi.mock('./verified-inventory',()=>({verifyDialpadInventory:m.verify}));
import {loadMyDialpadCallerOptions} from './rep-callers';
const org='org',actor='actor';
const roster=()=>({viewer:{orgId:org,userId:actor,isOwner:true},roster:{isOwner:true,settings:{enabled:true},members:[{id:actor,active:true,acquisitionsEnabled:true},{id:'another',active:true,acquisitionsEnabled:true}]}});
const connection=()=>({id:'connection',org_id:org,provider_company_id:'101',enabled:true,config_version:2,verified_at:'2026-09-13',credential_reference:'env:DIALPAD_REP_TEST_KEY'});
const binding=()=>({id:'binding',org_id:org,member_user_id:actor,provider_user_id:'201',revision:3,connection_id:'connection',connection_version:2,revoked_at:null});
const grant=(identity='301')=>({id:'grant-'+identity,org_id:org,binding_id:'binding',revision:4,identity_type:'office',provider_identity_id:identity,number_e164:'+12025550101',revoked_at:null});
const unavailable={ok:false,error:'dialpad_numbers_unavailable'};
beforeEach(()=>{
 vi.resetAllMocks();vi.unstubAllEnvs();vi.stubEnv('DIALPAD_REP_TEST_KEY','test-secret');
 m.roster.mockResolvedValue(roster());m.connection.mockResolvedValue({data:connection(),error:null});m.binding.mockResolvedValue({data:binding(),error:null});m.grants.mockResolvedValue({data:[grant()],error:null});
 m.from.mockImplementation((table:string)=>{
  const q={select:vi.fn().mockReturnThis(),eq:vi.fn(),is:vi.fn(),maybeSingle:table==='dialpad_org_connections'?m.connection:m.binding};
  q.eq.mockImplementation((...args:unknown[])=>{m.eq(table,...args);return q;});q.is.mockImplementation(()=>table==='dialpad_number_grants'?m.grants():q);return q;
 });
 m.admin.mockReturnValue({from:m.from,auth:{admin:{getUserById:m.user}}});m.user.mockResolvedValue({data:{user:{id:actor,email:'rep@example.test'}},error:null});
 m.verify.mockResolvedValue({inventory:{orgId:org,providerUserId:'201',callers:[{number:'+12025550101',identity:{type:'office',id:'301'},active:true}]},provenance:{providerCompanyId:'101',providerUserId:'201',verifiedAt:'2026-09-13'}});
});
describe('current rep Dialpad caller options',()=>{
 it('returns empty without provider access when no numbers are assigned',async()=>{
  m.grants.mockResolvedValue({data:[],error:null});m.verify.mockRejectedValue(new Error('provider unavailable'));
  expect(await loadMyDialpadCallerOptions()).toEqual({ok:true,options:[]});
  expect(m.verify).not.toHaveBeenCalled();expect(m.user).not.toHaveBeenCalled();
 });
 it('scopes even an owner to their own member grants and exposes only dropdown fields',async()=>{
  const result=await loadMyDialpadCallerOptions();
  expect(result).toEqual({ok:true,options:[{provider:'dialpad',grantId:'grant-301',grantRevision:4,bindingRevision:3,connectionVersion:2,phoneE164:'+12025550101',identity:{type:'office',id:'301'}}]});
  expect(m.eq).toHaveBeenCalledWith('dialpad_member_bindings','member_user_id',actor);
  expect(m.eq).toHaveBeenCalledWith('dialpad_org_connections','org_id',org);
  expect(m.eq).toHaveBeenCalledWith('dialpad_number_grants','binding_id','binding');
  expect(m.user).toHaveBeenCalledWith(actor);
  expect(m.verify).toHaveBeenCalledWith(expect.anything(),{orgId:org,providerCompanyId:'101',providerUserId:'201',memberEmail:'rep@example.test'});
  expect(JSON.stringify(result)).not.toContain('test-secret');expect(JSON.stringify(result)).not.toContain('rep@example.test');expect(JSON.stringify(result)).not.toContain('providerUserId');
 });
 it.each(['settings','membership','acquisitions','missing'])('returns empty for %s, with no owner bypass',async gate=>{
  const r=roster();if(gate==='settings')r.roster.settings.enabled=false;if(gate==='membership')r.roster.members[0].active=false;if(gate==='acquisitions')r.roster.members[0].acquisitionsEnabled=false;if(gate==='missing')r.roster.members.shift();m.roster.mockResolvedValue(r);
  expect(await loadMyDialpadCallerOptions()).toEqual({ok:true,options:[]});expect(m.admin).not.toHaveBeenCalled();
 });
 it.each([null,{...connection(),enabled:false},{...connection(),verified_at:null}])('returns empty for unavailable connection %j',async data=>{
  m.connection.mockResolvedValue({data,error:null});expect(await loadMyDialpadCallerOptions()).toEqual({ok:true,options:[]});expect(m.verify).not.toHaveBeenCalled();
 });
 it('returns empty when no binding is assigned',async()=>{m.binding.mockResolvedValue({data:null,error:null});expect(await loadMyDialpadCallerOptions()).toEqual({ok:true,options:[]});expect(m.verify).not.toHaveBeenCalled();});
 it.each([{org_id:'other'},{credential_reference:'env:OTHER_SECRET'}])('rejects cross-org or unsafe connection %j',async patch=>{m.connection.mockResolvedValue({data:{...connection(),...patch},error:null});expect(await loadMyDialpadCallerOptions()).toEqual(unavailable);expect(m.client).not.toHaveBeenCalled();});
 it.each([{org_id:'other'},{member_user_id:'another'},{connection_id:'other'},{connection_version:1},{revoked_at:'2026-09-13'}])('rejects binding query-defense mismatch %j',async patch=>{m.binding.mockResolvedValue({data:{...binding(),...patch},error:null});expect(await loadMyDialpadCallerOptions()).toEqual(unavailable);expect(m.verify).not.toHaveBeenCalled();});
 it.each([{org_id:'other'},{binding_id:'other'},{revoked_at:'2026-09-13'}])('rejects grant query-defense mismatch %j',async patch=>{m.grants.mockResolvedValue({data:[{...grant(),...patch}],error:null});expect(await loadMyDialpadCallerOptions()).toEqual(unavailable);});
 it('omits revoked provider context instead of substituting another group with same E164',async()=>{m.grants.mockResolvedValue({data:[grant('302'),grant('301')],error:null});expect(await loadMyDialpadCallerOptions()).toMatchObject({ok:true,options:[{grantId:'grant-301'}]});});
 it.each(['connection','binding','grants','user'])('sanitizes %s query failure',async key=>{m[key as 'connection'|'binding'|'grants'|'user'].mockResolvedValue({data:null,error:{message:'sensitive query'}});expect(await loadMyDialpadCallerOptions()).toEqual(unavailable);});
 it('sanitizes provider outage',async()=>{m.verify.mockRejectedValue(new Error('sensitive provider payload'));expect(await loadMyDialpadCallerOptions()).toEqual(unavailable);});
});
