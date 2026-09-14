import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), context: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/inbox/supabase-sync-repository", () => ({ createSupabaseInboxRepository: () => ({ getContext: mocks.context }) }));
import { GET } from "./route";
import { InboxHttpError } from "@/lib/inbox/http-error";
const PILOT_USER = "pilot-user-1";
const asPilotUser = () => { mocks.client.mockResolvedValue({ auth: { getUser: mocks.getUser } }); mocks.getUser.mockResolvedValue({ data: { user: { id: PILOT_USER } } }); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", PILOT_USER); };
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
it("does not create a client when the server flag is disabled", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "0");
  expect((await GET(new Request("https://sandra.example/api/inbox/context"))).status).toBe(404);
  expect(mocks.client).not.toHaveBeenCalled();
});
it("returns 404 and never calls the context RPC for a user outside the pilot allowlist (GL-4/G5)", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", PILOT_USER);
  mocks.client.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
  expect((await GET(new Request("https://sandra.example/api/inbox/context"))).status).toBe(404);
  expect(mocks.context).not.toHaveBeenCalled();
});
// MUTATION: removing the pilot check in route.ts makes this fail — the
// out-of-cohort user would reach getContext() (the inbox_* RPC) and get 200.
it("returns 404 when the allowlist is empty (default = nobody)", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
  mocks.client.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: PILOT_USER } } });
  expect((await GET(new Request("https://sandra.example/api/inbox/context"))).status).toBe(404);
  expect(mocks.context).not.toHaveBeenCalled();
});
it("returns only canonical context and explicitly forbids caching", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); asPilotUser(); mocks.context.mockResolvedValue({ orgId: "org", sessionId: "session" });
  const response = await GET(new Request("https://sandra.example/api/inbox/context"));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ orgId: "org", sessionId: "session" });
});
it("preserves canonical authentication denial without exposing private error details", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); asPilotUser(); mocks.context.mockRejectedValue(new InboxHttpError(401));
  expect((await GET(new Request("https://sandra.example/api/inbox/context"))).status).toBe(401);
});
