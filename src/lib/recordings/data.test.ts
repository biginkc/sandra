import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({user:{id:'10000000-0000-0000-0000-000000000001'},membership:{} as Record<string,unknown>,rpc:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>{
 const query = { select:()=>query, eq:()=>query, maybeSingle:async()=>({data:mocks.membership,error:null}) };
 return { auth:{getUser:async()=>({data:{user:mocks.user},error:null})}, from:()=>query };
}}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:mocks.rpc})}));
import { listRecordings, requireRecordingViewer, recordingDetails, recordingPlayback } from './data';
import { parseRecordingFilters } from './filters';
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('fetch',mocks.fetch);
 mocks.membership={role:'member',acquisitions_enabled:true,access_status:'active',access_expires_at:null,deletion_prepared_at:null};
 mocks.rpc.mockImplementation(async(name:string)=>({data:name==='fn_recording_library_sources'?[]:null,error:null}));
});
describe('server recording boundary',()=>{
 it('rejects nonowners before privileged queries',async()=>{
   await expect(requireRecordingViewer('owner')).rejects.toMatchObject({status:403});expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('rejects revoked or deletion-prepared acquisition access',async()=>{
   mocks.membership.access_status='revoked';await expect(requireRecordingViewer('mine')).rejects.toMatchObject({status:403});
   mocks.membership.access_status='active';mocks.membership.deletion_prepared_at=new Date().toISOString();await expect(requireRecordingViewer('mine')).rejects.toMatchObject({status:403});
 });
 it('always supplies verified identity and mine scope, without caller ids',async()=>{
   mocks.rpc.mockImplementation(async(name:string)=>({data:name==='fn_recording_library_sources'?[]:{rows:[],total:0,users:[],sources:[],outcomes:[],availability:{}},error:null}));
   await listRecordings('mine',parseRecordingFilters({},'mine'));
   expect(mocks.rpc).toHaveBeenLastCalledWith('fn_recording_library_search',expect.objectContaining({p_actor:mocks.user.id,p_scope:'mine'}));
 });
 it('returns 404 for a forged artifact without exposing a locator',async()=>{
   await expect(recordingDetails('mine','recording:forged')).rejects.toMatchObject({status:404});expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('keeps private reference URLs out of details and resolves HTTPS only on demand',async()=>{
   mocks.rpc.mockImplementation(async(name:string)=>({data:name==='fn_recording_library_file_parent'?null:{callId:'attempt:x',source:'manual',file:{id:'reference:x',status:'external',kind:'reference',duration:null,url:'https://example.test/private'}},error:null}));
   expect(await recordingDetails('mine','reference:x')).toEqual({id:'reference:x',status:'external',kind:'reference',duration:null});
   expect(await recordingPlayback('mine','reference:x')).toEqual({externalUrl:'https://example.test/private'});
 });
});
