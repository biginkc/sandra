import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";

let pg: Client;
const serviceClient = createTestClient();

type CoachCallIndexClient = {
  from(table: "coach_call_index"): {
    upsert(values: {
      client_call_id: string;
      operator_user_id: string;
      property_id: string | null;
    }): Promise<{ error: { message: string } | null }>;
    select(columns: "client_call_id"): {
      eq(column: "client_call_id", value: string): Promise<{
        data: { client_call_id: string }[] | null;
        error: { message: string } | null;
      }>;
    };
  };
};

function asIndexClient(client: SupabaseClient<Database>): CoachCallIndexClient {
  return client as unknown as CoachCallIndexClient;
}

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL in .env.test.local — see tests/integration/README.md.",
    );
  }
  return url;
}

beforeAll(async () => {
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  const sql = readFileSync(
    path.resolve(__dirname, "20260827220000_coach_call_index_grant_hardening.sql"),
    "utf8",
  );
  await pg.query(sql);
});

afterAll(async () => {
  await pg.end();
});

describe("Migration 20260827220000 — coach call index grant hardening", () => {
  it("preserves RLS and the owner-only SELECT policy", async () => {
    const { rows } = await pg.query<{
      rls_enabled: boolean;
      owner_policy_count: number;
    }>(`
      select
        (select relrowsecurity
           from pg_class
          where oid = 'public.coach_call_index'::regclass) as rls_enabled,
        (select count(*)::int
           from pg_policies
          where schemaname = 'public'
            and tablename = 'coach_call_index'
            and policyname = 'coach_call_index_owner_select'
            and cmd = 'SELECT'
            and roles = array['authenticated']::name[]
            and qual = '(operator_user_id = auth.uid())') as owner_policy_count
    `);

    expect(rows[0]).toEqual({
      rls_enabled: true,
      owner_policy_count: 1,
    });
  });

  it("leaves browser roles read-only and preserves the service-role upsert path", async () => {
    const { rows } = await pg.query<{
      anon_select: boolean;
      anon_insert: boolean;
      anon_update: boolean;
      anon_delete: boolean;
      anon_truncate: boolean;
      anon_references: boolean;
      anon_trigger: boolean;
      authenticated_select: boolean;
      authenticated_insert: boolean;
      authenticated_update: boolean;
      authenticated_delete: boolean;
      authenticated_truncate: boolean;
      authenticated_references: boolean;
      authenticated_trigger: boolean;
      service_select: boolean;
      service_insert: boolean;
      service_update: boolean;
    }>(`
      select
        has_table_privilege('anon', 'public.coach_call_index', 'select') as anon_select,
        has_table_privilege('anon', 'public.coach_call_index', 'insert') as anon_insert,
        has_table_privilege('anon', 'public.coach_call_index', 'update') as anon_update,
        has_table_privilege('anon', 'public.coach_call_index', 'delete') as anon_delete,
        has_table_privilege('anon', 'public.coach_call_index', 'truncate') as anon_truncate,
        has_table_privilege('anon', 'public.coach_call_index', 'references') as anon_references,
        has_table_privilege('anon', 'public.coach_call_index', 'trigger') as anon_trigger,
        has_table_privilege('authenticated', 'public.coach_call_index', 'select') as authenticated_select,
        has_table_privilege('authenticated', 'public.coach_call_index', 'insert') as authenticated_insert,
        has_table_privilege('authenticated', 'public.coach_call_index', 'update') as authenticated_update,
        has_table_privilege('authenticated', 'public.coach_call_index', 'delete') as authenticated_delete,
        has_table_privilege('authenticated', 'public.coach_call_index', 'truncate') as authenticated_truncate,
        has_table_privilege('authenticated', 'public.coach_call_index', 'references') as authenticated_references,
        has_table_privilege('authenticated', 'public.coach_call_index', 'trigger') as authenticated_trigger,
        has_table_privilege('service_role', 'public.coach_call_index', 'select') as service_select,
        has_table_privilege('service_role', 'public.coach_call_index', 'insert') as service_insert,
        has_table_privilege('service_role', 'public.coach_call_index', 'update') as service_update
    `);

    expect(rows[0]).toEqual({
      anon_select: false,
      anon_insert: false,
      anon_update: false,
      anon_delete: false,
      anon_truncate: false,
      anon_references: false,
      anon_trigger: false,
      authenticated_select: true,
      authenticated_insert: false,
      authenticated_update: false,
      authenticated_delete: false,
      authenticated_truncate: false,
      authenticated_references: false,
      authenticated_trigger: false,
      service_select: true,
      service_insert: true,
      service_update: true,
    });
  });

  it("keeps the real server upsert working while denying non-owner and direct API writes", async () => {
    const env = loadTestEnv();
    const url = process.env.TEST_SUPABASE_URL ?? env.TEST_SUPABASE_URL;
    const anonKey =
      process.env.TEST_SUPABASE_ANON_KEY ?? env.TEST_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Error("Missing Sandra test URL or anon key.");
    }

    const password = `Coach-${crypto.randomUUID()}-A1!`;
    const createdUserIds: string[] = [];
    const createUser = async (label: string) => {
      const email = `coach-grants-${label}-${crypto.randomUUID()}@bmhgroupkc.com`;
      const { data, error } = await serviceClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      expect(error).toBeNull();
      createdUserIds.push(data.user!.id);

      const client = createClient<Database>(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: signInError } = await client.auth.signInWithPassword({
        email,
        password,
      });
      expect(signInError).toBeNull();
      return { userId: data.user!.id, client };
    };

    try {
      const owner = await createUser("owner");
      const other = await createUser("other");
      const clientCallId = crypto.randomUUID();

      const { error: serviceUpsertError } = await asIndexClient(serviceClient)
        .from("coach_call_index")
        .upsert({
          client_call_id: clientCallId,
          operator_user_id: owner.userId,
          property_id: null,
        });
      expect(serviceUpsertError).toBeNull();

      const ownerRead = await asIndexClient(owner.client)
        .from("coach_call_index")
        .select("client_call_id")
        .eq("client_call_id", clientCallId);
      expect(ownerRead.error).toBeNull();
      expect(ownerRead.data).toEqual([{ client_call_id: clientCallId }]);

      const otherRead = await asIndexClient(other.client)
        .from("coach_call_index")
        .select("client_call_id")
        .eq("client_call_id", clientCallId);
      expect(otherRead.error).toBeNull();
      expect(otherRead.data).toEqual([]);

      const authenticatedWrite = await asIndexClient(owner.client)
        .from("coach_call_index")
        .upsert({
          client_call_id: crypto.randomUUID(),
          operator_user_id: owner.userId,
          property_id: null,
        });
      expect(authenticatedWrite.error?.message).toMatch(
        /permission denied|row-level security/i,
      );

      const anonymousClient = createClient<Database>(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const anonymousRead = await asIndexClient(anonymousClient)
        .from("coach_call_index")
        .select("client_call_id")
        .eq("client_call_id", clientCallId);
      expect(anonymousRead.error?.message).toMatch(/permission denied/i);
    } finally {
      for (const userId of createdUserIds) {
        const { error } = await serviceClient.auth.admin.deleteUser(userId);
        if (error) throw new Error(`coach grant test cleanup failed: ${error.message}`);
      }
    }
  });
});
