import {beforeEach,describe,expect,it,vi} from "vitest";
const {getUser,from,maybeSingle,stream}=vi.hoisted(()=>({getUser:vi.fn(),from:vi.fn(),maybeSingle:vi.fn(),stream:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>({auth:{getUser},from})}));
vi.mock("@/lib/norma/recording-stream",()=>({streamBlandRecording:stream}));
import {GET} from "./route";
const id="11111111-1111-4111-8111-111111111111";
const request=(callId=id)=>GET(new Request("https://synthetic.invalid"),{params:Promise.resolve({callId})});
beforeEach(()=>{vi.clearAllMocks();getUser.mockResolvedValue({data:{user:{id:"user"}},error:null});const query={select:vi.fn(()=>query),eq:vi.fn(()=>query),maybeSingle};from.mockReturnValue(query);maybeSingle.mockResolvedValue({data:{provider_call_id:"stored-call"},error:null});stream.mockResolvedValue(new Response("audio"));});
describe("inbound recording authorization",()=>{
 it("authorizes before looking up a call",async()=>{getUser.mockResolvedValue({data:{user:null},error:null});expect((await request()).status).toBe(401);expect(from).not.toHaveBeenCalled();expect(stream).not.toHaveBeenCalled();});
 it("rejects malformed IDs",async()=>{expect((await request("../arbitrary")).status).toBe(400);expect(from).not.toHaveBeenCalled();});
 it("does not retrieve hidden or missing rows",async()=>{maybeSingle.mockResolvedValue({data:null,error:null});expect((await request()).status).toBe(404);expect(stream).not.toHaveBeenCalled();});
 it("redacts database errors",async()=>{maybeSingle.mockResolvedValue({data:null,error:{message:"private"}});const r=await request();expect(r.status).toBe(500);expect(await r.text()).not.toContain("private");expect(stream).not.toHaveBeenCalled();});
 it("streams only the stored identity through the protected helper",async()=>{expect(await (await request()).text()).toBe("audio");expect(stream).toHaveBeenCalledWith(expect.any(Request),"stored-call");});
});
