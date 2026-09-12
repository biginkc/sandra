import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),getUser:vi.fn(),memberships:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({rpc:mocks.rpc,auth:{getUser:mocks.getUser}})}));
vi.mock('@/lib/auth/memberships',()=>({getCallerMemberships:mocks.memberships}));
import { getAcquisitionBadge,getAcquisitionKpis,getAcquisitionQueue,getAcquisitionRoster } from './queries';
beforeEach(()=>{
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({data:{user:{id:'rep'}}});
  mocks.memberships.mockResolvedValue([{user_id:'rep',org_id:'org',role:'member'}]);
  mocks.rpc.mockResolvedValue({data:{stages:{}},error:null});
});
it('rejects a member-selected foreign queue before RPC',async()=>{
  await expect(getAcquisitionQueue({memberId:'other'})).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('forwards bounded stage cursors but no caller-controlled snapshot',async()=>{
  await getAcquisitionQueue({memberId:'rep',stage:'offer_sent',cursor:'opaque',search:'Main'});
  expect(mocks.rpc).toHaveBeenCalledWith('fn_get_acquisition_queue_page',{p_org_id:'org',p_member_id:'rep',p_stage:'offer_sent',p_cursor:'opaque',p_search:'Main',p_limit:20});
});
it('lets an owner inspect a rep without changing the authenticated viewer',async()=>{
  mocks.memberships.mockResolvedValue([{user_id:'rep',org_id:'org',role:'owner'}]);
  await getAcquisitionQueue({memberId:'other'});
  expect(mocks.rpc.mock.calls[0][1].p_member_id).toBe('other');
});
it('normalizes custom date boundaries in Central time',async()=>{
  await getAcquisitionKpis({memberId:'rep',period:'custom',startDate:'2026-03-07',endDate:'2026-03-08'});
  expect(mocks.rpc.mock.calls[0][1]).toMatchObject({p_start:'2026-03-07T06:00:00.000Z',p_end:'2026-03-09T05:00:00.000Z'});
});
it('does not report read failures as an empty successful queue',async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{code:'08006'}});
  await expect(getAcquisitionQueue({memberId:'rep'})).rejects.toMatchObject({code:'READ_FAILED'});
});
it('treats the disabled badge as absent but preserves real read errors',async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{code:'42501',message:'FEATURE_DISABLED'}});
  expect(await getAcquisitionBadge()).toBe(0);
  mocks.rpc.mockResolvedValue({data:null,error:{code:'08006'}});
  await expect(getAcquisitionBadge()).rejects.toMatchObject({code:'READ_FAILED'});
});
it('does not pick an arbitrary organization',async()=>{
  mocks.memberships.mockResolvedValue([{user_id:'rep',org_id:'one',role:'member'},{user_id:'rep',org_id:'two',role:'member'}]);
  await expect(getAcquisitionRoster()).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('preserves the configured handoff recipient while keeping the member roster scoped',async()=>{
  const recipient={id:'owner',label:'Owner'};
  mocks.rpc.mockResolvedValue({data:{isOwner:false,members:[{id:'rep',label:'Rep',role:'member',acquisitionsEnabled:true,active:true,hasHistory:true}],settings:{enabled:true,recipientId:null,recipient,revision:1}},error:null});
  const {roster}=await getAcquisitionRoster();
  expect(roster.settings.recipient).toEqual(recipient);
  expect(roster.settings.recipientId).toBeNull();
  expect(roster.members.map(member=>member.id)).toEqual(['rep']);
});
