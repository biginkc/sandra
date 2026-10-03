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
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) } });
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
});
