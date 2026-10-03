import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), persist: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/integrations/slack/installation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/integrations/slack/installation")>()), persistSlackOAuthNonce: mocks.persist }));

import { GET } from "./route";

function request(search = "") {
  return new Request(`https://app.example.com/api/oauth/slack/start${search}`);
}

describe("oauth/slack/start route", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("SLACK_CLIENT_ID", "12345.67890");
    vi.stubEnv("OAUTH_STATE_SIGNING_SECRET", "state-secret");
    vi.stubEnv("SLACK_PREVIEW_OAUTH_ENABLED", "0");
    vi.stubEnv("APP_URL", "https://app.example.com");
    const memberships = { select: vi.fn(), eq: vi.fn() };
    memberships.select.mockReturnValue(memberships);
    memberships.eq.mockResolvedValue({ data: [], error: null });
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
      from: vi.fn(() => memberships),
    });
  });

  it("keeps legacy Slack notification OAuth independent of the preview schema", async () => {
    const response = await GET(request());
    const location = new URL(response.headers.get("location")!);
    expect(location.hostname).toBe("slack.com");
    expect(location.searchParams.get("state")).toMatch(/^user-1\./);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("requires the explicit preview gate before creating a durable nonce", async () => {
    vi.stubEnv("SLACK_PREVIEW_OAUTH_ENABLED", "1");
    const response = await GET(request("?preview=1&org_id=org-1"));
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("start");
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("creates a signed preview state and preserves only same-origin return paths", async () => {
    vi.stubEnv("SLACK_PREVIEW_OAUTH_ENABLED", "1");
    const builder = { select: vi.fn(), eq: vi.fn() };
    builder.select.mockReturnValue(builder);
    builder.eq.mockResolvedValue({ data: [{ org_id: "org-1", user_id: "user-1", access_status: "active" }], error: null });
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
      from: vi.fn(() => builder),
    });
    mocks.persist.mockResolvedValue(undefined);

    const response = await GET(request("?preview=1&org_id=org-1&return_to=/%09/evil.com"));
    const location = new URL(response.headers.get("location")!);
    expect(location.hostname).toBe("slack.com");
    expect(location.searchParams.get("state")).toMatch(/^v2\./);
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", returnPath: null }));
    expect(mocks.persist.mock.calls[0][0].returnPath).toBeNull();

    for (const unsafe of ["/%0A/evil.com", "//evil.com", "https://evil.com/", "https:evil.com"]) {
      await GET(request(`?preview=1&org_id=org-1&return_to=${encodeURIComponent(unsafe)}`));
      expect(mocks.persist.mock.calls.at(-1)?.[0].returnPath).toBeNull();
    }

    const safe = await GET(request("?preview=1&org_id=org-1&return_to=/settings/integrations"));
    expect(new URL(safe.headers.get("location")!).searchParams.get("state")).toMatch(/^v2\./);
    expect(mocks.persist.mock.calls.at(-1)?.[0].returnPath).toBe("/settings/integrations");
  });
});
