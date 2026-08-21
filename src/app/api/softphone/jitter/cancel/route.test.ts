import { beforeEach, describe, expect, it, vi } from "vitest";

const cancelAuthenticatedJitterCall = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dialer/jitter-server", () => ({ cancelAuthenticatedJitterCall }));

import { POST } from "./route";

describe("POST /api/softphone/jitter/cancel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an oversized streamed body even without Content-Length", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(4_097)));
        controller.close();
      },
    });
    const response = await POST(new Request("https://sandra.example.test/api/softphone/jitter/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(413);
    expect(cancelAuthenticatedJitterCall).not.toHaveBeenCalled();
  });

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

  it("rejects an invalid reason before recovering or canceling a call", async () => {
    const response = await POST(new Request("https://sandra.example.test/api/softphone/jitter/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: { phoneE164: "+18165550123", callToken: "stable-token" }, reason: "bogus" }),
    }));
    expect(response.status).toBe(400);
    expect(cancelAuthenticatedJitterCall).not.toHaveBeenCalled();
  });

  it("passes the caller-bound capability to the authenticated cancellation boundary", async () => {
    cancelAuthenticatedJitterCall.mockResolvedValue({ ok: true, data: { status: "ended" } });
    const response = await POST(new Request("https://sandra.example.test/api/softphone/jitter/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: "v1.payload.signature", reason: "abandoned" }),
    }));
    expect(response.status).toBe(200);
    expect(cancelAuthenticatedJitterCall).toHaveBeenCalledWith("v1.payload.signature", "abandoned");
  });

});
