import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
import { POST } from "./route";
const sample = { flow: "messages.selection", stage: "usable_dom", outcome: "completed", durationMs: 12 };
const request = (value: unknown, origin = "https://sandra.test") => new Request("https://sandra.test/api/performance", { method: "POST", headers: { origin }, body: JSON.stringify(value) });
beforeEach(() => {
  vi.stubEnv("SANDRA_PERFORMANCE_TELEMETRY", "1");
  mocks.create.mockResolvedValue({ auth: { getUser: mocks.user } });
  mocks.user.mockResolvedValue({ data: { user: { id: "private-user-id" } } });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("requires same-origin authenticated submissions and logs no identity", async () => {
  expect((await POST(request(sample, "https://foreign.test"))).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  const response = await POST(request({ ...sample, body: "private-message" }));
  expect(response.status).toBe(204);
  expect(console.info).toHaveBeenCalledOnce();
  expect(vi.mocked(console.info).mock.calls[0][0]).not.toMatch(/private-message|private-user-id/);
});
it("rejects oversized bodies before auth and does not log failed auth", async () => {
  expect((await POST(request({ ...sample, extra: "x".repeat(5000) }))).status).toBe(413);
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.user.mockResolvedValue({ data: { user: null } });
  expect((await POST(request(sample))).status).toBe(401);
  expect(console.info).not.toHaveBeenCalled();
});
it("does nothing when disabled", async () => {
  vi.stubEnv("SANDRA_PERFORMANCE_TELEMETRY", "0");
  expect((await POST(request(sample))).status).toBe(204);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(console.info).not.toHaveBeenCalled();
});
