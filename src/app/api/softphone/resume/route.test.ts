import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, resumeByProperty } = vi.hoisted(() => ({
  createClient: vi.fn(),
  resumeByProperty: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/sequences/enrollment", () => ({ resumeByProperty }));

import { POST } from "./route";

describe("POST /api/softphone/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
        }),
      },
    });
    resumeByProperty.mockResolvedValue({ resumed: 1 });
  });

  it("attributes a confirmed resume to the authenticated user", async () => {
    const response = await POST(
      new Request("http://localhost/api/softphone/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ propertyId: "property-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resumed: 1 });
    expect(resumeByProperty).toHaveBeenCalledWith(expect.anything(), {
      propertyId: "property-1",
      actor: { actorType: "user", actorId: "user-1" },
    });
  });
});
