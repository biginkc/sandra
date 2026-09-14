import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({roster:vi.fn(),inspect:vi.fn(),bind:vi.fn(),db:vi.fn(),inventory:vi.fn(),device:vi.fn(),initiate:vi.fn(),rpc:vi.fn(),old:null as unknown}));
vi.mock('server-only',()=>({}));vi.mock('node:crypto',()=>({randomUUID:()=> '11111111-1111-4111-8111-111111111111'}));
vi.mock('@/lib/my-leads/queries',()=>({getAcquisitionRoster:h.roster}));vi.mock('@/lib/dialer/actions',()=>({inspectLeadCall:h.inspect}));vi.mock('@/lib/my-leads/call-binding',()=>({bindAcquisitionCallContext:h.bind}));vi.mock('./database',()=>({createDialpadVoiceAdminClient:h.db}));vi.mock('./verified-inventory',()=>({verifyDialpadInventory:h.inventory}));vi.mock('./desktop-device',()=>({verifySelectedDialpadDesktop:h.device}));
vi.mock('./client',()=>({DialpadVoiceClient:class{initiateSelectedDeviceCall=h.initiate;},DialpadVoiceError:class extends Error{code='transport';}}));
import {startConfiguredDialpadCall}from'./configured-start';
const id='11111111-1111-4111-8111-111111111111',input={propertyId:id,grantId:id,bindingRevision:1,grantRevision:1,connectionVersion:1,deviceId:'native',idempotencyKey:id};
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('DIALPAD_CONFIGURED_START_ENABLED','true');vi.stubEnv('DIALPAD_KEY','fixture');h.old=null;
h.roster.mockResolvedValue({viewer:{orgId:id,userId:id},roster:{settings:{enabled:true},members:[{id,active:true,acquisitionsEnabled:true}]}});
h.inspect.mockResolvedValue({ok:true,data:{propertyId:id,phoneE164:'+12025550199'}});h.bind.mockResolvedValue({tracked:true});h.device.mockResolvedValue({readiness:'unproven'});h.inventory.mockResolvedValue({inventory:{callers:[{number:'+12025550101',identity:{type:'office',id:'301'}}]},provenance:{verifiedAt:new Date().toISOString()}});h.initiate.mockResolvedValue({call_id:'123'});
h.rpc.mockImplementation(async(name:string)=>({error:null,data:name==='fn_record_dialpad_dispatch_response'?{recorded:true}:name==='fn_prepare_dialpad_configured_intent'?{intentId:id}:name==='fn_prepare_dialpad_sequence_pause'?{paused:1}:name==='fn_release_dialpad_start'?{released:true}:{dispatched:true,intentId:id,connectionId:id,connectionVersion:1,credentialReference:'env:DIALPAD_KEY',providerCompanyId:'101',providerUserId:'201',deviceId:'native',phoneNumber:'+12025550199',outboundCallerId:'+12025550101',identityType:'office',identityId:'301',customData:id}}));
h.db.mockReturnValue({auth:{admin:{getUserById:async()=>({data:{user:{id,email:'fixture@example.invalid'}}})}},rpc:h.rpc,from:(table:string)=>{const row=table==='dialpad_voice_intents'?h.old:table==='dialpad_org_connections'?{id,org_id:id,enabled:true,verified_at:'now',config_version:1,credential_reference:'env:DIALPAD_KEY',provider_company_id:'101'}:table==='dialpad_member_bindings'?{id,org_id:id,member_user_id:id,revoked_at:null,connection_id:id,connection_version:1,revision:1,provider_user_id:'201'}:table==='dialpad_number_grants'?{id,org_id:id,binding_id:id,revoked_at:null,revision:1,identity_type:'office',provider_identity_id:'301',number_e164:'+12025550101'}:{id};const chain={select:()=>chain,eq:()=>chain,is:()=>chain,insert:()=>chain,maybeSingle:async()=>({data:row}),single:async()=>({data:row})};return chain;}});
});
it('dispatches once using exact shared persona and raw intent after SQL claim',async()=>{expect((await startConfiguredDialpadCall(input)).ok).toBe(true);expect(h.initiate).toHaveBeenCalledExactlyOnceWith({userId:'201',deviceId:'native',phoneNumber:'+12025550199',outboundCallerId:'+12025550101',customData:id,group:{id:'301',type:'office'}});expect(h.inspect).toHaveBeenCalledTimes(2);});
it('replay never redials',async()=>{h.old={id,property_id:id,status:'initiation_unconfirmed'};await startConfiguredDialpadCall(input);expect(h.initiate).not.toHaveBeenCalled();expect(h.inventory).not.toHaveBeenCalled();});
it('denies non-acquisitions caller',async()=>{h.roster.mockResolvedValue({viewer:{orgId:id,userId:id},roster:{settings:{enabled:true},members:[]}});expect((await startConfiguredDialpadCall(input)).ok).toBe(false);expect(h.initiate).not.toHaveBeenCalled();});
it('changed quiet-hours eligibility releases undispatched pause',async()=>{h.inspect.mockResolvedValueOnce({ok:true,data:{propertyId:id,phoneE164:'+12025550199'}}).mockResolvedValueOnce({ok:false});expect(await startConfiguredDialpadCall(input)).toMatchObject({status:'failed'});expect(h.initiate).not.toHaveBeenCalled();});
it('lost dispatch response never sends HTTP or releases claim',async()=>{const original=h.rpc.getMockImplementation()!;h.rpc.mockImplementation((name,...args)=>name==='fn_dispatch_configured_dialpad_intent'?Promise.resolve({error:{code:'timeout'}}):original(name,...args));expect(await startConfiguredDialpadCall(input)).toMatchObject({status:'initiation_unconfirmed'});expect(h.initiate).not.toHaveBeenCalled();expect(h.rpc.mock.calls.some(c=>c[0]==='fn_release_dialpad_start')).toBe(false);});
it.each(['42501','23514','22023'])('confirmed SQL rejection %s releases only the undispatched reservation',async code=>{
 const original=h.rpc.getMockImplementation()!;
 h.rpc.mockImplementation((name,...args)=>name==='fn_dispatch_configured_dialpad_intent'?Promise.resolve({error:{code}}):original(name,...args));
 expect(await startConfiguredDialpadCall(input)).toMatchObject({status:'failed'});
 expect(h.initiate).not.toHaveBeenCalled();
 expect(h.rpc).toHaveBeenCalledWith('fn_release_dialpad_start',{p_intent_id:id});
});
it('failed cleanup after confirmed rejection keeps uncertainty',async()=>{
 const original=h.rpc.getMockImplementation()!;
 h.rpc.mockImplementation((name,...args)=>name==='fn_dispatch_configured_dialpad_intent'?Promise.resolve({error:{code:'42501'}}):name==='fn_release_dialpad_start'?Promise.reject(Error('timeout')):original(name,...args));
 expect(await startConfiguredDialpadCall(input)).toMatchObject({status:'initiation_unconfirmed'});
 expect(h.initiate).not.toHaveBeenCalled();
});
it('uncertain HTTP retains intent and never retries',async()=>{h.initiate.mockRejectedValue(new Error('timeout'));expect(await startConfiguredDialpadCall(input)).toMatchObject({status:'initiation_unconfirmed'});expect(h.initiate).toHaveBeenCalledTimes(1);});

