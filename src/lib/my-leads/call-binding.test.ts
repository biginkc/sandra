import { beforeEach, expect, it, vi } from 'vitest';
const rpc=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc})}));
import { bindAcquisitionCallContext } from './call-binding';
const input={orgId:'org',propertyId:'property',actorUserId:'actor',callToken:'10000000-0000-4000-8000-000000000001'};
beforeEach(()=>rpc.mockReset());
it('does not track a disabled organization',async()=>{
  rpc.mockResolvedValue({data:{tracked:false},error:null});
  expect(await bindAcquisitionCallContext(input)).toEqual({tracked:false});
});
it('binds the original episode without storing the token',async()=>{
  rpc.mockResolvedValue({data:{tracked:true,orgId:'org',propertyId:'property',actorUserId:'actor',assignmentEpisodeId:'episode'},error:null});
  expect(await bindAcquisitionCallContext(input)).toEqual({tracked:true,assignmentEpisodeId:'episode'});
  expect(rpc.mock.calls[0][1].p_token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(rpc.mock.calls)).not.toContain(input.callToken);
});
it('does not pretend binding succeeded after an error or context mismatch',async()=>{
  rpc.mockResolvedValue({data:null,error:{message:'private error'}});
  await expect(bindAcquisitionCallContext(input)).rejects.toThrow('Call context could not be recorded.');
  rpc.mockResolvedValue({data:{tracked:true,orgId:'foreign',propertyId:'property',actorUserId:'actor',assignmentEpisodeId:null},error:null});
  await expect(bindAcquisitionCallContext(input)).rejects.toThrow('Invalid call context response.');
});
