import fs from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";
import { createTestClient } from "@tests/integration/client";
import {
  resetJitterIntegration,
  seedCallActivity,
  seedDialerBatch,
} from "@/app/api/internal/jitter/_lib/test-helpers.integration";

const serviceClient = createTestClient();
let pg: Client;

function testDbUrl(): string {
  const value =
    process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
  if (!value) throw new Error("Missing TEST_SUPABASE_DB_URL");
  return value;
}

function migrationSql(): string {
  return fs.readFileSync(
    path.join(
      process.cwd(),
      "supabase/migrations/20260822220500_call_transcript_summary.sql",
    ),
    "utf8",
  );
}

beforeAll(async () => {
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
});

beforeEach(async () => {
  await resetJitterIntegration(serviceClient);
});

afterAll(async () => {
  await pg.end();
});

describe("Migration 20260822220500 — call transcript summary", () => {
  it("makes Jitter session part of the durable attempt identity", async () => {
    const { rows: columns } = await pg.query<{
      is_nullable: string;
    }>(
      `select is_nullable
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'call_activities'
         and column_name = 'jitter_session_id'`,
    );
    // Sandra softphone activities do not have a Jitter session; the provider-
    // conditional CHECK below makes it required only for Jitter rows.
    expect(columns).toEqual([{ is_nullable: "YES" }]);

    const { rows: indexes } = await pg.query<{
      indexname: string;
      indexdef: string;
    }>(
      `select indexname, indexdef
       from pg_indexes
       where schemaname = 'public'
         and tablename = 'call_activities'
         and indexname in (
           'idx_call_activities_org_provider_attempt',
           'idx_call_activities_org_provider_session_attempt'
         )
       order by indexname`,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexname).toBe(
      "idx_call_activities_org_provider_session_attempt",
    );
    expect(indexes[0].indexdef).toContain(
      "(org_id, provider, jitter_session_id, jitter_attempt_id)",
    );

    const { rows: constraints } = await pg.query<{ definition: string }>(
      `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public'
         and t.relname = 'call_activities'
         and c.conname = 'call_activities_jitter_session_id_trimmed_check'`,
    );
    expect(constraints).toHaveLength(1);
    expect(constraints[0].definition).toContain("provider <> 'jitter'");
    expect(constraints[0].definition).toContain(
      "jitter_session_id IS NOT NULL",
    );
    expect(constraints[0].definition).toContain("btrim(jitter_session_id)");
  });

  it("rejects a blank Jitter session at the service-role RPC boundary", async () => {
    const seeded = await seedDialerBatch(serviceClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const { error } = await (serviceClient as any).rpc(
      "jitter_writeback_call_activity",
      {
        p_attempt_id: attemptId,
        p_body: {
          org_id: seeded.orgId,
          property_id: seeded.propertyId,
          contact_id: seeded.contactId,
          dialer_batch_item_id: seeded.itemId,
          jitter_session_id: "   ",
          provider: "jitter",
          outcome: "connected_human",
        },
        p_callback_assignee_id: null,
        p_external_id: `invalid-session-${crypto.randomUUID()}`,
        p_notes: null,
        p_org_id: seeded.orgId,
        p_recording_path: null,
        p_request_hash: "not-reserved",
      },
    );

    expect(error?.message).toContain("jitter coherence check failed");
  });

  it("migrates legacy Jitter DNC evidence onto the session-scoped replay key", async () => {
    const seeded = await seedCallActivity(serviceClient, {
      sessionId: "legacy-consent-session",
    });
    const { data: event, error } = await (serviceClient as any)
      .from("consent_events")
      .insert({
        org_id: seeded.orgId,
        contact_id: seeded.contactId,
        channel: "voice",
        event_type: "opt_out",
        source: "jitter_writeback",
        source_detail: {
          externalId: seeded.jitterAttemptId,
          jitter_session_id: seeded.jitterSessionId,
        },
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    const match = migrationSql().match(
      /-- BEGIN legacy Jitter consent identity correction\.([\s\S]*?)-- END legacy Jitter consent identity correction\./,
    );
    expect(match?.[1]).toBeTruthy();

    await pg.query("begin");
    try {
      await pg.query(match![1]);
      const { rows } = await pg.query<{ source_external_id: string }>(
        `select source_external_id
         from public.consent_events
         where id = $1`,
        [event.id],
      );
      expect(rows).toEqual([
        {
          source_external_id: `${seeded.jitterSessionId}:${seeded.jitterAttemptId}`,
        },
      ]);
    } finally {
      await pg.query("rollback");
    }
  });

  it("adds the transcript summary fields and parent rollup status", async () => {
    const { rows } = await pg.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select table_name, column_name, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public'
         and (
           (table_name = 'call_transcripts' and column_name in (
             'summary', 'summary_status', 'summary_error_code',
             'summary_error_message'
           ))
           or (table_name = 'call_activities' and column_name = 'summary_status')
         )
       order by table_name, column_name`,
    );

    expect(
      rows.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
    ).toEqual([
      "call_activities.summary_status",
      "call_transcripts.summary",
      "call_transcripts.summary_error_code",
      "call_transcripts.summary_error_message",
      "call_transcripts.summary_status",
    ]);
    for (const row of rows.filter(
      ({ column_name }) => column_name === "summary_status",
    )) {
      expect(row.is_nullable).toBe("NO");
      expect(row.column_default).toMatch(/none/);
    }
  });

  it("exposes only the extended service-role transcript RPC", async () => {
    const signature =
      "public.jitter_upsert_call_transcript(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text)";
    const { rows } = await pg.query<{
      proargnames: string[];
      prosecdef: boolean;
      proconfig: string[] | null;
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_execute: boolean;
    }>(
      `select p.proargnames,
              p.prosecdef,
              p.proconfig,
              has_function_privilege('anon', $1, 'execute') as anon_execute,
              has_function_privilege('authenticated', $1, 'execute') as authenticated_execute,
              has_function_privilege('service_role', $1, 'execute') as service_execute
       from pg_catalog.pg_proc p
       where p.oid = $1::regprocedure`,
      [signature],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prosecdef: true,
      anon_execute: false,
      authenticated_execute: false,
      service_execute: true,
    });
    expect(rows[0].proconfig).toEqual(['search_path=""']);
    expect(rows[0].proargnames).toEqual([
      "p_call_activity_id",
      "p_org_id",
      "p_status",
      "p_text",
      "p_language",
      "p_error_code",
      "p_error_message",
      "p_summary",
      "p_summary_status",
      "p_summary_error_code",
      "p_summary_error_message",
      "p_external_id",
      "p_request_hash",
    ]);

    const old = await pg.query(
      `select to_regprocedure(
         'public.jitter_upsert_call_transcript(uuid,uuid,text,text,text,text,text,text,text)'
       ) as function_name`,
    );
    expect(old.rows[0].function_name).toBeNull();
  });

  it("fans child transcript and summary statuses to the Realtime parent", async () => {
    const seeded = await seedCallActivity(serviceClient);
    const { error } = await serviceClient.from("call_transcripts").insert({
      call_activity_id: seeded.callActivityId,
      status: "available",
      text: "Transcript remains readable.",
      summary: null,
      summary_status: "failed",
      summary_error_code: "summary_provider_error",
      summary_error_message: "Summary unavailable",
    } as never);
    expect(error).toBeNull();

    const { data: parent, error: parentError } = await serviceClient
      .from("call_activities")
      .select("transcript_status, summary_status")
      .eq("id", seeded.callActivityId)
      .single();
    expect(parentError).toBeNull();
    expect(parent).toMatchObject({
      transcript_status: "available",
      summary_status: "failed",
    });
  });

  it("rejects invalid child and parent summary statuses", async () => {
    const seeded = await seedCallActivity(serviceClient);
    const child = await serviceClient.from("call_transcripts").insert({
      call_activity_id: seeded.callActivityId,
      status: "available",
      summary_status: "complete",
    } as never);
    const parent = await serviceClient
      .from("call_activities")
      .update({ summary_status: "complete" } as never)
      .eq("id", seeded.callActivityId);

    expect(child.error?.code).toBe("23514");
    expect(parent.error?.code).toBe("23514");
  });
});
