import { describe, expect, it } from "vitest";

import {
  assertLaneSafe,
  CI_DIAL_KEY_REF,
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
    const text = '{"call_id":6543210987654321098,"state":"calling","event_timestamp":1790000000000}';
    const jwt = signDialpadWebhook(text, SECRET);
    const ok = verifyDialpadWebhookJwt(jwt, [SECRET]);
    expect(ok.ok && ok.payloadText).toBe(text);
    expect(verifyDialpadWebhookJwt(jwt, ["another-secret-0123456789abc"]).ok).toBe(false);
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
