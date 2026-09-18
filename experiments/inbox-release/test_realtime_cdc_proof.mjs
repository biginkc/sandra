#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_API_URL,
  FIXTURE_CONTAINER_MARKER,
  FIXTURE_DATABASE_MARKER,
  FIXTURE_DATABASE_PURPOSE,
  FIXTURE_DATABASE_URL,
  assertFixtureEnvironment,
  readCdcScenario,
} from "./realtime-cdc-proof.mjs";

const scenario = {
  INBOX_HTTP_CDC_ORG_ID: "11111111-1111-4111-8111-111111111111",
  INBOX_HTTP_CDC_CONVERSATION_ID: "22222222-2222-4222-8222-222222222222",
  INBOX_HTTP_CDC_CONTACT_ID: "33333333-3333-4333-8333-333333333333",
  INBOX_HTTP_CDC_PROPERTY_ID: "44444444-4444-4444-8444-444444444444",
  INBOX_HTTP_CDC_FROM_ADDRESS: "+18165557301",
  INBOX_HTTP_CDC_TO_ADDRESS: "+18162804181",
};

function validEnvironment(overrides = {}) {
  return {
    INBOX_RELEASE_TARGET_PROBED: "true",
    INBOX_RELEASE_TARGET_CONTAINER_MARKER: FIXTURE_CONTAINER_MARKER,
    INBOX_RELEASE_TARGET_DATABASE_MARKER: FIXTURE_DATABASE_MARKER,
    INBOX_RELEASE_TARGET_DATABASE_PURPOSE: FIXTURE_DATABASE_PURPOSE,
    INBOX_NO_PROVIDER: "1",
    INBOX_RELEASE_PROVIDER_TRAFFIC: "false",
    INBOX_RELEASE_CUSTOMER_SENDS: "false",
    INBOX_RELEASE_FIXTURE_API_URL: FIXTURE_API_URL,
    INBOX_RELEASE_DATABASE_URL: FIXTURE_DATABASE_URL,
    INBOX_HTTP_ANON_KEY: "anon-test-key",
    INBOX_RELEASE_SERVICE_ROLE_KEY: "service-test-key",
    INBOX_HTTP_USER_EMAIL: "acceptance@example.test",
    INBOX_HTTP_USER_PASSWORD: "password-not-used-by-this-unit-test",
    ...scenario,
    ...overrides,
  };
}

test("fixture guard requires the exact loopback and independent identity markers", () => {
  const result = assertFixtureEnvironment(validEnvironment());
  assert.equal(result.apiUrl, FIXTURE_API_URL);
  assert.equal(result.databaseUrl, FIXTURE_DATABASE_URL);
  assert.throws(
    () => assertFixtureEnvironment(validEnvironment({ INBOX_RELEASE_FIXTURE_API_URL: "http://127.0.0.1:58421" })),
    /exact owned loopback endpoint/,
  );
  assert.throws(
    () => assertFixtureEnvironment(validEnvironment({ INBOX_RELEASE_TARGET_DATABASE_MARKER: FIXTURE_CONTAINER_MARKER })),
    /database marker mismatch/,
  );
});

test("fixture guard refuses provider traffic and privileged subscription fallbacks", () => {
  assert.throws(
    () => assertFixtureEnvironment(validEnvironment({ INBOX_RELEASE_PROVIDER_TRAFFIC: "true" })),
    /provider traffic must remain false/,
  );
  assert.throws(
    () => assertFixtureEnvironment(validEnvironment({ INBOX_HTTP_ANON_KEY: undefined })),
    /INBOX_HTTP_ANON_KEY is required/,
  );
});

test("CDC scenario requires explicit pre-seeded tenant identities", () => {
  const parsed = readCdcScenario(validEnvironment());
  assert.equal(parsed.orgId, scenario.INBOX_HTTP_CDC_ORG_ID);
  assert.throws(
    () => readCdcScenario(validEnvironment({ INBOX_HTTP_CDC_CONVERSATION_ID: undefined })),
    /INBOX_HTTP_CDC_CONVERSATION_ID is required/,
  );
  assert.throws(
    () => readCdcScenario(validEnvironment({ INBOX_HTTP_CDC_FROM_ADDRESS: undefined })),
    /INBOX_HTTP_CDC_FROM_ADDRESS is required/,
  );
});
