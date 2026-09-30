import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const authMocks = vi.hoisted(() => ({
  getCallerMembershipsOrThrow: vi.fn(),
  getCallerMemberships: vi.fn(),
}));

vi.mock("@/lib/auth/memberships", () => authMocks);

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// Replace the real server-side supabase factory with our test client so
// the action's internal `createClient()` call returns the service-role
// client pointed at sandra-crm-test. `vi.mock` is hoisted, so the import
// sequence below works even though `testClient` is defined later.
const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

import {
  qualifyLeadsBulk,
  sendSmsFromLead,
  updatePropertyStatus,
} from "@/app/(dashboard)/leads/actions";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";

type CaptureSnapshot = {
  dirty: Array<Record<string, unknown>>;
  routeEdges: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
};

function normalizeCaptureSnapshot(snapshot: CaptureSnapshot): CaptureSnapshot {
  const normalizeRows = (rows: Array<Record<string, unknown>>) =>
    rows
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            key === "generation" ||
            key === "revision"
              ? "<trigger-sequence>"
              : key === "org_id" ||
            key === "target_id" ||
            key === "message_id" ||
            key === "conversation_id"
              ? "<id>"
              : key.endsWith("_at")
                ? "<timestamp>"
                : value,
          ]),
        ),
      )
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    dirty: normalizeRows(snapshot.dirty),
    routeEdges: normalizeRows(snapshot.routeEdges),
    versions: normalizeRows(snapshot.versions),
  };
}

