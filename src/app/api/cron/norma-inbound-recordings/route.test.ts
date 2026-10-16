import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const {reconcile,admin}=vi.hoisted(()=>({reconcile:vi.fn(),admin:vi.fn()}));
vi.mock("@/lib/norma/inbound-reconcile",()=>({reconcileInboundRecordings:reconcile}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:admin}));
import {GET} from "./route";
const request=(auth="Bearer cron-test")=>GET(new Request("https://synthetic.invalid",{headers:{authorization:auth}}));
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("CRON_SECRET","cron-test");vi.stubEnv("NORMA_INBOUND_RECORDING_RECONCILIATION_ENABLED","true");vi.stubEnv("BLAND_API_KEY","test-key");admin.mockReturnValue({});reconcile.mockResolvedValue({checked:0});});
afterEach(()=>vi.unstubAllEnvs());
describe("inbound recording cron gates",()=>{
 it("requires cron authorization",async()=>{expect((await request("wrong")).status).toBe(401);expect(admin).not.toHaveBeenCalled();});
 it("defaults off and makes no provider/database call",async()=>{vi.stubEnv("NORMA_INBOUND_RECORDING_RECONCILIATION_ENABLED","");expect(await (await request()).json()).toEqual({status:"disabled"});expect(admin).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();});
 it("requires both secrets without leaking configuration",async()=>{vi.stubEnv("BLAND_API_KEY","");expect((await request()).status).toBe(503);expect(admin).not.toHaveBeenCalled();vi.stubEnv("CRON_SECRET","");expect((await request()).status).toBe(503);});
 it("invokes only the read-only provider reconciliation boundary",async()=>{expect((await request()).status).toBe(200);expect(reconcile).toHaveBeenCalledWith({},"test-key");});
});
