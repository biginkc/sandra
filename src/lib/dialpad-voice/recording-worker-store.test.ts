import { expect, it, vi } from 'vitest';
import { recordingConnectionResolver } from './recording-worker-store';
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
function fixture(){
 const history={readIntent:vi.fn().mockResolvedValue({id:id(2),org_id:id(1),actor_user_id:id(3),dialpad_user_id:'201',provider_call_id:'123'}),readConfiguration:vi.fn().mockResolvedValue({intent_id:id(2),org_id:id(1),connection_id:id(4),connection_version:1}),readRevision:vi.fn().mockResolvedValue({org_id:id(1),connection_id:id(4),config_version:1,provider_company_id:'301',credential_reference:'env:DIALPAD_OLD',enabled:false})};
 const credentials={resolve:vi.fn().mockResolvedValue('historical-key'),getCompany:vi.fn().mockResolvedValue({id:'301'})};
 return {history,credentials,resolve:recordingConnectionResolver(history,credentials,id(1)),artifact:{org_id:id(1),intent_id:id(2),provider_call_id:'123'}};
}
it('routes revoked historical artifacts using frozen company credential and original rep',async()=>{const f=fixture();expect(await f.resolve(f.artifact)).toMatchObject({providerUserId:'201',apiKey:'historical-key',connectionVersion:1});expect(f.credentials.resolve).toHaveBeenCalledWith('env:DIALPAD_OLD');});
it.each([{org_id:id(9)},{intent_id:null},{provider_call_id:'999'}])('rejects foreign or unbound artifact before credential access',async patch=>{const f=fixture();await expect(f.resolve({...f.artifact,...patch})).rejects.toMatchObject({code:'history_unavailable'});expect(f.credentials.resolve).not.toHaveBeenCalled();});
it('does not promote a candidate-only intent into media binding',async()=>{const f=fixture();f.history.readIntent.mockResolvedValue({id:id(2),org_id:id(1),actor_user_id:id(3),dialpad_user_id:'201',provider_call_id:null});await expect(f.resolve(f.artifact)).rejects.toMatchObject({code:'history_unavailable'});expect(f.credentials.resolve).not.toHaveBeenCalled();});