it('retains exact API response candidate without credit',async()=>{await startConfiguredDialpadCall(input);expect(h.rpc).toHaveBeenCalledWith('fn_record_dialpad_dispatch_response',{p_org_id:id,p_actor_id:id,p_intent_id:id,p_candidate_call_id:'123'});});
it('candidate receipt failure never repeats POST',async()=>{const original=h.rpc.getMockImplementation()!;h.rpc.mockImplementation((name,...args)=>name==='fn_record_dialpad_dispatch_response'?Promise.reject(new Error('database timeout')):original(name,...args));expect(await startConfiguredDialpadCall(input)).toMatchObject({status:'initiation_unconfirmed'});expect(h.initiate).toHaveBeenCalledTimes(1);});

it('wrong native account verification blocks preparation',async()=>{h.device.mockRejectedValueOnce(new Error('wrong owner'));expect((await startConfiguredDialpadCall(input)).ok).toBe(false);expect(h.bind).not.toHaveBeenCalled();expect(h.initiate).not.toHaveBeenCalled();});
it('stale binding revision blocks provider queries',async()=>{expect(await startConfiguredDialpadCall({...input,bindingRevision:2})).toEqual({ok:false,error:'binding_unavailable'});expect(h.inventory).not.toHaveBeenCalled();});
it('stale grant revision blocks provider queries',async()=>{expect(await startConfiguredDialpadCall({...input,grantRevision:2})).toEqual({ok:false,error:'grant_unavailable'});expect(h.inventory).not.toHaveBeenCalled();});
it('same shared number with a different identity is rejected',async()=>{h.inventory.mockResolvedValueOnce({inventory:{callers:[{number:'+12025550101',identity:{type:'office',id:'999'}}]}});expect(await startConfiguredDialpadCall(input)).toEqual({ok:false,error:'grant_not_verified'});expect(h.initiate).not.toHaveBeenCalled();});
