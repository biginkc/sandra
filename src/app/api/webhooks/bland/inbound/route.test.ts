import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createHmac} from "node:crypto";
const {rpc,admin}=vi.hoisted(()=>({rpc:vi.fn(),admin:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:admin}));
vi.mock("@/lib/errors/report",()=>({reportError:vi.fn()}));
import {POST} from "./route";
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("NORMA_BLAND_INBOUND_WEBHOOK_SECRET","synthetic");admin.mockReturnValue({rpc});rpc.mockResolvedValue({data:"stored",error:null});});
afterEach(()=>vi.unstubAllEnvs());
describe("inbound webhook route wiring",()=>{
 it("creates the service client only after successful authentication and parsing",async()=>{expect((await POST(new Request("https://synthetic.invalid",{method:"POST",body:"{}"}))).status).toBe(401);expect(admin).not.toHaveBeenCalled();});
 it("passes only validated call identities/evidence to the ingestion RPC",async()=>{const body=JSON.stringify({inbound:true,call_id:"call-1",from:"+18165551001",to:"+18165551002",completed:true,recording_url:"https://private.invalid",metadata:{org_id:"untrusted"}});const request=new Request("https://synthetic.invalid",{method:"POST",body,headers:{"x-webhook-signature":createHmac("sha256","synthetic").update(body).digest("hex")}});expect((await POST(request)).status).toBe(200);expect(rpc).toHaveBeenCalledWith("fn_norma_ingest_inbound_call",{p_call_id:"call-1",p_from:"+18165551001",p_to:"+18165551002",p_completed:true,p_recording_state:"reported_available"});});
});
