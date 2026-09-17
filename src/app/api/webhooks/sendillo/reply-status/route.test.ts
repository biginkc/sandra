import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildSyntheticReplyCallback } from "@/lib/inbox/reply-provider.synthetic";

const { rpcMock, createClientMock, reportErrorMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  createClientMock: vi.fn(),
  reportErrorMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: reportErrorMock,
}));

// A minimal fake provider — this route must call `verifyWebhookSignature`
// and NOT reuse the Outbox status route's parser/reserve helpers.
const verifyWebhookSignature = vi.fn();
vi.mock("@/lib/messaging/registry", () => ({
  getWebhookProvider: vi.fn(() => ({
    providerId: "sendillo",
    verifyWebhookSignature,
    parseInboundWebhook: vi.fn(),
  })),
}));

import { POST } from "./route";
import * as pathSecretRoute from "./[secret]/route";

function req(body: string, headers: Record<string, string> = {}) {
  return new Request("https://sandra.test/api/webhooks/sendillo/reply-status", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/webhooks/sendillo/reply-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    createClientMock.mockReturnValue({ rpc: rpcMock });
    verifyWebhookSignature.mockReturnValue(true);
    rpcMock.mockResolvedValue({ data: { kind: "reconciled" }, error: null });
  });

  it("returns 401 and makes no reconcile call when the signature is invalid", async () => {
    verifyWebhookSignature.mockReturnValue(false);
    const response = await POST(req(JSON.stringify(buildSyntheticReplyCallback("ext-1", "delivered"))));
    expect(response.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("reconciles a recognized delivered event via the reply-specific RPC, never the Outbox helpers", async () => {
    const payload = buildSyntheticReplyCallback("ext-happy-1", "delivered");
    const response = await POST(req(JSON.stringify(payload)));
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("inbox_reply_reconcile_callback", {
      in_provider: "sendillo",
      in_external_id: "ext-happy-1",
      in_terminal: "delivered",
      in_payload: payload,
    });
  });

  it("reconciles a recognized delivery_failed event", async () => {
    const payload = buildSyntheticReplyCallback("ext-fail-1", "delivery_failed");
    await POST(req(JSON.stringify(payload)));
    expect(rpcMock).toHaveBeenCalledWith("inbox_reply_reconcile_callback", expect.objectContaining({ in_terminal: "delivery_failed", in_external_id: "ext-fail-1" }));
  });

  it("is a clean no-op (never calls reconcile) for an unrecognized event name", async () => {
    const response = await POST(req(JSON.stringify({ event: "message.sent", data: { messageId: "ext-2" } })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ignored?: boolean };
    expect(body.ignored).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("is a clean no-op for malformed JSON (never throws, never reconciles)", async () => {
    const response = await POST(req("not json"));
    expect(response.status).toBe(200);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before any signature check or reconcile", async () => {
    const response = await POST(req("x".repeat(64 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("bounds the BYTE size, not the character count — a multi-byte body under the char count but over the byte cap is rejected", async () => {
    // '€' (U+20AC) is ONE UTF-16 code unit (so .length undercounts it) but
    // THREE UTF-8 bytes. 30_000 of them: .length === 30_000 (comfortably
    // under the 64 KiB char-count a buggy check would have measured), but
    // the real byte size is 90_000 — over the 64 KiB (65_536-byte) cap. A
    // char-length check would wrongly accept this; the byte-bounded reader
    // must reject it.
    const body = "€".repeat(30_000);
    expect(body.length).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(64 * 1024);
    const response = await POST(req(body));
    expect(response.status).toBe(413);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("surfaces a 500 and reports when the reconcile RPC errors, without swallowing it", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const response = await POST(req(JSON.stringify(buildSyntheticReplyCallback("ext-3", "delivered"))));
    expect(response.status).toBe(500);
    expect(reportErrorMock).toHaveBeenCalled();
  });

  it("the [secret] variant forwards to the same handler", async () => {
    const payload = buildSyntheticReplyCallback("ext-secret-1", "delivered");
    const response = await pathSecretRoute.POST(
      new Request("https://sandra.test/api/webhooks/sendillo/reply-status/shh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ secret: "shh" }) },
    );
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("inbox_reply_reconcile_callback", expect.objectContaining({ in_external_id: "ext-secret-1" }));
  });
});
