import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),getUser:vi.fn(),memberships:vi.fn(),from:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({rpc:mocks.rpc,from:mocks.from,auth:{getUser:mocks.getUser}})}));
vi.mock('@/lib/auth/memberships',()=>({getCallerMemberships:mocks.memberships}));
import { getAcquisitionBadge,getAcquisitionDetail,getAcquisitionKpis,getAcquisitionQueue,getAcquisitionRoster } from './queries';
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

describe('acquisition text history',()=>{
  const orgId='10000000-0000-4000-8000-000000000001';
  const memberId='10000000-0000-4000-8000-000000000002';
  const propertyId='10000000-0000-4000-8000-000000000003';
  const contactId='10000000-0000-4000-8000-000000000004';
  const otherId='10000000-0000-4000-8000-000000000005';
  const at='2026-09-13T12:00:00.123456+00:00';
  const id=(index:number)=>`20000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
  const message=(index:number)=>({id:id(index),created_at:at,body:`Text ${index}`,direction:'inbound',status:'received',metadata:null as unknown});
  const cursor=(override:Record<string,unknown>={})=>Buffer.from(JSON.stringify({version:1,orgId,memberId,propertyId,at,id:id(11),...override})).toString('base64url');
  let homeowner:string|null;
  let propertyExists:boolean;
  let messages:ReturnType<typeof message>[];
  const requests=(table:string)=>mocks.fetch.mock.calls.map(call=>new URL(String(call[0]))).filter(url=>url.pathname.endsWith(`/${table}`));
  beforeEach(()=>{
    homeowner=contactId;
    propertyExists=true;
    messages=[];
    mocks.getUser.mockResolvedValue({data:{user:{id:memberId}}});
    mocks.memberships.mockResolvedValue([{user_id:memberId,org_id:orgId,role:'member'}]);
    mocks.rpc.mockResolvedValue({data:{groups:{notes:{rows:[],cursor:null,hasMore:false},history:{rows:[],cursor:null,hasMore:false}}},error:null});
    mocks.fetch.mockImplementation(async(url:string)=>Response.json(new URL(String(url)).pathname.endsWith('/properties')
      ?propertyExists?[{homeowner_contact_id:homeowner}]:[]
      :messages));
    // Exercise the actual PostgREST builder so assertions cover the emitted request,
    // including conjunctions between repeated OR groups and timestamp precision.
    const client=createClient('https://my-leads.example','test-key',{auth:{autoRefreshToken:false,persistSession:false},global:{fetch:mocks.fetch}});
    mocks.from.mockImplementation(client.from.bind(client));
  });

  it('supplements the initial detail only after RPC authorization with scoped SMS reads',async()=>{
    messages=[message(1)];
    const detail=await getAcquisitionDetail({memberId,propertyId});
    expect(detail.groups.notes).toEqual({rows:[],cursor:null,hasMore:false});
    expect(detail.groups.messages?.rows.map(row=>row.id)).toEqual([id(1)]);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_get_acquisition_detail',{p_org_id:orgId,p_member_id:memberId,p_property_id:propertyId,p_group:null,p_cursor:null});
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.from.mock.invocationCallOrder[0]);
    const property=requests('properties')[0].searchParams;
    expect(Object.fromEntries(property)).toMatchObject({select:'homeowner_contact_id',org_id:`eq.${orgId}`,id:`eq.${propertyId}`,
      assigned_user_id:`eq.${memberId}`,deleted_at:'is.null',is_dnc_locked:'eq.false'});
    const sms=requests('messages')[0].searchParams;
    expect(Object.fromEntries(sms)).toMatchObject({select:'id,created_at,body,direction,status,metadata',org_id:`eq.${orgId}`,channel:'eq.sms',order:'created_at.desc,id.desc',limit:'21'});
    expect(sms.getAll('or')).toEqual([
      '(direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered,failed,bounced)))',
      `(property_id.eq.${propertyId},and(property_id.is.null,contact_id.eq.${contactId}))`,
    ]);
  });

  it.each([
    [{code:'42501',message:'FEATURE_DISABLED'},'FEATURE_DISABLED'],
    [{code:'42501',message:'STALE_ASSIGNMENT'},'FORBIDDEN'],
    [{code:'08006'},'READ_FAILED'],
  ])('does not read property or SMS data after detail authorization fails (%s)',async(error,code)=>{
    mocks.rpc.mockResolvedValue({data:null,error});
    await expect(getAcquisitionDetail({memberId,propertyId,group:'messages',cursor:cursor()})).rejects.toMatchObject({code});
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('requires authentication and rejects a member-selected foreign queue before RPC',async()=>{
    mocks.getUser.mockResolvedValue({data:{user:null}});
    await expect(getAcquisitionDetail({memberId,propertyId})).rejects.toMatchObject({code:'UNAUTHENTICATED'});
    mocks.getUser.mockResolvedValue({data:{user:{id:memberId}}});
    await expect(getAcquisitionDetail({memberId:otherId,propertyId})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('scopes an owner read to the selected member while retaining the authenticated organization',async()=>{
    mocks.memberships.mockResolvedValue([{user_id:memberId,org_id:orgId,role:'owner'}]);
    await getAcquisitionDetail({memberId:otherId,propertyId,group:'messages'});
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({p_org_id:orgId,p_member_id:otherId});
    expect(requests('properties')[0].searchParams.get('assigned_user_id')).toBe(`eq.${otherId}`);
    expect(requests('messages')[0].searchParams.get('org_id')).toBe(`eq.${orgId}`);
  });

  it('stops before SMS if the property is no longer in the authorized queue',async()=>{
    propertyExists=false;
    await expect(getAcquisitionDetail({memberId,propertyId})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(requests('messages')).toHaveLength(0);
  });

  it('restricts leads without homeowners to explicitly linked property messages',async()=>{
    homeowner=null;
    await getAcquisitionDetail({memberId,propertyId,group:'messages'});
    const sms=requests('messages')[0].searchParams;
    expect(sms.get('property_id')).toBe(`eq.${propertyId}`);
    expect(sms.getAll('or')).toHaveLength(1);
    expect(sms.toString()).not.toContain('contact_id');
  });

  it.each([
    'not+a+base64url+cursor',
    'x'.repeat(1025),
    Buffer.from('[]').toString('base64url'),
    cursor({version:2}),
    cursor({orgId:otherId}),
    cursor({memberId:otherId}),
    cursor({propertyId:otherId}),
    cursor({at:'2026-99-99T00:00:00Z'}),
    cursor({at:'2026-02-30T00:00:00Z'}),
    cursor({at:'2026-09-13T12:00:00Z,id.gt.0'}),
    cursor({id:'id),org_id.neq.null'}),
  ])('rejects malformed or foreign-scoped cursors after authorization: %s',async(invalid)=>{
    await expect(getAcquisitionDetail({memberId,propertyId,group:'messages',cursor:invalid})).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(mocks.rpc).toHaveBeenCalledWith('fn_get_acquisition_detail',{p_org_id:orgId,p_member_id:memberId,p_property_id:propertyId,p_group:'history',p_cursor:null});
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('loads older pages with a stable timestamp/UUID boundary and preserves microseconds',async()=>{
    messages=Array.from({length:21},(_,index)=>message(30-index));
    const first=(await getAcquisitionDetail({memberId,propertyId})).groups.messages!;
    expect(first.rows).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.rows.map(row=>row.id)).toEqual(Array.from({length:20},(_,index)=>id(30-index)));
    expect(JSON.parse(Buffer.from(first.cursor!,'base64url').toString('utf8'))).toEqual({version:1,orgId,memberId,propertyId,at,id:id(11)});
    messages=Array.from({length:10},(_,index)=>message(10-index));
    const next=await getAcquisitionDetail({memberId,propertyId,group:'messages',cursor:first.cursor});
    expect(Object.keys(next.groups)).toEqual(['messages']);
    expect(next.groups.messages?.hasMore).toBe(false);
    expect(next.groups.messages?.cursor).toBeNull();
    expect(new Set([...first.rows,...next.groups.messages!.rows].map(row=>row.id)).size).toBe(30);
    expect(requests('messages')[1].searchParams.getAll('or')).toContain(`(created_at.lt.${at},and(created_at.eq.${at},id.lt.${id(11)}))`);
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_group:'history',p_cursor:null});
  });

  it('returns actual direction, failure state, and attachment count without metadata or media URLs',async()=>{
    messages=[{...message(1),body:'',direction:'outbound',status:'failed',metadata:{mediaUrls:['https://provider.example/private.jpg',null,''],providerSecret:'private'}}];
    const page=(await getAcquisitionDetail({memberId,propertyId,group:'messages'})).groups.messages!;
    expect(page).toEqual({rows:[{id:id(1),at,actorId:null,body:'',direction:'outbound',deliveryStatus:'failed',attachmentCount:1}],cursor:null,hasMore:false});
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['properties','messages'])('reports a %s read failure rather than empty text history',async(table)=>{
    const normal=mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async(url:string,...args:unknown[])=>new URL(String(url)).pathname.endsWith(`/${table}`)
      ?Response.json({message:'database read rejected',code:'42501'},{status:403})
      :normal(url,...args));
    await expect(getAcquisitionDetail({memberId,propertyId})).rejects.toMatchObject({code:'READ_FAILED'});
  });

  it('leaves pagination for existing detail groups on its existing RPC path',async()=>{
    await getAcquisitionDetail({memberId,propertyId,group:'notes',cursor:otherId});
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({p_group:'notes',p_cursor:otherId});
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
