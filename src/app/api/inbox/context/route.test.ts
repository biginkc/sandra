import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/inbox/supabase-sync-repository", () => ({ createSupabaseInboxRepository: () => ({ getContext: mocks.context }) }));
import { GET } from "./route";
import { InboxHttpError } from "@/lib/inbox/http-error";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
it("does not create a client when the server flag is disabled", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "0");
  expect((await GET(new Request("https://sandra.example/api/inbox/context"))).status).toBe(404);
  expect(mocks.client).not.toHaveBeenCalled();
});
it("returns only canonical context and explicitly forbids caching", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); mocks.context.mockResolvedValue({ orgId: "org", sessionId: "session" });
  const response = await GET(new Request("https://sandra.example/api/inbox/context"));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ orgId: "org", sessionId: "session" });
});
it("preserves canonical authentication denial without exposing private error details", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); mocks.context.mockRejectedValue(new InboxHttpError(401));
  expect((await GET(new Request("https://sandra.example/api/inbox/context"))).status).toBe(401);
});
