import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INPUTS, calculateClosr } from '@/lib/calculators/closr-v1';
import type { SaveCalculationInput } from '@/lib/calculators/types';
const mocks=vi.hoisted(()=>({viewer:vi.fn(),lead:vi.fn(),list:vi.fn(),search:vi.fn(),rpc:vi.fn(),revalidate:vi.fn()}));
vi.mock('@/lib/calculators/server',()=>({calculatorViewer:mocks.viewer,getCalculatorLead:mocks.lead,listCalculations:mocks.list,searchLeads:mocks.search}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:mocks.rpc})}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
import { saveCalculation, loadLeadCalculations } from './actions';
const leadId='11111111-1111-4111-8111-111111111111';
function input():SaveCalculationInput{return {leadId,requestId:'22222222-2222-4222-8222-222222222222',parentId:null,inputs:{...DEFAULT_INPUTS,asIs:255000,arv:350000,rehab:50000},decision:{approach:'novation',program:'equity_protection',feeTier:10000,proposedOffer:180000,terms:'Test',motivation:'Test'},provenance:{source:'lead_search',leadId}};}
beforeEach(()=>{vi.resetAllMocks();mocks.viewer.mockResolvedValue({userId:'trusted-actor'});mocks.lead.mockResolvedValue({id:leadId});mocks.rpc.mockResolvedValue({data:{id:'snapshot',property_id:leadId},error:null});});
describe('calculator save boundary',()=>{
 it('recomputes results and derives actor on the server',async()=>{
  const data=input();expect((await saveCalculation({...data,results:{equity:1},created_by:'attacker'} as SaveCalculationInput)).ok).toBe(true);
  const [name,args]=mocks.rpc.mock.calls[0];expect(name).toBe('fn_save_offer_calculation');expect(args.p_actor_id).toBe('trusted-actor');expect(args.p_results).toEqual(calculateClosr(data.inputs));expect(args.p_inputs.listingPercentage).toBe(.9);
 });
 it('never invokes privileged persistence without workspace and lead access',async()=>{
  mocks.viewer.mockRejectedValueOnce(new Error('denied'));expect((await saveCalculation(input())).ok).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.lead.mockRejectedValueOnce(new Error('unassigned'));expect((await saveCalculation(input())).ok).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('keeps idempotency identity stable on identical retry and binds changed inputs',async()=>{
  const data=input();await saveCalculation(data);await saveCalculation(data);expect(mocks.rpc.mock.calls[0][1].p_request_hash).toBe(mocks.rpc.mock.calls[1][1].p_request_hash);
  await saveCalculation({...data,inputs:{...data.inputs,listingPercentage:.92}});expect(mocks.rpc.mock.calls[2][1].p_request_hash).not.toBe(mocks.rpc.mock.calls[0][1].p_request_hash);
 });
 it('reports a committed snapshot despite cache failure',async()=>{mocks.revalidate.mockImplementation(()=>{throw new Error('cache');});expect((await saveCalculation(input())).ok).toBe(true);});
 it('returns retryable failure without leaking database details',async()=>{mocks.rpc.mockResolvedValueOnce({data:null,error:{message:'secret database detail'}});const result=await saveCalculation(input());expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('secret');});
 it('rejects malformed input before privileged work',async()=>{expect((await saveCalculation({...input(),leadId:'wrong'})).ok).toBe(false);expect(mocks.viewer).not.toHaveBeenCalled();});
 it('reads saved calculations without requiring workspace membership',async()=>{mocks.list.mockResolvedValueOnce([]);expect(await loadLeadCalculations(leadId)).toEqual({ok:true,data:[]});expect(mocks.viewer).not.toHaveBeenCalled();});
 it('validates paging cursors before using PostgREST filters',async()=>{
  expect((await loadLeadCalculations(leadId,{id:leadId,createdAt:'2026-09-16T00:00:00Z),org_id.neq.secret'})).ok).toBe(false);expect(mocks.list).not.toHaveBeenCalled();
  mocks.list.mockResolvedValueOnce([]);const cursor={id:leadId,createdAt:'2026-09-16T00:00:00.123456+00:00'};expect((await loadLeadCalculations(leadId,cursor)).ok).toBe(true);expect(mocks.list).toHaveBeenCalledWith(leadId,cursor);
 });
});
