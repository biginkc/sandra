import assert from "node:assert/strict";
import test from "node:test";

import {
  READ_ONLY_ORG_ESIGN_COLUMNS,
  classifyCanaryPreflight,
} from "./canary-esign-preflight.mjs";

const LIVE_SALES_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

function connectedEligibleIntegration() {
  return {
    org_id: "11111111-1111-1111-1111-111111111111",
    provider: "dropbox_sign",
    api_key_last_four: "1234",
    sending_enabled: true,
    test_mode: false,
    disconnect_pending_at: null,
  };
}

test("rejects live-sales dedicated org", () => {
  const result = classifyCanaryPreflight({
    dedicatedOrgId: LIVE_SALES_ORG_ID,
    dedicatedIntegration: connectedEligibleIntegration(),
  });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /live sales org/i);
});

test("reports BLOCKED when dedicated integration is absent", () => {
  const result = classifyCanaryPreflight({
    dedicatedOrgId: "11111111-1111-1111-1111-111111111111",
    dedicatedIntegration: null,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "dedicated org is not connected");
});

test("reports READY when dedicated integration is present and eligible", () => {
  const result = classifyCanaryPreflight({
    dedicatedOrgId: "11111111-1111-1111-1111-111111111111",
    dedicatedIntegration: connectedEligibleIntegration(),
  });
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "dedicated integration is connected and eligible");
});

test("reports BLOCKED when settings read is unavailable", () => {
  const result = classifyCanaryPreflight({
    dedicatedOrgId: "11111111-1111-1111-1111-111111111111",
    dedicatedIntegration: null,
    integrationReadUnavailable: true,
  });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /settings are unavailable/i);
});

test("does not create a client for the live sales org", async () => {
  const { runPreflight } = await import("./canary-esign-preflight.mjs");
  const result = await runPreflight({ dedicatedOrgId: LIVE_SALES_ORG_ID, createClientFn: () => { throw new Error("client must not be created"); } });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /live sales org/i);
});

test("rejects disconnected integration", () => {
  const result = classifyCanaryPreflight({ dedicatedOrgId: "11111111-1111-1111-1111-111111111111", dedicatedIntegration: { ...connectedEligibleIntegration(), api_key_last_four: "" } });
  assert.equal(result.status, "BLOCKED");
});

// ensure we only request allowed non-secret columns from org_esign_integrations

test("request set is non-secret org_esign_integrations columns only", () => {
  assert.deepEqual(READ_ONLY_ORG_ESIGN_COLUMNS, ["org_id", "provider", "api_key_last_four", "sending_enabled", "test_mode", "disconnect_pending_at"]);
});
