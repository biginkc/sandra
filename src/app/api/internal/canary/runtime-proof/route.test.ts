import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser } }),
}));

import { dynamic, POST } from "./route";

const request = (token?: string, nonce = "a".repeat(32)) => new Request(
  "https://sandra.example.test/api/internal/canary/runtime-proof",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ nonce }),
  },
);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://copflsklaefwzipsrjqz.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("TEST_SUPABASE_URL", "https://copflsklaefwzipsrjqz.supabase.co");
  vi.stubEnv("ADMIN_EMAILS", "admin@bmhgroupkc.com");
  vi.stubEnv("SENDILLO_API_KEY", "test-provider-secret");
  vi.stubEnv("SENDILLO_WEBHOOK_SECRET", "test-webhook-secret");
  vi.stubEnv("SENDILLO_FROM_NUMBER", "+18164876899");
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "b".repeat(40));
  getUser.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("admin runtime proof route", () => {
  it("is dynamic and denies a missing token before provider config access", async () => {
    expect(dynamic).toBe("force-dynamic");
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getUser).not.toHaveBeenCalled();
  });
  it("returns 401 for an invalid user and 403 for a non-admin", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("bad") });
    expect((await POST(request("bad"))).status).toBe(401);
    getUser.mockResolvedValueOnce({ data: { user: { email: "staff@bmhgroupkc.com" } }, error: null });
    expect((await POST(request("valid"))).status).toBe(403);
    getUser.mockRejectedValueOnce(new Error("auth unavailable"));
    expect((await POST(request("throwing"))).status).toBe(401);
  });
  it("rejects short nonce and returns no secret to an admin", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "admin@bmhgroupkc.com" } }, error: null });
    expect((await POST(request("valid", "a".repeat(30)))).status).toBe(400);
    const response = await POST(request("valid"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toMatch(/test-provider-secret|test-webhook-secret|\+18164876899/);
    expect(JSON.parse(body)).toMatchObject({
      providerIsSendillo: true, senderMatches: true, senderLast4: "6899",
      webhookSecretPresent: true, deploymentId: "dpl_test",
    });
  });
});
