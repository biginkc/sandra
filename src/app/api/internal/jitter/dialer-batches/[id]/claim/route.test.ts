import { describe, expect, it, vi } from "vitest";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("../../../_lib/auth", () => ({
  requireIdempotencyKey: () => null,
  authenticateJitterWriteback: async () => ({ ok: true, orgId: "org", rawBody: '{"jitter_session_id":"session"}', serviceClient: { rpc } }),
  checkAndRecordIdempotency: async () => ({ state: "reserved", requestHash: "hash" }),
}));
import { POST } from "./route";
const run = () => POST(new Request("https://fixture.test", { method: "POST", headers: { "idempotency-key": "token" } }), { params: Promise.resolve({ id: "batch" }) });
describe("batch call transport exclusion", () => {
  it("reports the exact guarded conflict without leaking database details", async () => {
    rpc.mockResolvedValue({ error: { code: "23514", message: "VOICE_BATCH_TRANSPORT_CONFLICT" } });
    const response = await run(); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", error_code: "voice_transport_conflict" });
  });
  it("does not disguise unrelated constraint failures as call conflicts", async () => {
    rpc.mockResolvedValue({ error: { code: "23514", message: "private diagnostic" } });
    const response = await run(); expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
