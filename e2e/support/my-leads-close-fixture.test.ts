import { describe, expect, it } from "vitest";

import { verifyDialpadWebhookJwt } from "../../src/lib/dialpad-cti/webhook-jwt";
import { assertLaneSafe, dialpadEventPayload, MY_LEADS_CLOSE_FLAGS, signDialpadWebhook } from "./my-leads-close-fixture";

describe("my-leads-close fixture (pure parts)", () => {
  it("signs a webhook body the app's verifier accepts, and not with another secret", () => {
    const payload = dialpadEventPayload({ callId: "6543210987654321098", state: "calling", at: 1_790_000_000_000, externalNumber: "+18165550142", targetUserId: "4242424242" });
    const jwt = signDialpadWebhook(payload, "e2e-dialpad-secret-0123456789");
    const ok = verifyDialpadWebhookJwt(jwt, ["e2e-dialpad-secret-0123456789"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payloadText).toBe(payload);
    expect(verifyDialpadWebhookJwt(jwt, ["another-secret-0123456789abc"]).ok).toBe(false);
  });

  it("keeps a 19-digit call_id and the target id unquoted and the timestamp at 13 digits", () => {
    const text = dialpadEventPayload({
      callId: "6543210987654321098", state: "hangup", at: 1_790_000_064_000, dateStarted: 1_790_000_000_000, dateConnected: 1_790_000_004_000,
      customData: "cd-1", externalNumber: "+18165550142", targetUserId: "4242424242", shareLink: "https://dialpad.com/callreview/x", adminRecordingUrl: "https://dialpad.com/blob/x.mp3",
    });
    expect(text.startsWith('{"call_id":6543210987654321098,')).toBe(true);
    expect(text).toContain('"id":4242424242}');
    expect(text).toMatch(/"event_timestamp":\d{13},/);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.public_call_review_share_link).toBe("https://dialpad.com/callreview/x");
    expect(parsed.admin_recording_urls).toEqual(["https://dialpad.com/blob/x.mp3"]);
    expect(parsed.talk_time).toBe(60_000);
    expect(() => dialpadEventPayload({ callId: "abc", state: "calling", at: 1_790_000_000_000, externalNumber: "+1", targetUserId: "1" })).toThrow(/callId/);
    expect(() => dialpadEventPayload({ callId: "1", state: "calling", at: 1_790_000_000, externalNumber: "+1", targetUserId: "1" })).toThrow(/13-digit/);
  });

  it("refuses the ci lane without a disposable loopback database and the attended lanes without RUN_PROD_CANARIES", () => {
    expect(() => assertLaneSafe("ci", {})).toThrow(/E2E_DISPOSABLE_DATABASE/);
    expect(() => assertLaneSafe("ci", { E2E_DISPOSABLE_DATABASE: "1", E2E_CI_SUPABASE_DB_URL: "postgresql://postgres.abc:x@aws-0.pooler.supabase.com:6543/postgres" })).toThrow(/loopback/);
    expect(() => assertLaneSafe("ci", { E2E_DISPOSABLE_DATABASE: "1", E2E_CI_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" })).not.toThrow();
    expect(() => assertLaneSafe("production", {})).toThrow(/Production canaries are disabled/);
    expect(() => assertLaneSafe("preview", { RUN_PROD_CANARIES: "1" })).toThrow(/MY_LEADS_CLOSE_OWNED_PHONES/);
    expect(() => assertLaneSafe("preview", { RUN_PROD_CANARIES: "1", MY_LEADS_CLOSE_OWNED_PHONES: "+18165550100" })).not.toThrow();
  });

  it("names the thirteen kill switches in column order", () => {
    expect(MY_LEADS_CLOSE_FLAGS).toHaveLength(13);
    expect(MY_LEADS_CLOSE_FLAGS[0]).toBe("call_next_strip");
    expect(MY_LEADS_CLOSE_FLAGS[12]).toBe("comp_queue");
  });
});
