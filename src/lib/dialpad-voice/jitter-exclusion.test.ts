import { beforeEach, describe, expect, it, vi } from "vitest";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
import { reserveJitterTransport } from "./jitter-exclusion";
describe("Jitter exclusion rollout", () => {
  beforeEach(() => {
    vi.stubEnv("DIALPAD_VOICE_ORG_ID", "");
    vi.stubEnv("DIALPAD_VOICE_START_ENABLED", "false");
    rpc.mockReset();
  });
  it("reserves even with the start flag disabled when schema exists", async () => {
    rpc.mockResolvedValue({ error: null });
    expect(await reserveJitterTransport("org", "rep", "token", "lead")).toBe(true);
  });
  it("allows legacy missing-schema fallback only without pilot configuration", async () => {
    rpc.mockResolvedValue({ error: { code: "PGRST202" } });
    expect(await reserveJitterTransport("org", "rep", "token", null)).toBe(false);
    vi.stubEnv("DIALPAD_VOICE_ORG_ID", "org");
    await expect(reserveJitterTransport("org", "rep", "token", null)).rejects.toThrow("unconfirmed");
  });
  it("never treats transport/database failures as optional migration absence", async () => {
    rpc.mockResolvedValue({ error: { code: "XX000", message: "secret" } });
    await expect(reserveJitterTransport("org", "rep", "token", null)).rejects.toThrow("Another voice call is active or its status is unconfirmed.");
  });
});
