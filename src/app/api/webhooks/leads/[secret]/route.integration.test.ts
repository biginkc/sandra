import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// Point the route's `createSupabaseClient(...)` call at the test
// project by setting the same env vars it reads. Cleaner than mocking
// the supabase-js module — that path recurses because our test client
// itself uses createClient under the hood.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

import { POST } from "./route";

const testClient = createTestClient();

const SECRET = "test-secret";

function makeRequest(
  body: unknown,
  options: { secret?: string } = {},
): Request {
  return new Request(
    `http://localhost/api/webhooks/leads/${options.secret ?? SECRET}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

function makeContext(secret = SECRET) {
  return { params: Promise.resolve({ secret }) };
}

describe("POST /api/webhooks/leads/[secret]", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    process.env.LEAD_WEBHOOK_SECRET = SECRET;
  });

  it("happy path: valid payload creates property + contact, returns 200 with property_id", async () => {
    const request = makeRequest({
      source: "cold_call",
      property: {
        address: "1 Webhook Ln",
        city: "Kansas City",
        state: "MO",
        zip: "64111",
      },
      contact: {
        first_name: "Webhook",
        last_name: "Caller",
        phone_1: "+18165551111",
      },
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      property_id: string;
      was_duplicate: boolean;
      contact_id: string | null;
    };
    expect(json.property_id).toBeTruthy();
    expect(json.was_duplicate).toBe(false);
    expect(json.contact_id).toBeTruthy();

    const { data: prop } = await testClient
      .from("properties")
      .select("status, source, homeowner_contact_id")
      .eq("id", json.property_id)
      .single();
    expect(prop!.status).toBe("new_lead");
    expect(prop!.source).toBe("cold_call");
    expect(prop!.homeowner_contact_id).toBe(json.contact_id);
  });

  it("rejects wrong secret with 403", async () => {
    const request = makeRequest(
      {
        source: "cold_call",
        property: { address: "2 Wrong Secret Ln", state: "MO" },
      },
      { secret: "wrong-secret" },
    );
    const response = await POST(request, makeContext("wrong-secret"));
    expect(response.status).toBe(403);
  });

  it("rejects with 503 when LEAD_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.LEAD_WEBHOOK_SECRET;
    const request = makeRequest({
      source: "cold_call",
      property: { address: "3 Unconfigured Ln", state: "MO" },
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(503);
  });

  it("rejects malformed JSON with 400", async () => {
    const request = makeRequest("not json {{{");
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("rejects payload without source with 400", async () => {
    const request = makeRequest({
      property: { address: "4 No Source Ln", state: "MO" },
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: string; field: string };
    expect(json.field).toBe("source");
  });

  it("rejects payload with invalid source value with 400", async () => {
    const request = makeRequest({
      source: "manual_entry", // not in canonical list as of migration 030
      property: { address: "5 Bad Source Ln", state: "MO" },
    });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("rejects payload missing property block with 400", async () => {
    const request = makeRequest({ source: "cold_call" });
    const response = await POST(request, makeContext());
    expect(response.status).toBe(400);
  });

  it("idempotent on address: second call returns same property_id with was_duplicate=true", async () => {
    const first = await POST(
      makeRequest({
        source: "cold_call",
        property: { address: "100 Dedup Webhook St", state: "MO" },
      }),
      makeContext(),
    );
    const firstJson = (await first.json()) as { property_id: string };

    const second = await POST(
      makeRequest({
        source: "web_form",
        property: { address: "100 Dedup Webhook St", state: "MO" },
      }),
      makeContext(),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      property_id: string;
      was_duplicate: boolean;
    };
    expect(secondJson.property_id).toBe(firstJson.property_id);
    expect(secondJson.was_duplicate).toBe(true);
  });
});
