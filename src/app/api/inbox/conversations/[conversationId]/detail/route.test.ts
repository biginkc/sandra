import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  markers: vi.fn(),
  memberships: vi.fn(),
  detail: vi.fn(),
  dripContext: vi.fn(),
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
vi.mock("@/lib/inbox/drip-markers", () => ({
  createInboxDripRepository: () => ({ markers: mocks.markers }),
}));
vi.mock("@/lib/inbox/drip-context", () => ({ loadConversationDripContext: mocks.dripContext }));

import { GET } from "./route";

const conversationId = "123e4567-e89b-12d3-a456-426614174000";
const orgId = "123e4567-e89b-12d3-a456-426614174001";
const reviewPropertyId = "123e4567-e89b-12d3-a456-426614174002";
const maintainedPropertyId = "123e4567-e89b-12d3-a456-426614174003";
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
  mocks.detail.mockResolvedValue({ conversationId, propertyId: reviewPropertyId, history: [] });
  mocks.markers.mockResolvedValue({ orgId, asOf: "2026-09-13T00:00:00Z", rows: [{ conversationId, propertyId: maintainedPropertyId, inDrip: true, dripReplied: false, dripName: "Fixture Drip" }] });
  mocks.dripContext.mockImplementation((_client: unknown, _org: string, _conversation: string, propertyId: string | null | undefined) => Promise.resolve({
    drip: propertyId === maintainedPropertyId ? { enrollmentId: orgId, sequenceId: orgId, name: "Fixture Drip", step: 1, total: 3, replied: false, status: "active", timeZone: "America/Chicago", stoppedAt: null } : null,
  }));
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
    expect(mocks.markers).toHaveBeenCalledWith(orgId, [conversationId], expect.any(AbortSignal));
    expect(mocks.dripContext).toHaveBeenCalledWith(expect.anything(), orgId, conversationId, maintainedPropertyId);
    expect((await response.json()).drip.name).toBe("Fixture Drip");
  });

  it("uses the same maintained property for before pages", async () => {
    const before = "123e4567-e89b-12d3-a456-426614174004";
    const response = await GET(new Request(`${request.url}&before=${before}`), {
      params: Promise.resolve({ conversationId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith(orgId, conversationId, expect.any(AbortSignal), before);
    expect(mocks.markers).toHaveBeenCalledWith(orgId, [conversationId], expect.any(AbortSignal));
    expect(mocks.dripContext).toHaveBeenCalledWith(expect.anything(), orgId, conversationId, maintainedPropertyId);
    expect((await response.json()).drip.name).toBe("Fixture Drip");
  });

  it("passes undefined when the maintained row is absent and never uses the read property", async () => {
    mocks.markers.mockResolvedValue({ orgId, asOf: "2026-09-13T00:00:00Z", rows: [] });
    const response = await GET(request, { params: Promise.resolve({ conversationId }) });

    expect(response.status).toBe(200);
    expect(mocks.dripContext).toHaveBeenCalledWith(expect.anything(), orgId, conversationId, undefined);
    expect((await response.json()).drip).toBeNull();
  });

  it("passes a maintained null property through without accepting a client property", async () => {
    mocks.markers.mockResolvedValue({ orgId, asOf: "2026-09-13T00:00:00Z", rows: [{ conversationId, propertyId: null, inDrip: false, dripReplied: false, dripName: null }] });
    const response = await GET(request, { params: Promise.resolve({ conversationId }) });

    expect(response.status).toBe(200);
    expect(mocks.dripContext).toHaveBeenCalledWith(expect.anything(), orgId, conversationId, null);
    const rejected = await GET(new Request(`${request.url}&propertyId=${maintainedPropertyId}`), { params: Promise.resolve({ conversationId }) });
    expect(rejected.status).toBe(400);
    expect(mocks.markers).toHaveBeenCalledTimes(1);
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
