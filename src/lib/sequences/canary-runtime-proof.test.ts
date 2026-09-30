import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCanaryAlias, assertCanarySendBinding, assertCanaryStopState, CANARY_HOST, CANARY_SENDER,
  createCanaryProof, runtimeSnapshot, verifyCanaryProof,
} from "./canary-runtime-proof";

const env = { ...process.env };
const deploymentId = "dpl_test";
const commitSha = "a".repeat(40);
const key = "approved-key-with-entropy";
const aliasHost = "sandra.example.test";

function proof(overrides: Record<string, string | number> = {}) {
  return createCanaryProof({
    deploymentId, commitSha, supabaseHost: CANARY_HOST, aliasHost,
    sender: CANARY_SENDER, provider: "sendillo",
    sequenceId: "11111111-1111-4111-8111-111111111111",
    runId: "12345", runMode: "scheduled",
    latestSendAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000, ...overrides,
  }, key);
}

beforeEach(() => {
  vi.stubEnv("SENDILLO_API_KEY", key);
  vi.stubEnv("SENDILLO_FROM_NUMBER", CANARY_SENDER);
  vi.stubEnv("SENDILLO_WEBHOOK_SECRET", "webhook-secret");
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${CANARY_HOST}`);
  vi.stubEnv("TEST_SUPABASE_URL", `https://${CANARY_HOST}`);
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", deploymentId);
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", commitSha);
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", aliasHost);
  vi.stubEnv("SEQUENCE_CANARY_PROPERTY_ID", "fixture-property");
  vi.stubEnv("SEQUENCE_CANARY_CONTACT_ID", "fixture-contact");
  vi.stubEnv("SEQUENCE_CANARY_USER_ID", "fixture-user");
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe("canary runtime proof", () => {
  it("returns only redacted config fields, dynamic HMAC, and no secrets", () => {
    const first = runtimeSnapshot("a".repeat(32));
    const second = runtimeSnapshot("b".repeat(32));
    const body = JSON.stringify(first);
    expect(first.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hmac).not.toBe(second.hmac);
    expect(first.senderMatches).toBe(true);
    expect(first.senderLast4).toBe("6899");
    expect(body).not.toMatch(/approved-key-with-entropy|webhook-secret|\+18164876899/);
  });

  it("rejects missing and wrong effective configuration", () => {
    vi.stubEnv("MESSAGING_PROVIDER", "mock");
    expect(runtimeSnapshot("a".repeat(32)).providerIsSendillo).toBe(false);
    expect(() => verifyCanaryProof(proof())).toThrow(/configuration mismatch/);
    vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
    vi.stubEnv("TEST_SUPABASE_URL", "https://wrong.supabase.co");
    expect(() => verifyCanaryProof(proof())).toThrow(/configuration mismatch/);
    vi.stubEnv("TEST_SUPABASE_URL", `https://${CANARY_HOST}`);
    vi.stubEnv("SENDILLO_WEBHOOK_SECRET", "");
    expect(runtimeSnapshot("a".repeat(32)).webhookSecretPresent).toBe(false);
    expect(() => verifyCanaryProof(proof())).toThrow(/configuration mismatch/);
  });

  it("rejects stale deployment, wrong key, and expired proof", () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_new");
    expect(() => verifyCanaryProof(proof())).toThrow(/configuration mismatch/);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", deploymentId);
    const original = proof();
    vi.stubEnv("SENDILLO_API_KEY", "wrong-key");
    expect(() => verifyCanaryProof(original)).toThrow(/key mismatch/);
    vi.stubEnv("SENDILLO_API_KEY", key);
    expect(() => verifyCanaryProof(proof({ expiresAt: Date.now() - 1 }))).toThrow(/expired/);
  });

  it("rejects a changed production alias", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ deploymentId: "dpl_new", commitSha }),
      { headers: { "Cache-Control": "no-store" } },
    )));
    await expect(assertCanaryAlias(verifyCanaryProof(proof()))).rejects.toThrow(/alias/);
  });

  it("fails closed when the stop state or run authorization changed", async () => {
    vi.stubEnv("CANARY_GITHUB_READ_TOKEN", "read-token");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "false" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "in_progress", run_attempt: 1, event: "schedule",
      }), { status: 200 })));
    await expect(assertCanaryStopState(verifyCanaryProof(proof()))).rejects.toThrow(/stop state/);
  });

  it("accepts a matching fixture proof only after current run and alias checks", async () => {
    vi.stubEnv("CANARY_GITHUB_READ_TOKEN", "read-token");
    const sequenceId = "11111111-1111-4111-8111-111111111111";
    const description = proof();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "true" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "in_progress", run_attempt: 1, event: "schedule",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deploymentId, commitSha }), {
        status: 200, headers: { "Cache-Control": "no-store" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      from: (table: string) => ({
        select: () => ({ eq: () => ({ single: async () => ({
          data: table === "sequence_enrollments"
            ? { sequence_id: sequenceId, property_id: "fixture-property", contact_id: "fixture-contact" }
            : { description, created_by: "fixture-user" },
          error: null,
        }) }) }),
      }),
    };
    await expect(assertCanarySendBinding(client as never, {
      propertyId: "fixture-property", body: "PROD-SMOKE", enrollmentId: "enr",
    })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("blocks a fixture before the provider boundary when proof is missing", async () => {
    const client = {
      from: vi.fn(() => ({ select: () => ({ eq: () => ({ single: async () => ({
        data: { sequence_id: "seq", property_id: "fixture-property", contact_id: "fixture-contact" },
        error: null,
      }) }) }) })),
    };
    await expect(assertCanarySendBinding(client as never, {
      propertyId: "fixture-property", body: "PROD-SMOKE", enrollmentId: "enr",
    })).rejects.toThrow(/ownership|proof/);
  });

  it("does not affect ordinary lead sends", async () => {
    const client = { from: vi.fn() };
    await assertCanarySendBinding(client as never, { propertyId: "ordinary", body: "Hi" });
    expect(client.from).not.toHaveBeenCalled();
  });
});
