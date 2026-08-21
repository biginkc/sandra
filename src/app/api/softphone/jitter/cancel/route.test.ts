import { beforeEach, describe, expect, it, vi } from "vitest";

const cancelAuthenticatedJitterCall = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dialer/jitter-server", () => ({ cancelAuthenticatedJitterCall }));

import { POST } from "./route";

describe("POST /api/softphone/jitter/cancel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a stable invalid-request envelope for non-object JSON", async () => {
    const response = await POST(new Request("https://sandra.example.test/api/softphone/jitter/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A JSON object is required.",
      error_code: "invalid_request",
    });
    expect(cancelAuthenticatedJitterCall).not.toHaveBeenCalled();
  });

  it("passes the caller-bound capability to the authenticated cancellation boundary", async () => {
    cancelAuthenticatedJitterCall.mockResolvedValue({ ok: true, data: { tornDown: true } });
    const response = await POST(new Request("https://sandra.example.test/api/softphone/jitter/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionRef: "v1.payload.signature", reason: "abandoned" }),
    }));
    expect(response.status).toBe(200);
    expect(cancelAuthenticatedJitterCall).toHaveBeenCalledWith("v1.payload.signature", "abandoned");
  });
});
