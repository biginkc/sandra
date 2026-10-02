import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({user:{id:'10000000-0000-0000-0000-000000000001'},membership:{} as Record<string,unknown>,rpc:vi.fn(),fetch:vi.fn(),dialpadFile:vi.fn(),signDialpadFile:vi.fn(),createSignedUrl:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>{
 const query = { select:()=>query, eq:()=>query, maybeSingle:async()=>({data:mocks.membership,error:null}) };
 return { auth:{getUser:async()=>({data:{user:mocks.user},error:null})}, from:()=>query };
}}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:mocks.rpc,storage:{from:()=>({createSignedUrl:mocks.createSignedUrl})}})}));
vi.mock('@/lib/dialpad-recording/playback',()=>({getDialpadPlaybackFile:mocks.dialpadFile,signDialpadPlaybackFile:mocks.signDialpadFile}));
import { listRecordings, requireRecordingViewer, recordingDetails, recordingPlayback } from './data';
import { parseRecordingFilters } from './filters';
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('fetch',mocks.fetch);
 mocks.membership={role:'member',acquisitions_enabled:true,access_status:'active',access_expires_at:null,deletion_prepared_at:null};
 mocks.rpc.mockImplementation(async(name:string)=>({data:name.includes('sources')?[]:null,error:null}));
 mocks.dialpadFile.mockResolvedValue(null); mocks.signDialpadFile.mockResolvedValue({signedUrl:'https://audio.test/dialpad',expiresAt:'2026-09-29T00:01:00Z'}); mocks.createSignedUrl.mockResolvedValue({data:{signedUrl:'https://audio.test/direct'},error:null});
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
   mocks.rpc.mockImplementation(async(name:string)=>({data:name.includes('sources')?[]:{rows:[],total:0,users:[],sources:[],outcomes:[],availability:{}},error:null}));
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
 it('authorizes a Dialpad track again before signing its private final object',async()=>{
   const file={id:'dpf_'+'a'.repeat(64),duration:12.5,status:'available',kind:'stored',source:'dialpad',track:'tab',epoch:1,completeness:'partial',partialReason:'missing_eof',recordingStatus:'partial',captureId:'10000000-0000-4000-8000-000000000010',orgId:'00000000-0000-4000-8000-000000000bbb',bucket:'dialpad-recordings',storagePath:'00000000-0000-4000-8000-000000000bbb/10000000-0000-4000-8000-000000000010/final/1/tab'};
   mocks.dialpadFile.mockResolvedValue({callId:'call:activity',source:'dialpad',file});
   expect(await recordingDetails('mine',file.id)).toMatchObject({source:'dialpad',track:'tab',epoch:1,completeness:'partial',recordingStatus:'partial'});
   expect(await recordingPlayback('mine',file.id)).toEqual({signedUrl:'https://audio.test/dialpad',expiresAt:'2026-09-29T00:01:00Z'});
   expect(mocks.signDialpadFile).toHaveBeenCalledWith(mocks.user.id,'mine',file.id);
 });
 it('lists Dialpad tracks without contacting the Jitter broker',async()=>{
   const file={id:'dpf_'+'b'.repeat(64),duration:12.5,status:'available',kind:'stored',source:'dialpad',track:'mic',epoch:1,completeness:'complete',partialReason:null,recordingStatus:'sealed'};
   mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
     if(name==='fn_recording_library_sources') return {data:[],error:null};
     if(name==='fn_dialpad_recording_library_sources') return {data:[{id:'10000000-0000-4000-8000-000000000010',actorId:mocks.user.id,recordingStatus:'sealed',files:[file]}],error:null};
     expect(name).toBe('fn_recording_library_search');
     expect(args.p_audio).toEqual([expect.objectContaining({id:'10000000-0000-4000-8000-000000000010',files:[file]})]);
     return {data:{rows:[],total:0,users:[],sources:['dialpad'],outcomes:[],availability:{}},error:null};
   });
   await expect(listRecordings('mine',parseRecordingFilters({},'mine'))).resolves.toMatchObject({rows:[],total:0});
   expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('lists direct recordings without contacting the Jitter broker',async()=>{
   const activityId='10000000-0000-4000-8000-000000000011';
   const directCallId='10000000-0000-4000-8000-000000000012';
   const file={id:'recording:10000000-0000-4000-8000-000000000013',duration:null,status:'available',kind:'stored',source:'sandra_direct',recordingStatus:'available',directCallId,storageBucket:'sandra-direct-recordings',storagePath:`00000000-0000-0000-0000-000000000bbb/${directCallId}/telnyx-recording.wav`};
   mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
     if(name==='fn_recording_library_sources') return {data:[{id:activityId,actorId:mocks.user.id,directCallId,source:'sandra_direct',recordingStatus:'available',files:[file]}],error:null};
     if(name==='fn_dialpad_recording_library_sources') return {data:[],error:null};
     expect(name).toBe('fn_recording_library_search');
     expect(args.p_audio).toEqual([expect.objectContaining({id:activityId,files:[file]})]);
     return {data:{rows:[],total:0,users:[],sources:['sandra_softphone'],outcomes:[],availability:{}},error:null};
   });
   await expect(listRecordings('mine',parseRecordingFilters({},'mine'))).resolves.toMatchObject({rows:[],total:0});
   expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it('signs an owned direct recording from Sandra storage without the Jitter broker',async()=>{
   const activityId='10000000-0000-4000-8000-000000000021';
   const directCallId='10000000-0000-4000-8000-000000000022';
   const recordingId='10000000-0000-4000-8000-000000000023';
   const file={id:`recording:${recordingId}`,duration:73,status:'available',kind:'stored',source:'sandra_direct',recordingStatus:'available',directCallId,storageBucket:'sandra-direct-recordings',storagePath:`00000000-0000-0000-0000-000000000bbb/${directCallId}/telnyx-recording.wav`};
   mocks.createSignedUrl.mockResolvedValueOnce({data:{signedUrl:'https://audio.test/direct'},error:null});
   mocks.rpc.mockImplementation(async(name:string)=>{
     if(name==='fn_recording_library_file_parent') return {data:activityId,error:null};
     if(name==='fn_recording_library_sources') return {data:[{id:activityId,actorId:mocks.user.id,directCallId,source:'sandra_direct',recordingStatus:'available',files:[file]}],error:null};
     if(name==='fn_dialpad_recording_library_sources') return {data:[],error:null};
     if(name==='fn_recording_library_file') return {data:{callId:`call:${activityId}`,source:'sandra_direct',file},error:null};
     throw new Error(`unexpected rpc ${name}`);
   });
   await expect(recordingPlayback('mine',file.id)).resolves.toMatchObject({signedUrl:'https://audio.test/direct'});
   expect(mocks.createSignedUrl).toHaveBeenCalledWith(file.storagePath,60);
   expect(mocks.fetch).not.toHaveBeenCalled();
 });
});
