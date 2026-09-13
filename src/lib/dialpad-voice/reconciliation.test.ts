import { describe,it,expect,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import {reconcileBoundDialpadCalls} from './reconciliation';
import {DialpadVoiceError} from './client';
const job={id:'job',provider_call_id:'123',lease_token:'lease'};
const payload={call_id:'123',state:'hangup',event_timestamp:1000};
function fixture(){return {deferBudget:vi.fn().mockResolvedValue(undefined),claim:vi.fn().mockResolvedValue([job]),apply:vi.fn().mockResolvedValue(true),fail:vi.fn().mockResolvedValue(true)};}
describe('bound reconciliation',()=>{
 it('passes raw snapshot without synthesizing correlation or recording state',async()=>{const store=fixture();await reconcileBoundDialpadCalls(store,{getCall:async()=>payload});expect(store.apply).toHaveBeenCalledWith(job,payload);expect(payload).not.toHaveProperty('custom_data');});
 it('rejects different call identity before apply',async()=>{const store=fixture();await reconcileBoundDialpadCalls(store,{getCall:async()=>({...payload,call_id:'999'})});expect(store.apply).not.toHaveBeenCalled();expect(store.fail).toHaveBeenCalledWith(job,true,'snapshot_invalid');});
 it('404 retries without manufacturing terminal evidence',async()=>{const store=fixture();await reconcileBoundDialpadCalls(store,{getCall:async()=>{throw new DialpadVoiceError('http',404);}});expect(store.fail).toHaveBeenCalledWith(job,false,'provider_unavailable');});
 it('429 extends shared budget before retry',async()=>{const store=fixture();await reconcileBoundDialpadCalls(store,{getCall:async()=>{throw new DialpadVoiceError('http',429);}});expect(store.deferBudget).toHaveBeenCalledOnce();expect(store.fail).toHaveBeenCalledWith(job,false,'provider_unavailable');expect(store.deferBudget.mock.invocationCallOrder[0]).toBeLessThan(store.fail.mock.invocationCallOrder[0]);});
 it('permission denial quarantines',async()=>{const store=fixture();await reconcileBoundDialpadCalls(store,{getCall:async()=>{throw new DialpadVoiceError('http',403);}});expect(store.fail).toHaveBeenCalledWith(job,true,'permission_denied');});
 it('lost lease never reports receipt acknowledgedReceipts',async()=>{const store=fixture();store.apply.mockResolvedValue(false);expect(await reconcileBoundDialpadCalls(store,{getCall:async()=>payload})).toEqual({acknowledgedReceipts:0,failed:0,leaseLost:1});});
});