describe("updatePropertyStatus (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    resetMockState();
    const membership = {
      org_id: "00000000-0000-0000-0000-000000000001",
      role: "owner",
      acquisitions_enabled: false,
    };
    authMocks.getCallerMembershipsOrThrow.mockResolvedValue([membership]);
    authMocks.getCallerMemberships.mockResolvedValue([membership]);
  });

  async function seedProperty(status = "new_lead"): Promise<string> {
    const { data, error } = await testClient
      .from("properties")
      .insert({ address: "1 Test St", state: "MO", status })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("seed failed");
    return data.id;
  }

  async function seedSmsLead(phone = "+18165550123"): Promise<{ propertyId: string; contactId: string }> {
    const { data: contact, error: contactError } = await testClient
      .from("contacts")
      .insert({ first_name: "Parity", phone_1: phone, phone_1_type: "mobile" })
      .select("id")
      .single();
    if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
    const { data: property, error: propertyError } = await testClient
      .from("properties")
      .insert({ address: "1 Parity Ln", state: "MO", homeowner_contact_id: contact.id })
      .select("id")
      .single();
    if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
    await testClient.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "actions-integration",
    });
    return { propertyId: property.id, contactId: contact.id };
  }

  it("T23 uses the real sendSmsFromLead path for pending and accepted default-sender stages", async () => {
    const { error: accessSeedError } = await testClient.from("memberships").upsert({
      user_id: "00000000-0000-0000-0000-000000000001",
      org_id: "00000000-0000-0000-0000-000000000bbb",
      role: "owner",
      access_status: "active",
    });
    if (accessSeedError) throw accessSeedError;
    const customerPhone = `+1816555${Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 7), 16).toString().padStart(7, "0").slice(-7)}`;
    const { propertyId, contactId } = await seedSmsLead(customerPhone);
    const orgId = "00000000-0000-0000-0000-000000000bbb";
    const businessPhone = `+120255${Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 4), 16).toString().padStart(4, "0")}`;
    const testInputHash = `t23-integration-${randomUUID()}`;
    const { error: senderSeedError } = await testClient
      .from("provider_sender_numbers")
      .upsert({
        org_id: orgId,
        provider: "mock",
        phone_e164: businessPhone,
        status: "active",
        last_synced_at: new Date().toISOString(),
    }, { onConflict: "org_id,provider,phone_e164" });
    if (senderSeedError) throw senderSeedError;
    const dbUrl = process.env.TEST_SUPABASE_DB_URL;
    if (!dbUrl) throw new Error("TEST_SUPABASE_DB_URL is required for trigger parity");
    const db = new Client({ connectionString: dbUrl });
    await db.connect();
    try {
      await db.query(`
        create schema if not exists inbox_reply_test;
        drop trigger if exists zzzzzzzzzz_t23_capture on public.messages;
        drop function if exists inbox_reply_test.capture_t23_messages();
        drop table if exists inbox_reply_test.t23_message_capture;
        create table inbox_reply_test.t23_message_capture(
          message_id uuid not null,
          metadata jsonb not null,
          status text not null,
          snapshot jsonb not null,
          captured_at timestamptz not null default clock_timestamp()
        );
        create function inbox_reply_test.capture_t23_messages() returns trigger
        language plpgsql security definer set search_path = '' as $$
        begin
          if new.channel <> 'sms' or new.direction <> 'outbound'
             or new.status not in ('pending', 'sent') then
            return new;
          end if;
          insert into inbox_reply_test.t23_message_capture(message_id, metadata, status, snapshot)
          values (
            new.id,
            new.metadata,
            new.status,
            jsonb_build_object(
              'dirty', coalesce((select jsonb_agg(to_jsonb(d) order by d.target_kind, d.target_id)
                from inbox_message_capture.dirty d
                where d.org_id = new.org_id and d.target_id = new.conversation_id), '[]'::jsonb),
              'routeEdges', coalesce((select jsonb_agg(to_jsonb(e) order by e.message_id)
                from inbox_message_capture.route_edges e
                where e.org_id = new.org_id and e.message_id = new.id), '[]'::jsonb),
              'versions', coalesce((select jsonb_agg(to_jsonb(v) order by v.namespace, v.target_id)
                from inbox_message_capture.versions v
                where v.org_id = new.org_id and v.target_id in (new.id, new.conversation_id)), '[]'::jsonb)
            )
          );
          return new;
        end;
        $$;
        create trigger zzzzzzzzzz_t23_capture after insert or update of status on public.messages
        for each row execute function inbox_reply_test.capture_t23_messages();
      `);
      const sendResult = await sendSmsFromLead(
        propertyId,
        "  Hi, this is Mel with BMH — parity body  ",
        businessPhone,
        false,
        null,
      );
      expect(sendResult.ok).toBe(true);
      if (!sendResult.ok) throw new Error("legacy parity send failed");
      expect(sendResult.data.outcome.status).toBe("sent");
      expect(getMockMessageLog()).toHaveLength(1);
      const legacyCaptures = await db.query<{ message_id: string; metadata: Record<string, unknown>; status: string; snapshot: Record<string, unknown> }>(
        `select message_id, metadata, status, snapshot
         from inbox_reply_test.t23_message_capture
         order by captured_at`,
      );
      const legacyPending = legacyCaptures.rows.find((row) => row.status === "pending");
      const legacyAccepted = legacyCaptures.rows.filter((row) => row.status === "sent").at(-1);
      expect(legacyPending).toBeDefined();
      expect(legacyAccepted).toBeDefined();
      expect(Object.keys(legacyPending?.metadata ?? {}).sort()).toEqual([
        "providerAttempt",
      ]);
      const { data: sent } = await testClient
        .from("messages")
        .select("id, status, provider, body, contact_id, property_id, conversation_id, from_address, to_address, external_id, sent_at, metadata")
        .eq("id", legacyAccepted!.message_id)
        .single();
      expect(sent).toMatchObject({
        status: "sent",
        provider: "mock",
        body: "Hi, this is Mel with BMH — parity body",
        contact_id: contactId,
        property_id: propertyId,
      });
      expect(sent?.external_id).toMatch(/^mock_/);
      expect(Object.keys((sent?.metadata ?? {}) as Record<string, unknown>).sort()).toEqual([
        "providerStatus",
        "raw",
      ]);
      if (!sent?.id || !sent.conversation_id || !sent.from_address || !sent.to_address) {
        throw new Error("legacy parity row is missing trigger identity columns");
      }
      const replyAttemptId = randomUUID();
      const replyOperationId = randomUUID();
      const replyPreparationId = randomUUID();
      const replyItemId = randomUUID();
      const replyConversationId = randomUUID();
      const replyDispatchToken = randomUUID();
      const replyItem = {
        id: replyItemId,
        target: { kind: "conversation", id: replyConversationId },
        recipient: {
          contactId,
          from: sent.from_address,
          to: sent.to_address,
          propertyId,
          renderedBody: sent.body,
        },
        validUntil: "2999-01-01T00:00:00Z",
        state: "MO",
        dependencies: { head: 1 },
      };
      await db.query(
        `insert into inbox_reply_review.preparations
          (id, org_id, requester_id, request_key, input_hash, canonical_input, items, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          replyPreparationId,
          orgId,
          contactId,
          randomUUID(),
          testInputHash,
          "{}",
          JSON.stringify([replyItem]),
          "2999-01-01T00:00:00Z",
        ],
      );
      await db.query(
        `insert into inbox_reply_send.operations
          (org_id, id, requester_id, preparation_id, idempotency_key)
         values ($1, $2, $3, $4, $5)`,
        [orgId, replyOperationId, contactId, replyPreparationId, randomUUID()],
      );
      await db.query(
        `insert into inbox_reply_send.attempts
          (org_id, id, operation_id, preparation_id, item_id, attempt_ordinal,
           contact_id, from_e164, to_e164, body_hash, state)
         values ($1, $2, $3, $4, $5, 1, $6, $7, $8,
           inbox_reply_send.body_hash($9, $7, $8), 'approved')`,
        [
          orgId,
          replyAttemptId,
          replyOperationId,
          replyPreparationId,
          replyItemId,
          contactId,
          sent.from_address,
          sent.to_address,
          sent.body,
        ],
      );
      await db.query(
        `update inbox_reply_send.attempts
         set state = 'claimed', generation = 1, lease_until = clock_timestamp() + interval '1 minute'
         where org_id = $1 and id = $2`,
        [orgId, replyAttemptId],
      );
      await db.query(
        `update inbox_reply_send.attempts
         set state = 'dispatch_started', dispatch_started_at = clock_timestamp(),
             dispatch_token = $3, lease_until = null
         where org_id = $1 and id = $2`,
        [orgId, replyAttemptId, replyDispatchToken],
      );
      const { data: replyPending, error: replyPendingError } = await testClient
        .from("messages")
        .select("id, status, provider, body, contact_id, property_id, conversation_id, from_address, to_address, external_id, metadata")
        .eq("idempotency_key", replyAttemptId)
        .single();
      if (replyPendingError || !replyPending) {
        throw replyPendingError ?? new Error("reply projection did not create pending row");
      }
      expect(replyPending).toMatchObject({
        status: "pending",
        body: sent.body,
        contact_id: sent.contact_id,
        property_id: sent.property_id,
        from_address: sent.from_address,
        to_address: sent.to_address,
      });
      expect(Object.keys((replyPending.metadata ?? {}) as Record<string, unknown>).sort()).toEqual([
        "inboxReply",
      ]);

      const replyPendingCapture = await db.query<{ metadata: Record<string, unknown>; snapshot: Record<string, unknown> }>(
        `select metadata, snapshot
         from inbox_reply_test.t23_message_capture
         where message_id = $1 and status = 'pending'
         order by captured_at desc limit 1`,
        [replyPending.id],
      );
      expect(replyPendingCapture.rows).toHaveLength(1);
      expect(normalizeCaptureSnapshot(legacyPending!.snapshot as CaptureSnapshot)).toEqual(
        normalizeCaptureSnapshot(replyPendingCapture.rows[0]!.snapshot as CaptureSnapshot),
      );

      await db.query(
        `update inbox_reply_send.attempts
         set state = 'provider_accepted', provider_reference = $3,
             provider_status = 'sent', receipt_version = 1
         where org_id = $1 and id = $2`,
        [orgId, replyAttemptId, sent!.external_id],
      );
      const { data: replyAccepted, error: replyAcceptedError } = await testClient
        .from("messages")
        .select("id, status, provider, body, contact_id, property_id, conversation_id, from_address, to_address, external_id, sent_at, metadata")
        .eq("idempotency_key", replyAttemptId)
        .single();
      if (replyAcceptedError || !replyAccepted) {
        throw replyAcceptedError ?? new Error("reply projection acceptance failed");
      }
      expect(replyAccepted).toMatchObject({
        status: "sent",
        body: sent.body,
        contact_id: sent.contact_id,
        property_id: sent.property_id,
        from_address: sent.from_address,
        to_address: sent.to_address,
        external_id: sent.external_id,
      });
      expect(Object.keys((replyAccepted.metadata ?? {}) as Record<string, unknown>).sort()).toEqual([
        "inboxReply",
        "providerStatus",
      ]);

      const replyAcceptedCapture = await db.query<{ snapshot: Record<string, unknown> }>(
        `select snapshot
         from inbox_reply_test.t23_message_capture
         where message_id = $1 and status = 'sent'
         order by captured_at desc limit 1`,
        [replyAccepted.id],
      );
      expect(replyAcceptedCapture.rows).toHaveLength(1);
      const legacyAcceptedEffects = legacyAccepted!.snapshot as CaptureSnapshot;
      const replyAcceptedEffects = replyAcceptedCapture.rows[0]!.snapshot as CaptureSnapshot;
      expect(normalizeCaptureSnapshot(legacyAcceptedEffects)).toEqual(
        normalizeCaptureSnapshot(replyAcceptedEffects),
      );
    } finally {
      await db.query(`
        drop trigger if exists zzzzzzzzzz_t23_capture on public.messages;
        drop function if exists inbox_reply_test.capture_t23_messages();
        drop schema if exists inbox_reply_test cascade;
      `);
      await db.end();
    }
  });

  it("updates status for a valid transition", async () => {
    const id = await seedProperty("new_lead");
    const result = await updatePropertyStatus(id, "contacted", "new_lead");
    expect(result.ok).toBe(true);

    const { data } = await testClient
      .from("properties")
      .select("status")
      .eq("id", id)
      .single();
    expect(data?.status).toBe("contacted");

    const { data: events } = await testClient
      .from("lead_events")
      .select("event_type, payload")
      .eq("property_id", id);
    expect(events).toEqual([
      {
        event_type: "status_changed",
        payload: { from: "new_lead", to: "contacted" },
      },
    ]);
  });

  it("bumps updated_at when status changes", async () => {
    const id = await seedProperty("new_lead");
    const { data: before } = await testClient
      .from("properties")
      .select("updated_at")
      .eq("id", id)
      .single();
    // Small delay so the updated_at timestamp can actually move.
    await new Promise((r) => setTimeout(r, 50));
    const result = await updatePropertyStatus(id, "offer_sent", "new_lead");
    expect(result.ok).toBe(true);
    const { data: after } = await testClient
      .from("properties")
      .select("updated_at")
      .eq("id", id)
      .single();
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime(),
    );
  });

  it("rejects an invalid status with INVALID_STATUS", async () => {
    const id = await seedProperty("new_lead");
    // @ts-expect-error — deliberately passing an invalid status
    const result = await updatePropertyStatus(id, "bogus_status", "new_lead");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_STATUS");
  });

  it("does not report success when no property row was updated", async () => {
    const result = await updatePropertyStatus(
      "00000000-0000-0000-0000-000000000000",
      "contacted",
      "new_lead",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A missing row cannot be proven unlocked, so the permanent-DNC
      // preflight correctly fails closed before compare-and-set reconciliation.
      expect(result.error.code).toBe("PROPERTY_LOCK_CHECK_FAILED");
    }
  });

  it("returns the newer authoritative stage, then accepts a retry from that stage", async () => {
    const id = await seedProperty("interested");

    const result = await updatePropertyStatus(id, "offer_sent", "contacted");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STATUS_CONFLICT");
      expect(result.error.details).toEqual({ currentStatus: "interested" });
    }
    const { data } = await testClient
      .from("properties")
      .select("status")
      .eq("id", id)
      .single();
    expect(data?.status).toBe("interested");

    const retry = await updatePropertyStatus(id, "offer_sent", "interested");
    expect(retry).toEqual({
      ok: true,
      data: { propertyId: id, status: "offer_sent" },
    });
  });

  it("treats another client's already-saved target as idempotent success", async () => {
    const id = await seedProperty("contacted");
    const result = await updatePropertyStatus(id, "contacted", "new_lead");
    expect(result).toEqual({
      ok: true,
      data: { propertyId: id, status: "contacted" },
    });
    const { count } = await testClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("property_id", id);
    expect(count).toBe(0);
  });

  it("qualifyLeadsBulk collects per-id failures without aborting the batch", async () => {
    // Seed three prospects + one missing id. qualifyLeadsBulk should
    // qualify the real prospects, report the missing one in `failed`,
    // and return ok so the toast can render a partial-success summary.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { data, error } = await testClient
        .from("properties")
        .insert({
          address: `${i + 100} Partial Ln`,
          state: "MO",
          status: "prospect",
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("seed failed");
      ids.push(data.id);
    }
    const missingId = "00000000-0000-0000-0000-000000000000";

    const result = await qualifyLeadsBulk([ids[0], missingId, ids[1], ids[2]]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.qualified).toBe(3);
    expect(result.data.alreadyQualified).toBe(0);
    expect(result.data.failed).toHaveLength(1);
    expect(result.data.failed[0].propertyId).toBe(missingId);

    // All three real prospects actually flipped despite the bad id in the
    // middle of the batch.
    const { data: after } = await testClient
      .from("properties")
      .select("id, status")
      .in("id", ids);
    for (const row of after ?? []) {
      expect(row.status).toBe("new_lead");
    }
  });

  it("accepts every valid enum value", async () => {
    const statuses = [
      "new_lead",
      "contacted",
      "interested",
      "offer_sent",
      "offer_declined",
      "under_contract",
      "closed",
      "dead",
    ] as const;
    const id = await seedProperty("new_lead");
    let previous = "new_lead" as (typeof statuses)[number];
    for (const s of statuses) {
      const result = await updatePropertyStatus(id, s, previous);
      expect(result.ok, `status=${s}`).toBe(true);
      previous = s;
    }
  });
});
