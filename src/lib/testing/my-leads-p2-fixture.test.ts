import { describe, expect, it } from "vitest";

import {
  assertLaneSafe,
  CI_DIAL_KEY_REF,
  dialpadEventPayload,
  expireDialIntentCi,
  purgeDialpadEvidenceCi,
  seedFeatureFlags,
  signDialpadWebhook,
} from "../../../e2e/support/my-leads-p2-fixture";
import { verifyDialpadWebhookJwt } from "../dialpad-cti/webhook-jwt";

const SECRET = "e2e-dialpad-secret-0123456789";
const noDb = { connect: () => { throw new Error("must not connect"); }, query: () => { throw new Error("must not query"); } } as never;

describe("my-leads-p2 acceptance fixture (pure parts)", () => {
  it("signs a body the app verifier accepts, and rejects another secret", () => {
    const text = dialpadEventPayload({ callId: "6543210987654321098", state: "calling", at: 1_790_000_000_000, externalNumber: "+18165550142", targetUserId: "4242424242" });
    const jwt = signDialpadWebhook(text, SECRET);
    const ok = verifyDialpadWebhookJwt(jwt, [SECRET]);
    expect(ok.ok && ok.payloadText).toBe(text);
    expect(verifyDialpadWebhookJwt(jwt, ["another-secret-0123456789abc"]).ok).toBe(false);
  });

  it("keeps 19-digit call and 10-digit target ids as bare integers and the timestamp at 13 digits", () => {
    const text = dialpadEventPayload({
      callId: "6543210987654321098", state: "hangup", at: 1_790_000_064_000, dateStarted: 1_790_000_000_000, dateConnected: 1_790_000_004_000,
      customData: "cd", externalNumber: "+18165550142", targetUserId: "4242424242", shareLink: "https://dialpad.com/callreview/x", adminRecordingUrl: "https://dialpad.com/blob/x.mp3",
    });
    expect(text.startsWith('{"call_id":6543210987654321098,')).toBe(true);
    expect(text).toContain('"id":4242424242}');
    expect(text).toMatch(/"event_timestamp":1790000064000,/);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.talk_time).toBe(60_000);
    expect(parsed.admin_recording_urls).toEqual(["https://dialpad.com/blob/x.mp3"]);
    expect(() => dialpadEventPayload({ callId: "abc", state: "calling", at: 1_790_000_000_000, externalNumber: "+1", targetUserId: "1" })).toThrow(/callId/);
    expect(() => dialpadEventPayload({ callId: "1", state: "calling", at: 1_790_000_000, externalNumber: "+1", targetUserId: "1" })).toThrow(/13-digit/);
  });

  it("only runs against a disposable loopback database", () => {
    expect(() => assertLaneSafe("ci", {})).toThrow(/E2E_DISPOSABLE_DATABASE/);
    expect(() => assertLaneSafe("ci", { E2E_DISPOSABLE_DATABASE: "1" })).toThrow(/E2E_CI_SUPABASE_DB_URL/);
    expect(() => assertLaneSafe("ci", { E2E_DISPOSABLE_DATABASE: "1", E2E_CI_SUPABASE_DB_URL: "postgresql://u:p@db.example.com:5432/postgres" })).toThrow();
    expect(() => assertLaneSafe("ci", { E2E_DISPOSABLE_DATABASE: "1", E2E_CI_SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:54322/postgres" })).not.toThrow();
  });

  it("refuses the evidence-touching helpers outside the ci lane before any query", async () => {
    await expect(expireDialIntentCi(noDb, "00000000-0000-0000-0000-000000000001", {})).rejects.toThrow(/E2E_DISPOSABLE_DATABASE/);
    await expect(purgeDialpadEvidenceCi(noDb, {})).rejects.toThrow(/E2E_DISPOSABLE_DATABASE/);
  });

  it("rejects unknown flag names before touching the database and uses the dial-key namespace the dial path accepts", async () => {
    await expect(seedFeatureFlags(noDb, "org", ["not_a_flag"])).rejects.toThrow(/Unknown My Leads flag/);
    expect(CI_DIAL_KEY_REF).toMatch(/^env:DIALPAD_CTI_DIAL_KEY_[A-Z0-9_]{1,120}$/);
  });
});
