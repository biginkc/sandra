import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { POST } from "./route";

// The route's `createServiceRoleClient()` reads NEXT_PUBLIC_SUPABASE_URL
// + SUPABASE_SERVICE_ROLE_KEY. In integration we point them at the test
// project's values (same pattern as the Dialpad webhook integration test).

const supabase = createTestClient();
const AUTH_TOKEN = "integration_test_twilio_token";
const FULL_URL = "https://example.test/api/webhooks/test-receiver";

function signTwilio(form: Record<string, string>): string {
  const sorted = Object.keys(form).sort();
  let canonical = FULL_URL;
  for (const k of sorted) canonical += k + form[k];
  return crypto.createHmac("sha1", AUTH_TOKEN).update(canonical).digest("base64");
}

function makeRequest(
  form: Record<string, string>,
  opts: { signature?: string | null } = {},
): Request {
  const sig = opts.signature === undefined ? signTwilio(form) : opts.signature;
  return new Request(FULL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "host": "example.test",
      ...(sig ? { "x-twilio-signature": sig } : {}),
    },
    body: new URLSearchParams(form).toString(),
  });
}

describe("POST /api/webhooks/test-receiver (integration)", () => {
  let savedAuthToken: string | undefined;
  let savedSupabaseUrl: string | undefined;
  let savedServiceKey: string | undefined;

  beforeEach(async () => {
    savedAuthToken = process.env.TWILIO_AUTH_TOKEN;
    savedSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    savedServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await resetTenantTables(supabase);
  });

  afterEach(() => {
    process.env.TWILIO_AUTH_TOKEN = savedAuthToken;
    process.env.NEXT_PUBLIC_SUPABASE_URL = savedSupabaseUrl;
    if (savedServiceKey !== undefined) {
      process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceKey;
    }
  });

  it("returns 503 when TWILIO_AUTH_TOKEN is unset", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await POST(
      makeRequest({
        MessageSid: "SM_off",
        From: "+18163706846",
        To: "+15558675309",
        Body: "hi",
      }),
    );
    expect(res.status).toBe(503);
  });

  it("returns 401 when X-Twilio-Signature is missing", async () => {
    const res = await POST(
      makeRequest(
        {
          MessageSid: "SM_nosig",
          From: "+18163706846",
          To: "+15558675309",
          Body: "hi",
        },
        { signature: null },
      ),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is tampered", async () => {
    const res = await POST(
      makeRequest(
        {
          MessageSid: "SM_bad",
          From: "+18163706846",
          To: "+15558675309",
          Body: "hi",
        },
        { signature: "bogus/base64==" },
      ),
    );
    expect(res.status).toBe(401);
  });

  it("persists a correctly-signed inbound to test_sms_log", async () => {
    const form = {
      MessageSid: "SM_happy_001",
      From: "+18163706846",
      To: "+15558675309",
      Body: "E2E delivery probe",
      AccountSid: "AC_abc",
    };
    const res = await POST(makeRequest(form));
    expect(res.status).toBe(200);

    const { data } = await supabase
      .from("test_sms_log")
      .select("provider, external_id, from_number, to_number, body, signature_verified")
      .eq("external_id", "SM_happy_001");
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      provider: "twilio",
      from_number: "+18163706846",
      to_number: "+15558675309",
      body: "E2E delivery probe",
      signature_verified: true,
    });
  });

  it("is idempotent on Twilio retries — same MessageSid stays at one row", async () => {
    const form = {
      MessageSid: "SM_retry_001",
      From: "+18163706846",
      To: "+15558675309",
      Body: "first attempt",
    };
    const r1 = await POST(makeRequest(form));
    expect(r1.status).toBe(200);
    const r2 = await POST(makeRequest(form));
    expect(r2.status).toBe(200);

    const { count } = await supabase
      .from("test_sms_log")
      .select("*", { count: "exact", head: true })
      .eq("external_id", "SM_retry_001");
    expect(count).toBe(1);
  });

  it("returns 400 on a payload missing required Twilio fields", async () => {
    const form = {
      MessageSid: "SM_bad_payload",
      From: "+18163706846",
      // To: missing
      Body: "hi",
    };
    const res = await POST(makeRequest(form));
    expect(res.status).toBe(400);
  });
});
