import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { DialpadVoiceDatabase } from "./database.generated";
import { createVoiceEventWorkerStore } from "./event-worker-store";
import { normalizeDialpadCallEvent } from "./call-event";

describe("event worker PostgREST boundaries", () => {
  it("backfills a late intent without resetting stored recording state", async () => {
    const writes: { url: URL; method: string; body: unknown }[] = [];
    const client = createClient<DialpadVoiceDatabase>("https://example.test", "fixture-key", {
      auth: { persistSession: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        writes.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(url.pathname.endsWith("dialpad_voice_intents") ? JSON.stringify({ id: "verified-intent" }) : "", {
          status: url.pathname.endsWith("dialpad_voice_intents") ? 200 : 201,
          headers: { "Content-Type": "application/json" },
        });
      } },
    });
    const store = createVoiceEventWorkerStore(client, "org");
    const event = normalizeDialpadCallEvent({ call_id: "123", state: "recording", event_timestamp: 1700000000000,
      recording_details: [{ id: "segment", recording_type: "admincallrecording" }] });
    await store.enqueueRecordings({ id: "receipt", orgId: "org", leaseToken: "lease", attemptCount: 1, payload: {} }, event);
    const backfill = writes.find((w) => w.method === "PATCH");
    expect(backfill?.body).toEqual({ intent_id: "verified-intent" });
    expect(backfill?.url.searchParams.get("org_id")).toBe("eq.org");
    expect(backfill?.url.searchParams.get("provider_call_id")).toBe("eq.123");
    expect(backfill?.url.searchParams.get("intent_id")).toBe("is.null");
  });
  it("fences completion by tenant, receipt and lease", async () => {
    let query: URL | undefined;
    const client = createClient<DialpadVoiceDatabase>("https://example.test", "fixture-key", {
      auth: { persistSession: false },
      global: { fetch: async (input) => {
        query = new URL(String(input));
        return Response.json([]);
      } },
    });
    const store = createVoiceEventWorkerStore(client, "org");
    expect(await store.finish({ id: "receipt", orgId: "org", leaseToken: "old-lease", attemptCount: 1, payload: {} }, {
      status: "processed", errorCode: null, retryAt: null,
    })).toBe(false);
    expect(query?.searchParams.get("org_id")).toBe("eq.org");
    expect(query?.searchParams.get("id")).toBe("eq.receipt");
    expect(query?.searchParams.get("lease_token")).toBe("eq.old-lease");
    expect(query?.searchParams.get("status")).toBe("eq.processing");
  });
});
