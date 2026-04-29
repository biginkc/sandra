import { createHash } from "node:crypto";

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

const ENZO_SECRET = "enzo-test-secret-1234567890abcdef";
const PPC_SECRET = "ppc-test-secret-abcdef1234567890";

function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

async function seedConsumer(opts: {
  name: string;
  secret: string;
  defaultSource: string;
  enabled?: boolean;
  revoked?: boolean;
}): Promise<string> {
  const { data, error } = await testClient
    .from("webhook_consumers")
    .insert({
      name: opts.name,
      secret_hash: hashSecret(opts.secret),
      default_source: opts.defaultSource,
      enabled: opts.enabled ?? true,
      revoked_at: opts.revoked ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed consumer failed");
  return data.id;
}

async function clearConsumers(): Promise<void> {
  await testClient.from("webhook_consumers").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

function makeRequest(body: unknown, secret: string): Request {
  return new Request(`http://localhost/api/webhooks/leads/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeContext(secret: string) {
  return { params: Promise.resolve({ secret }) };
}

describe("POST /api/webhooks/leads/[secret] (per-consumer auth)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    await clearConsumers();
  });

  it("happy path: matched consumer creates property with row's default_source applied", async () => {
    await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    const request = makeRequest(
      {
        property: {
          address: "1 Per-Consumer Ln",
          city: "Kansas City",
          state: "MO",
          zip: "64111",
        },
        contact: {
          first_name: "Enzo",
          last_name: "Caller",
          phone_1: "+18165552001",
        },
        // No `source` field — should fall back to consumer.default_source
      },
      ENZO_SECRET,
    );
    const response = await POST(request, makeContext(ENZO_SECRET));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { property_id: string };

    const { data: prop } = await testClient
      .from("properties")
      .select("source")
      .eq("id", json.property_id)
      .single();
    expect(prop!.source).toBe("cold_call");
  });

  it("payload source overrides consumer default when present and valid", async () => {
    await seedConsumer({
      name: "Generic",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    const request = makeRequest(
      {
        source: "web_form", // override
        property: { address: "2 Override Ln", state: "MO" },
      },
      ENZO_SECRET,
    );
    const response = await POST(request, makeContext(ENZO_SECRET));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { property_id: string };
    const { data: prop } = await testClient
      .from("properties")
      .select("source")
      .eq("id", json.property_id)
      .single();
    expect(prop!.source).toBe("web_form");
  });

  it("rejects with 403 when secret matches no consumer", async () => {
    await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    const wrong = "wrong-secret-1234567890abcdef";
    const response = await POST(
      makeRequest({ property: { address: "3 Wrong Ln", state: "MO" } }, wrong),
      makeContext(wrong),
    );
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when consumer is disabled", async () => {
    await seedConsumer({
      name: "Disabled",
      secret: PPC_SECRET,
      defaultSource: "web_form",
      enabled: false,
    });

    const response = await POST(
      makeRequest({ property: { address: "4 Disabled Ln", state: "MO" } }, PPC_SECRET),
      makeContext(PPC_SECRET),
    );
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when consumer is revoked", async () => {
    await seedConsumer({
      name: "Revoked",
      secret: PPC_SECRET,
      defaultSource: "web_form",
      revoked: true,
    });

    const response = await POST(
      makeRequest({ property: { address: "5 Revoked Ln", state: "MO" } }, PPC_SECRET),
      makeContext(PPC_SECRET),
    );
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when secret is too short (defensive)", async () => {
    const response = await POST(
      makeRequest({ property: { address: "6 Short Ln", state: "MO" } }, "short"),
      makeContext("short"),
    );
    expect(response.status).toBe(403);
  });

  it("two consumers with different secrets coexist — each maps to its own default_source", async () => {
    await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });
    await seedConsumer({
      name: "PPC Landing",
      secret: PPC_SECRET,
      defaultSource: "web_form",
    });

    const enzoResp = await POST(
      makeRequest({ property: { address: "10 Enzo Ln", state: "MO" } }, ENZO_SECRET),
      makeContext(ENZO_SECRET),
    );
    const enzoJson = (await enzoResp.json()) as { property_id: string };

    const ppcResp = await POST(
      makeRequest({ property: { address: "20 PPC Ln", state: "MO" } }, PPC_SECRET),
      makeContext(PPC_SECRET),
    );
    const ppcJson = (await ppcResp.json()) as { property_id: string };

    const { data: enzoProp } = await testClient
      .from("properties")
      .select("source")
      .eq("id", enzoJson.property_id)
      .single();
    const { data: ppcProp } = await testClient
      .from("properties")
      .select("source")
      .eq("id", ppcJson.property_id)
      .single();

    expect(enzoProp!.source).toBe("cold_call");
    expect(ppcProp!.source).toBe("web_form");
  });

  it("stamps last_used_at on the consumer row after a successful call", async () => {
    const consumerId = await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    await POST(
      makeRequest({ property: { address: "30 Stamp Ln", state: "MO" } }, ENZO_SECRET),
      makeContext(ENZO_SECRET),
    );

    const { data: consumer } = await testClient
      .from("webhook_consumers")
      .select("last_used_at")
      .eq("id", consumerId)
      .single();
    expect(consumer!.last_used_at).not.toBeNull();
  });

  it("rejects with 400 when payload source is present but invalid", async () => {
    await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    const response = await POST(
      makeRequest(
        {
          source: "manual_entry", // not in canonical list
          property: { address: "40 Bad Source Ln", state: "MO" },
        },
        ENZO_SECRET,
      ),
      makeContext(ENZO_SECRET),
    );
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    const response = await POST(makeRequest("not json {{{", ENZO_SECRET), makeContext(ENZO_SECRET));
    expect(response.status).toBe(400);
  });

  it("rejects payload missing property block with 400", async () => {
    await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    const response = await POST(makeRequest({}, ENZO_SECRET), makeContext(ENZO_SECRET));
    expect(response.status).toBe(400);
  });

  it("idempotent on address: second call returns same property_id with was_duplicate=true", async () => {
    await seedConsumer({
      name: "Enzo",
      secret: ENZO_SECRET,
      defaultSource: "cold_call",
    });

    const first = await POST(
      makeRequest({ property: { address: "100 Dedup St", state: "MO" } }, ENZO_SECRET),
      makeContext(ENZO_SECRET),
    );
    const firstJson = (await first.json()) as { property_id: string };

    const second = await POST(
      makeRequest({ property: { address: "100 Dedup St", state: "MO" } }, ENZO_SECRET),
      makeContext(ENZO_SECRET),
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
