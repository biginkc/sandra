import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// Point the route's `createSupabaseClient(...)` call at the test
// project. Same pattern as the lead-intake webhook test — set the env
// vars the route reads instead of mocking the supabase-js module
// (mocking would recurse, since createTestClient itself uses
// createClient under the hood).
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.TEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

// finalizeSkipTraceFromBatch hits the runner — mock it out so these
// tests focus on the auth surface + queue_id matching behaviour. The
// runner has its own integration tests in
// src/lib/skip-trace/skip-trace-job.integration.test.ts.
vi.mock("@/lib/skip-trace/skip-trace-job", () => ({
  finalizeSkipTraceFromBatch: vi.fn(async () => undefined),
}));

import { POST } from "./route";

const testClient = createTestClient();

const PROVIDER_SECRET = "skip-trace-provider-secret-1234567890ab";
const LEAD_SECRET = "lead-consumer-secret-abcdef1234567890ab";

function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

async function seedConsumer(opts: {
  name: string;
  secret: string;
  consumerType: "lead" | "provider";
  defaultSource?: string | null;
  enabled?: boolean;
  revoked?: boolean;
}): Promise<string> {
  const { data, error } = await testClient
    .from("webhook_consumers")
    .insert({
      name: opts.name,
      secret_hash: hashSecret(opts.secret),
      consumer_type: opts.consumerType,
      default_source:
        opts.consumerType === "provider"
          ? null
          : opts.defaultSource ?? "cold_call",
      enabled: opts.enabled ?? true,
      revoked_at: opts.revoked ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seed consumer failed");
  return data.id;
}

async function clearConsumers(): Promise<void> {
  await testClient
    .from("webhook_consumers")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
}

async function seedRunningSkipTraceJob(queueId: string): Promise<string> {
  const { data: org } = await testClient
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  const { data: job, error } = await testClient
    .from("jobs")
    .insert({
      type: "skip_trace",
      provider: "tracerfy",
      status: "running",
      org_id: org!.id,
      provider_run_id: queueId,
      total_items: 0,
      title: "Test skip-trace job",
    })
    .select("id")
    .single();
  if (error || !job) throw error ?? new Error("seed job failed");
  return job.id;
}

function makeRequest(body: unknown, secret: string): Request {
  return new Request(`http://localhost/api/webhooks/skip-trace/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeContext(secret: string) {
  return { params: Promise.resolve({ secret }) };
}

describe("POST /api/webhooks/skip-trace/[secret] (per-consumer auth)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    await clearConsumers();
  });

  it("happy path: provider consumer + matching queue_id finalizes the job and stamps last_used_at", async () => {
    const consumerId = await seedConsumer({
      name: "Tracerfy",
      secret: PROVIDER_SECRET,
      consumerType: "provider",
    });
    await seedRunningSkipTraceJob("queue-12345");

    const response = await POST(
      makeRequest(
        {
          queue_id: "queue-12345",
          rows: [
            {
              external_id: "",
              queue_id: "queue-12345",
              hit: true,
              persons_count: 1,
              credits_deducted: 1,
              address: "1 Test St",
              city: "Kansas City",
              state: "MO",
              persons: [
                {
                  first_name: "Test",
                  last_name: "Owner",
                  property_owner: true,
                  phones: [
                    {
                      number: "+18165550100",
                      type: "Mobile",
                      dnc: false,
                      rank: 1,
                    },
                  ],
                  emails: [],
                },
              ],
            },
          ],
        },
        PROVIDER_SECRET,
      ),
      makeContext(PROVIDER_SECRET),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { ok: boolean; rows: number };
    expect(json.ok).toBe(true);
    expect(json.rows).toBe(1);

    // last_used_at stamped.
    const { data: consumer } = await testClient
      .from("webhook_consumers")
      .select("last_used_at")
      .eq("id", consumerId)
      .single();
    expect(consumer!.last_used_at).not.toBeNull();
  });

  it("cross-protection: rejects with 403 when secret belongs to a lead-type consumer", async () => {
    // Seed a lead-shaped consumer. Its hash exists, but consumer_type
    // filter on the route blocks it from authenticating here.
    await seedConsumer({
      name: "Enzo Dialer",
      secret: LEAD_SECRET,
      consumerType: "lead",
      defaultSource: "cold_call",
    });

    const response = await POST(
      makeRequest({ queue_id: "x", rows: [] }, LEAD_SECRET),
      makeContext(LEAD_SECRET),
    );
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when secret matches no consumer", async () => {
    const wrong = "this-secret-is-not-in-the-table-1234567890";
    const response = await POST(
      makeRequest({ queue_id: "x", rows: [] }, wrong),
      makeContext(wrong),
    );
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when provider consumer is disabled", async () => {
    await seedConsumer({
      name: "Tracerfy",
      secret: PROVIDER_SECRET,
      consumerType: "provider",
      enabled: false,
    });
    const response = await POST(
      makeRequest({ queue_id: "x", rows: [] }, PROVIDER_SECRET),
      makeContext(PROVIDER_SECRET),
    );
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when provider consumer is revoked", async () => {
    await seedConsumer({
      name: "Tracerfy",
      secret: PROVIDER_SECRET,
      consumerType: "provider",
      revoked: true,
    });
    const response = await POST(
      makeRequest({ queue_id: "x", rows: [] }, PROVIDER_SECRET),
      makeContext(PROVIDER_SECRET),
    );
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when secret is too short (defensive)", async () => {
    const response = await POST(
      makeRequest({ queue_id: "x", rows: [] }, "short"),
      makeContext("short"),
    );
    expect(response.status).toBe(403);
  });

  it("acknowledges (200, ignored) when payload has no queue_id — live Tracerfy webhooks omit it; the cron poll path finalizes instead", async () => {
    await seedConsumer({
      name: "Tracerfy",
      secret: PROVIDER_SECRET,
      consumerType: "provider",
    });
    const response = await POST(
      makeRequest({ rows: [] }, PROVIDER_SECRET),
      makeContext(PROVIDER_SECRET),
    );
    // 400 would make Tracerfy retry a payload we can never map; 200
    // stops the retry loop and defers to the sweep cron.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ignored).toBeTruthy();
  });

  it("returns 200 with ignored body when queue_id matches no job (defensive — provider firing for a queue we don't track)", async () => {
    await seedConsumer({
      name: "Tracerfy",
      secret: PROVIDER_SECRET,
      consumerType: "provider",
    });
    const response = await POST(
      makeRequest(
        { queue_id: "queue-not-ours", rows: [] },
        PROVIDER_SECRET,
      ),
      makeContext(PROVIDER_SECRET),
    );
    // 200 (not 4xx) so the provider doesn't retry — it's not our work.
    expect(response.status).toBe(200);
    const json = (await response.json()) as { ignored?: string };
    expect(json.ignored).toMatch(/unknown queue_id/i);
  });

  it("returns 200 with ignored body when matching job is already terminal (duplicate webhook delivery)", async () => {
    await seedConsumer({
      name: "Tracerfy",
      secret: PROVIDER_SECRET,
      consumerType: "provider",
    });
    // Seed a completed job — finalize already happened (cron poll
    // beat the webhook, or this is a duplicate delivery).
    const { data: org } = await testClient
      .from("organizations")
      .select("id")
      .limit(1)
      .single();
    await testClient.from("jobs").insert({
      type: "skip_trace",
      provider: "tracerfy",
      status: "completed",
      org_id: org!.id,
      provider_run_id: "queue-already-done",
      total_items: 0,
      title: "Already-finalized job",
    });

    const response = await POST(
      makeRequest(
        { queue_id: "queue-already-done", rows: [] },
        PROVIDER_SECRET,
      ),
      makeContext(PROVIDER_SECRET),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { ignored?: string };
    expect(json.ignored).toMatch(/completed/);
  });
});
