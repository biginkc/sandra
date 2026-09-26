import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";

const createdUserIds: string[] = [];
let pg: Client;

type Revision = {
  digest: string;
  slug: string;
  revision: number;
  schema_version: number;
  bundle: Record<string, unknown>;
  import_status: "reviewed" | "unreviewed";
};

type CacheClient = {
  from(table: "coach_script_revisions"): {
    insert(values: Revision): Promise<{ error: { message: string } | null }>;
    select(columns: "digest"): {
      eq(
        column: "digest",
        value: string,
      ): Promise<{
        data: { digest: string }[] | null;
        error: { message: string } | null;
      }>;
    };
  };
  from(table: "coach_script_defaults"): {
    upsert(values: { slug: string; digest: string }): Promise<{
      error: { message: string } | null;
    }>;
    select(columns: "slug"): Promise<{
      data: { slug: string }[] | null;
      error: { message: string } | null;
    }>;
  };
  from(table: "coach_call_index"): {
    upsert(values: {
      client_call_id: string;
      operator_user_id: string;
      property_id: null;
    }): {
      select(columns: "script_slug,script_revision,script_digest"): {
        single(): Promise<{
          data: {
            script_slug: string | null;
            script_revision: number | null;
            script_digest: string | null;
          } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

function asCacheClient(client: SupabaseClient<Database>): CacheClient {
  return client as unknown as CacheClient;
}

function testDbUrl(): string {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL in .env.test.local — see tests/integration/README.md.",
    );
  }
  const parsed = new URL(url);
  if (
    process.env.E2E_DISPOSABLE_DATABASE !== "1" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "54322" ||
    parsed.username !== "postgres" ||
    parsed.pathname !== "/postgres"
  ) {
    throw new Error(
      "Coach script cache migration tests require the disposable local Supabase database (E2E_DISPOSABLE_DATABASE=1). Refusing any shared or hosted database.",
    );
  }
  return url;
}

// Evaluate before creating an API client so this test cannot even initialize
// against a shared or hosted database.
const disposableDbUrl = testDbUrl();
const serviceClient = createTestClient();

async function assertExistingSchemaShape(): Promise<void> {
  const { rows } = await pg.query<{
    revisions_rls: boolean;
    revision_policy_count: number;
    defaults_rls: boolean;
    immutable_trigger_count: number;
  }>(`
    select
      (select relrowsecurity from pg_class where oid = 'public.coach_script_revisions'::regclass) as revisions_rls,
      (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'coach_script_revisions' and policyname = 'coach_script_revisions_authenticated_select') as revision_policy_count,
      (select relrowsecurity from pg_class where oid = 'public.coach_script_defaults'::regclass) as defaults_rls,
      (select count(*)::int from pg_trigger where tgrelid = 'public.coach_script_revisions'::regclass and tgname = 'coach_script_revisions_immutable' and not tgisinternal) as immutable_trigger_count
  `);
  expect(rows[0]).toEqual({
    revisions_rls: true,
    revision_policy_count: 1,
    defaults_rls: true,
    immutable_trigger_count: 1,
  });
}

async function applyMigrationTwice(): Promise<void> {
  const migration = readFileSync(
    path.resolve(__dirname, "20260926100000_coach_script_cache.sql"),
    "utf8",
  );
  await pg.query(migration);
  await pg.query(migration);
  await assertExistingSchemaShape();
}

function digestFor(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

async function insertRevision(label: string): Promise<Revision> {
  const revision: Revision = {
    digest: digestFor(label),
    slug: `test-${label}`,
    revision: 1,
    schema_version: 3,
    bundle: { script: { version: "test" }, sections: [] },
    import_status: "reviewed",
  };
  const { error } = await asCacheClient(serviceClient)
    .from("coach_script_revisions")
    .insert(revision);
  expect(error).toBeNull();
  return revision;
}

async function createAuthenticatedClient(label: string) {
  const env = loadTestEnv();
  const url = process.env.TEST_SUPABASE_URL ?? env.TEST_SUPABASE_URL;
  const anonKey =
    process.env.TEST_SUPABASE_ANON_KEY ?? env.TEST_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Missing Sandra test URL or anon key.");

  const password = `Coach-${crypto.randomUUID()}-A1!`;
  const { data, error } = await serviceClient.auth.admin.createUser({
    email: `coach-script-cache-${label}-${crypto.randomUUID()}@bmhgroupkc.com`,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  createdUserIds.push(data.user!.id);

  const client = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email: data.user!.email!,
    password,
  });
  expect(signInError).toBeNull();
  return { client, userId: data.user!.id };
}

beforeAll(async () => {
  pg = new Client({ connectionString: disposableDbUrl });
  await pg.connect();
  await applyMigrationTwice();
});

afterAll(async () => {
  const cleanupErrors: string[] = [];
  for (const userId of createdUserIds) {
    const { error } = await serviceClient.auth.admin.deleteUser(userId);
    if (error)
      cleanupErrors.push(`delete auth user ${userId}: ${error.message}`);
  }
  await pg.end();
  if (cleanupErrors.length > 0) {
    throw new Error(
      `coach script cache cleanup failed: ${cleanupErrors.join("; ")}`,
    );
  }
});

describe("Migration 20260926100000 — coach script cache", () => {
  it("keeps cached revisions immutable and only permits authenticated revision reads", async () => {
    const revision = await insertRevision(`immutable-${crypto.randomUUID()}`);
    const reader = await createAuthenticatedClient("reader");

    const { data, error } = await asCacheClient(reader.client)
      .from("coach_script_revisions")
      .select("digest")
      .eq("digest", revision.digest);
    expect(error).toBeNull();
    expect(data).toEqual([{ digest: revision.digest }]);

    const { error: directWriteError } = await asCacheClient(reader.client)
      .from("coach_script_revisions")
      .insert({
        ...revision,
        digest: digestFor(`forbidden-${crypto.randomUUID()}`),
      });
    expect(directWriteError?.message).toMatch(
      /permission denied|row-level security/i,
    );

    await expect(
      pg.query(
        "update public.coach_script_revisions set slug = $1 where digest = $2",
        [`changed-${crypto.randomUUID()}`, revision.digest],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      pg.query("delete from public.coach_script_revisions where digest = $1", [
        revision.digest,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it("keeps defaults service-role-only and references an immutable cached digest", async () => {
    const revision = await insertRevision(`default-${crypto.randomUUID()}`);
    const reader = await createAuthenticatedClient("default-reader");

    const { error: defaultWriteError } = await asCacheClient(reader.client)
      .from("coach_script_defaults")
      .upsert({ slug: revision.slug, digest: revision.digest });
    expect(defaultWriteError?.message).toMatch(
      /permission denied|row-level security/i,
    );

    const { error: serviceWriteError } = await asCacheClient(serviceClient)
      .from("coach_script_defaults")
      .upsert({ slug: revision.slug, digest: revision.digest });
    expect(serviceWriteError).toBeNull();

    await expect(
      pg.query(
        "insert into public.coach_script_defaults (slug, digest) values ($1, $2)",
        [`mismatched-${crypto.randomUUID()}`, revision.digest],
      ),
    ).rejects.toThrow(/foreign key/i);

    const { error: browserReadError } = await asCacheClient(reader.client)
      .from("coach_script_defaults")
      .select("slug");
    expect(browserReadError?.message).toMatch(/permission denied/i);
  });

  it("accepts an unbound call row with all three script columns null", async () => {
    const { userId } = await createAuthenticatedClient("null-binding");
    const { data, error } = await asCacheClient(serviceClient)
      .from("coach_call_index")
      .upsert({
        client_call_id: `coach-cache-null-${crypto.randomUUID()}`,
        operator_user_id: userId,
        property_id: null,
      })
      .select("script_slug,script_revision,script_digest")
      .single();

    expect(error).toBeNull();
    expect(data).toEqual({
      script_slug: null,
      script_revision: null,
      script_digest: null,
    });
  });
});
