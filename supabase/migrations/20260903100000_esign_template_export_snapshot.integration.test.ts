import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const migrationSql = readFileSync(
  "supabase/migrations/20260903100000_esign_template_export_snapshot.sql",
  "utf8",
)
  .replace(/\nbegin;\s*/i, "\n")
  .replace(/\s*commit;\s*$/i, "");

let pg: Client;

function testDbUrl(): string {
  const env = loadTestEnv();
  const value = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!value) throw new Error("Missing TEST_SUPABASE_DB_URL.");
  return value;
}

beforeAll(async () => {
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  await pg.query("begin");
  await pg.query(migrationSql);
  await pg.query(migrationSql);
});

afterAll(async () => {
  if (pg) {
    await pg.query("rollback");
    await pg.end();
  }
});

describe("Migration 20260903100000 — eSign template export snapshots", () => {
  it("applies twice without duplicate columns, constraints, bucket, or policies", async () => {
    const columns = await pg.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'esign_templates'
         and column_name = any($1::text[])
       order by column_name`,
      [[
        "document_storage_bucket",
        "document_storage_path",
        "field_layout",
        "layout_exported_at",
        "export_sha256",
      ]],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "document_storage_bucket",
      "document_storage_path",
      "export_sha256",
      "field_layout",
      "layout_exported_at",
    ]);

    const constraints = await pg.query<{ count: string; definition: string }>(
      `select count(*)::text,
              max(pg_get_constraintdef(oid)) as definition
       from pg_constraint
       where conrelid = 'public.esign_templates'::regclass
         and conname = 'esign_templates_document_snapshot_check'`,
    );
    expect(constraints.rows[0].count).toBe("1");
    expect(constraints.rows[0].definition).toMatch(
      /document_storage_bucket[\s\S]+document_storage_path[\s\S]+field_layout[\s\S]+layout_exported_at[\s\S]+export_sha256/i,
    );
    expect(constraints.rows[0].definition).toMatch(
      /document_storage_bucket\s+IS\s+NOT\s+NULL/i,
    );

    const bucket = await pg.query<{
      id: string;
      public: boolean;
      file_size_limit: string;
      allowed_mime_types: string[];
    }>(
      `select id, public, file_size_limit, allowed_mime_types
       from storage.buckets where id = 'esign-documents'`,
    );
    expect(bucket.rows).toEqual([{
      id: "esign-documents",
      public: false,
      file_size_limit: "41943040",
      allowed_mime_types: ["application/pdf"],
    }]);

    const policies = await pg.query<{
      policyname: string;
      roles: string[];
    }>(
      `select policyname, roles::text[] as roles
       from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname like 'esign_documents_service_role_%'
       order by policyname`,
    );
    expect(policies.rows.map((row) => row.policyname)).toEqual([
      "esign_documents_service_role_delete",
      "esign_documents_service_role_insert",
      "esign_documents_service_role_select",
      "esign_documents_service_role_update",
    ]);
    expect(policies.rows.every((row) => row.roles.includes("service_role"))).toBe(
      true,
    );
    expect(
      policies.rows.some((row) => row.roles.includes("authenticated")),
    ).toBe(false);
  });

  it("does not grant an authenticated role access to exported objects", async () => {
    await pg.query("set local role service_role");
    await pg.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('esign-documents', $1, '{"mimetype":"application/pdf"}')`,
      ["11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf"],
    );
    await pg.query("set local role authenticated");
    await pg.query(
      "select set_config('request.jwt.claim.role', 'authenticated', true)",
    );
    const result = await pg.query(
      "select name from storage.objects where bucket_id = 'esign-documents'",
    );
    expect(result.rows).toEqual([]);
    await pg.query("reset role");
    await pg.query("select set_config('request.jwt.claim.role', '', true)");
  });
});
