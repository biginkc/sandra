import {beforeEach,describe,expect,it,vi} from "vitest";
const {getUser,from,callLookup,rpc,propertySearch}=vi.hoisted(()=>({getUser:vi.fn(),from:vi.fn(),callLookup:vi.fn(),rpc:vi.fn(),propertySearch:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>({auth:{getUser},from,rpc})}));
import {associateCallback,findCallbackLeads} from "./actions";
const id="11111111-1111-4111-8111-111111111111";
beforeEach(()=>{vi.clearAllMocks();getUser.mockResolvedValue({data:{user:{id:"user"}},error:null});callLookup.mockResolvedValue({data:null,error:null});const calls={select:vi.fn(()=>calls),eq:vi.fn(()=>calls),maybeSingle:callLookup};from.mockImplementation((table)=>table==="norma_inbound_calls"?calls:propertySearch());});
describe("callback review action authorization",()=>{
 it("does not search properties when RLS hides the call",async()=>{expect(await findCallbackLeads(id,"Main")).toEqual({error:"Call not found",leads:[]});expect(propertySearch).not.toHaveBeenCalled();});
 it("requires a session before searching",async()=>{getUser.mockResolvedValue({data:{user:null},error:null});expect((await findCallbackLeads(id,"Main")).error).toBe("Not authorized");expect(from).not.toHaveBeenCalled();});
 it("does not accept a caller-provided reviewer identity",async()=>{rpc.mockResolvedValue({data:id,error:null});expect(await associateCallback(id,id,"2026-10-05T00:00:00Z")).toEqual({ok:true});expect(rpc).toHaveBeenCalledWith("fn_norma_associate_inbound_call",{p_call_id:id,p_property_id:id,p_expected_updated_at:"2026-10-05T00:00:00Z"});});
 it("reports optimistic concurrency rejection without raw database details",async()=>{rpc.mockResolvedValue({data:null,error:{code:"40001",message:"private"}});expect(await associateCallback(id,id,"2026-10-05T00:00:00Z")).toEqual({error:"This call changed. Reload before reviewing it."});});
});
