import { describe,it,expect,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import {reconcileBoundDialpadCalls} from './reconciliation';
import {DialpadVoiceError} from './client';
const job={id:'job',provider_call_id:'123',lease_token:'lease'};
const payload={call_id:'123',state:'hangup',event_timestamp:1000,target:{id:'201',type:'user'}};
function fixture(provider={getCall:async()=>payload}){return {resolveClient:vi.fn().mockResolvedValue({providerUserId:'201',...provider}),deferBudget:vi.fn().mockResolvedValue(undefined),claim:vi.fn().mockResolvedValue([job]),apply:vi.fn().mockResolvedValue(true),fail:vi.fn().mockResolvedValue(true)};}
describe('bound reconciliation',()=>{
 it('passes raw snapshot without synthesizing correlation or recording state',async()=>{const store=fixture();await reconcileBoundDialpadCalls(store);expect(store.apply).toHaveBeenCalledWith(job,payload);expect(payload).not.toHaveProperty('custom_data');});
 it('rejects different call identity before apply',async()=>{const store=fixture();store.resolveClient.mockResolvedValue({providerUserId:'201',getCall:async()=>({...payload,call_id:'999'})});await reconcileBoundDialpadCalls(store);expect(store.apply).not.toHaveBeenCalled();expect(store.fail).toHaveBeenCalledWith(job,true,'snapshot_invalid');});
 it('404 retries without manufacturing terminal evidence',async()=>{const store=fixture();store.resolveClient.mockResolvedValue({providerUserId:'201',getCall:async()=>{throw new DialpadVoiceError('http',404);}});await reconcileBoundDialpadCalls(store);expect(store.fail).toHaveBeenCalledWith(job,false,'provider_unavailable');});
 it('429 extends shared budget before retry',async()=>{const store=fixture();store.resolveClient.mockResolvedValue({providerUserId:'201',getCall:async()=>{throw new DialpadVoiceError('http',429);}});await reconcileBoundDialpadCalls(store);expect(store.deferBudget).toHaveBeenCalledOnce();expect(store.fail).toHaveBeenCalledWith(job,false,'provider_unavailable');expect(store.deferBudget.mock.invocationCallOrder[0]).toBeLessThan(store.fail.mock.invocationCallOrder[0]);});
 it('permission denial quarantines',async()=>{const store=fixture();store.resolveClient.mockResolvedValue({providerUserId:'201',getCall:async()=>{throw new DialpadVoiceError('http',403);}});await reconcileBoundDialpadCalls(store);expect(store.fail).toHaveBeenCalledWith(job,true,'permission_denied');});
 it('lost lease never reports receipt acknowledgedReceipts',async()=>{const store=fixture();store.apply.mockResolvedValue(false);expect(await reconcileBoundDialpadCalls(store)).toEqual({acknowledgedReceipts:0,failed:0,leaseLost:1});});
});
