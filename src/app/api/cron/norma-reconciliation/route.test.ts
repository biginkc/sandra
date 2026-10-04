import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ admin: vi.fn(), bland: vi.fn(), callback: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/norma/bland", () => ({ createBlandClient: m.bland }));
vi.mock("@/lib/norma/callback-time-ai", () => ({ createCallbackTimeProviderFromEnv: m.callback }));
vi.mock("@/lib/norma/reconcile", () => ({ reconcileNormaCalls: m.reconcile }));
vi.mock("@/lib/norma/dispatch", () => ({ dispatchNormaCall: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
import { GET, POST } from "./route";

describe("Norma maintenance cron", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "local-fixture"); vi.stubEnv("NORMA_MAINTENANCE_HOLD", "1"); });
  afterEach(() => vi.unstubAllEnvs());
  it.each([GET, POST])("holds authenticated scheduler and manual requests before factories or reconciliation", async (handle) => {
    const response = await handle(new Request("https://fixture.test/api/cron/norma-reconciliation", { headers: { authorization: "Bearer local-fixture" } }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, maintenanceHeld: true });
    for (const fn of Object.values(m)) expect(fn).not.toHaveBeenCalled();
  });
  it("retains cron authentication while held", async () => {
    expect((await GET(new Request("https://fixture.test/api/cron/norma-reconciliation"))).status).toBe(401);
    for (const fn of Object.values(m)) expect(fn).not.toHaveBeenCalled();
  });
  it("unset/released hold runs the existing reconciliation path", async () => {
    vi.stubEnv("NORMA_MAINTENANCE_HOLD", "false"); m.reconcile.mockResolvedValue({ errors: 0, scanned: 0 });
    const response = await GET(new Request("https://fixture.test/api/cron/norma-reconciliation", { headers: { authorization: "Bearer local-fixture" } }));
    expect(response.status).toBe(200); expect(m.admin).toHaveBeenCalledOnce(); expect(m.reconcile).toHaveBeenCalledOnce();
  });
});
