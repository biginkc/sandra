import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  memberships: vi.fn(),
  detail: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.create }));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMembershipsOrThrow: mocks.memberships,
}));
vi.mock("@/lib/inbox/read-api", () => ({
  InboxReadError: class InboxReadError extends Error {
    constructor(readonly status: number) {
      super("Inbox read unavailable");
    }
  },
  createInboxReadRepository: () => ({ detail: mocks.detail }),
}));

import { GET } from "./route";

const conversationId = "123e4567-e89b-12d3-a456-426614174000";
const orgId = "123e4567-e89b-12d3-a456-426614174001";
const request = new Request(
  `https://sandra.example/api/inbox/conversations/${conversationId}/detail?orgId=${orgId}`,
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
  mocks.create.mockResolvedValue({});
  mocks.memberships.mockResolvedValue([
    {
      user_id: "member",
      org_id: orgId,
      role: "member",
      acquisitions_enabled: false,
    },
  ]);
  mocks.detail.mockResolvedValue({ conversationId, history: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspace inbox conversation detail", () => {
  it("reads detail for an allowed member", async () => {
    const response = await GET(request, {
      params: Promise.resolve({ conversationId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalled();
  });

  it("denies an active Acquisitions member before reading detail", async () => {
    mocks.memberships.mockResolvedValue([
      {
        user_id: "member",
        org_id: orgId,
        role: "member",
        acquisitions_enabled: true,
      },
    ]);

    const response = await GET(request, {
      params: Promise.resolve({ conversationId }),
    });

    expect(response.status).toBe(404);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
});
