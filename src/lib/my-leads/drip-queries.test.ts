import { describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({viewer:vi.fn(),progress:vi.fn()}));
vi.mock('./queries',()=>({myLeadsViewer:mocks.viewer,MyLeadsReadError:class extends Error {
  constructor(_code:string,message:string){super(message);}
}}));
vi.mock('@/lib/sequences/drip-progress',()=>({listDripProgress:mocks.progress}));
import { groupMyLeadDrips,listMyLeadsInDrip } from './drip-queries';

const progress = { propertyId: 'one', enrollmentId: 'e1', sequenceId: 's1', sequenceName: 'Warm check-in', step: 2, totalSteps: 4,
  nextTextAt: null, lastText: null, status: 'Waiting' as const, reason: null };

describe('groupMyLeadDrips', () => {
  it('uses exact stage and search scope when removing active drip rows', () => {
    const result = groupMyLeadDrips([
      { property_id: 'one', stage: 'contacted', in_drip: true, replied_at: null, search_text: 'One Main' },
      { property_id: 'two', stage: 'offer_sent', in_drip: true, replied_at: null, search_text: 'Two Oak' },
    ], [progress, { ...progress, propertyId: 'two' }], 'main');
    expect(result.active.map(row => row.propertyId)).toEqual(['one']);
    expect(result.counts.contacted).toBe(1);
    expect(result.counts.offer_sent).toBe(0);
  });

  it('keeps a replied flag only when the scope query returns a valid reply', () => {
    const result = groupMyLeadDrips([
      { property_id: 'one', stage: 'contacted', in_drip: false, replied_at: '2026-09-29T12:00:00Z', search_text: 'One Main' },
      { property_id: 'two', stage: 'contacted', in_drip: false, replied_at: null, search_text: 'Two Oak' },
    ], [progress, { ...progress, propertyId: 'two' }], '');
    expect(result.replied.map(row => row.propertyId)).toEqual(['one']);
  });
});

it('reads limit plus one scope rows and fails closed on a truncated page', async()=>{
  const rows=Array.from({length:1001},(_,index)=>({property_id:`lead-${index}`,stage:'contacted',
    in_drip:true,replied_at:null,search_text:`Lead ${index}`}));
  const range=vi.fn(async(from:number,to:number)=>({data:rows.slice(from,Math.min(to+1,from+1000)),error:null,count:rows.length}));
  const order=vi.fn(()=>({range}));
  const rpc=vi.fn(()=>({order}));
  mocks.viewer.mockResolvedValue({userId:'rep',orgId:'org',isOwner:false,client:{rpc}});
  mocks.progress.mockImplementation(async(_client:unknown,ids:string[])=>ids.map(id=>({...progress,propertyId:id})));
  const result=await listMyLeadsInDrip('rep');
  expect(result.active).toHaveLength(1001);
  expect(range).toHaveBeenNthCalledWith(1,0,999);
  expect(range).toHaveBeenNthCalledWith(2,1000,1999);
  expect(order).toHaveBeenCalledWith('property_id');
  expect(rpc).toHaveBeenCalledWith('fn_list_my_leads_drip_scope',expect.anything(),{count:'exact'});

  range.mockResolvedValueOnce({data:rows.slice(0,1000),error:null,count:1001})
    .mockResolvedValueOnce({data:[],error:null,count:1001});
  await expect(listMyLeadsInDrip('rep')).rejects.toThrow('could not load completely');
});
