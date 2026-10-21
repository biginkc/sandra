import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { holder, admin } = vi.hoisted(() => ({ holder: { store: null as unknown }, admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: admin }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));
vi.mock("@/lib/voicemail-drop/status-updates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voicemail-drop/status-updates")>()),
  supabaseDropStatusStore: () => holder.store,
}));

import { createFakeDropStore } from "@/lib/voicemail-drop/status-updates.fake";

import { POST } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
let fake: ReturnType<typeof createFakeDropStore>;

function call(secret: string, body: Record<string, unknown>) {
  return POST(new Request("https://synthetic.invalid/cb", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ secret }),
  });
}

beforeEach(() => {
  vi.stubEnv("DROPCOWBOY_CALLBACK_SECRET", "cb-secret");
  fake = createFakeDropStore([
    { id: ID, enrollment_id: "enr-1", step_run_id: "run-1", status: "queued", attempt_outcome: "queued", drop_id: null, to_phone: "+18165550101", queued_at: new Date().toISOString() },
  ]);
  holder.store = fake.store;
});
afterEach(() => vi.unstubAllEnvs());

describe("dropcowboy rvm callback route", () => {
  it("503 when the secret is not configured", async () => {
    vi.stubEnv("DROPCOWBOY_CALLBACK_SECRET", "");
    expect((await call("cb-secret", { foreign_id: ID, status: "success" })).status).toBe(503);
  });

  it("401 on a wrong secret path, before any DB work", async () => {
    expect((await call("nope", { foreign_id: ID, status: "success" })).status).toBe(401);
    expect((await call("cb-secret-longer", { foreign_id: ID, status: "success" })).status).toBe(401);
    expect(fake.drops[0].status).toBe("queued");
  });

  it("404 on an unknown foreign_id", async () => {
    expect((await call("cb-secret", { foreign_id: "22222222-2222-4222-8222-222222222222", status: "success" })).status).toBe(404);
  });

  it("400 on a bad body", async () => {
    expect((await call("cb-secret", { foreign_id: ID, status: "weird" })).status).toBe(400);
  });

  it("persists drop_id", async () => {
    expect((await call("cb-secret", { foreign_id: ID, drop_id: "dc-77", status: "success", reason_code: 0 })).status).toBe(200);
    expect(fake.drops[0]).toMatchObject({ drop_id: "dc-77", status: "delivered" });
  });
});
