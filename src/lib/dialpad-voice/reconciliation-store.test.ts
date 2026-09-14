import { DialpadVoiceError } from './client';
import { it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reconciliationStore, type ReconciliationDatabase } from './reconciliation-store';
import { reconcileBoundDialpadCalls } from './reconciliation';
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
function setup(rows:unknown[]=[{id:id(2),org_id:id(1),provider_call_id:'123'}]) {
 const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),limit:vi.fn().mockResolvedValue({data:rows,error:null})};
 const job={id:'job',provider_call_id:'123',lease_token:'lease'};
 const rpc=vi.fn(async(name:string)=>({error:null,data:name==='fn_claim_dialpad_rest_reconciliation'?[job]:true}));
 const db={from:vi.fn(()=>query),rpc} as unknown as SupabaseClient<ReconciliationDatabase>;
 const history={readIntent:vi.fn().mockResolvedValue({id:id(2),org_id:id(1),actor_user_id:id(3),dialpad_user_id:'201'}),readConfiguration:vi.fn().mockResolvedValue({intent_id:id(2),org_id:id(1),connection_id:id(4),connection_version:1}),readRevision:vi.fn().mockResolvedValue({org_id:id(1),connection_id:id(4),config_version:1,provider_company_id:'301',credential_reference:'env:DIALPAD_HISTORY',enabled:false})};
 const credentials={resolve:vi.fn().mockResolvedValue('old-key'),getCompany:vi.fn().mockResolvedValue({id:'301'})};
 const getCall=vi.fn().mockResolvedValue({call_id:'123',state:'hangup',event_timestamp:1000,target:{id:'201',type:'user'}});
 const factory=vi.fn(()=>({getCall}));
 return {store:reconciliationStore(db,id(1),history,credentials,factory),query,rpc,history,credentials,getCall,factory};
}
it('reconciles through frozen disabled history after present grants/membership are gone',async()=>{
 const f=setup();expect((await reconcileBoundDialpadCalls(f.store)).acknowledgedReceipts).toBe(1);
 expect(f.query.eq).toHaveBeenCalledWith('org_id',id(1));expect(f.query.eq).toHaveBeenCalledWith('provider_call_id','123');
 expect(f.factory).toHaveBeenCalledWith('old-key');expect(f.getCall).toHaveBeenCalledWith('123');
 expect(f.history.readRevision).toHaveBeenCalledWith(id(1),id(4),1);
});
it.each([[],[{id:id(2),org_id:id(9),provider_call_id:'123'}],[{id:id(2),org_id:id(1),provider_call_id:'123'},{id:id(5),org_id:id(1),provider_call_id:'123'}]].map(rows=>({rows})))('rejects missing, cross-org or ambiguous authoritative binding',async ({rows})=>{
 const f=setup(rows);await reconcileBoundDialpadCalls(f.store);expect(f.getCall).not.toHaveBeenCalled();
 expect(f.rpc).toHaveBeenCalledWith('fn_fail_dialpad_rest_reconciliation',expect.objectContaining({p_permanent:true,p_error_code:'historical_connection_unavailable'}));
});
it('never fetches media/call from a credential rotated into another company',async()=>{
 const f=setup();f.credentials.getCompany.mockResolvedValue({id:'999'});await reconcileBoundDialpadCalls(f.store);expect(f.getCall).not.toHaveBeenCalled();
});

it.each([429,0])('retries transient company verification failure %s without fetching call',async status=>{
 const f=setup();f.credentials.getCompany.mockRejectedValue(new DialpadVoiceError(status===429?'http':'transport',status||undefined));
 await reconcileBoundDialpadCalls(f.store);expect(f.getCall).not.toHaveBeenCalled();
 expect(f.rpc).toHaveBeenCalledWith('fn_fail_dialpad_rest_reconciliation',expect.objectContaining({p_permanent:false,p_error_code:'provider_unavailable'}));
 if(status===429)expect(f.rpc).toHaveBeenCalledWith('fn_defer_dialpad_detail_budget',expect.objectContaining({p_seconds:60}));
});
it('retries transient history database failures',async()=>{
 const f=setup();f.history.readConfiguration.mockRejectedValue(new Error('transient database failure'));await reconcileBoundDialpadCalls(f.store);
 expect(f.rpc).toHaveBeenCalledWith('fn_fail_dialpad_rest_reconciliation',expect.objectContaining({p_permanent:false}));
});
