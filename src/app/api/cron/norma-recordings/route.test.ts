import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { admin, reconcile } = vi.hoisted(() => ({ admin: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: admin }));
vi.mock("@/lib/norma/recording-reconcile", () => ({ reconcileRecordings: reconcile }));
import { GET } from "./route";
const request = (key="cron-secret") => GET(new Request("https://test.invalid",{headers:{authorization:`Bearer ${key}`}}));
beforeEach(() => {vi.clearAllMocks();vi.stubEnv("CRON_SECRET","cron-secret");vi.stubEnv("BLAND_API_KEY","private");vi.stubEnv("NORMA_RECORDING_RECONCILIATION_ENABLED","");});
afterEach(() => vi.unstubAllEnvs());
describe("recording reconciliation admission",() => {
  it("requires cron auth",async() => {expect((await request("wrong")).status).toBe(401);expect(admin).not.toHaveBeenCalled();});
  it("defaults off without database/provider work",async() => {expect(await (await request()).json()).toEqual({status:"disabled"});expect(admin).not.toHaveBeenCalled();});
  it("requires configured secrets",async() => {vi.stubEnv("CRON_SECRET","");expect((await request()).status).toBe(503);});
  it("runs only when explicitly enabled and keeps errors private",async() => {vi.stubEnv("NORMA_RECORDING_RECONCILIATION_ENABLED","true");reconcile.mockRejectedValue(new Error("private"));const response=await request();expect(response.status).toBe(500);expect(await response.text()).not.toContain("private");});
});
