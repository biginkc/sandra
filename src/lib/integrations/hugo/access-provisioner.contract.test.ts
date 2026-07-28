import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260727150000_hugo_access_provisioner.sql",
  ),
  "utf8",
);

describe("Hugo/Sandra SQL connector contract", () => {
  it("keeps the frozen PostgREST RPC names and argument order", () => {
    expect(migration).toContain(
      "create or replace function public.hugo_apply_access(\n  p_operation_id uuid,\n  p_email text,\n  p_role text,\n  p_config jsonb,\n  p_status text,\n  p_access_expires_at timestamptz",
    );
    expect(migration).toContain(
      "create or replace function public.hugo_inspect_access(p_email text)",
    );
    expect(migration).toContain(
      "create or replace function public.hugo_prepare_pristine_delete(\n  p_operation_id uuid,\n  p_email text",
    );
    expect(migration).toContain(
      "create or replace function public.hugo_delete_identity(\n  p_operation_id uuid,\n  p_email text",
    );
  });

  it("revokes browser roles and grants only service_role", () => {
    for (const fn of [
      "hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)",
      "hugo_inspect_access(text)",
      "hugo_prepare_pristine_delete(uuid, text)",
      "hugo_delete_identity(uuid, text)",
    ]) {
      expect(migration).toContain(`revoke execute on function public.${fn} from public;`);
      expect(migration).toContain(`revoke execute on function public.${fn} from anon;`);
      expect(migration).toContain(`revoke execute on function public.${fn} from authenticated;`);
      expect(migration).toContain(`grant execute on function public.${fn} to service_role;`);
    }
  });

  it("contains expiry, durable-activity, idempotency, and final-owner guards", () => {
    expect(migration).toContain("access_expires_at timestamptz");
    expect(migration).toContain("hugo_access_operations");
    expect(migration).toContain("hugo_has_durable_activity");
    expect(migration).toContain("FINAL_OWNER_GUARD");
    expect(migration).toContain("trg_hugo_membership_owner_guard");
    expect(migration).toContain("REVOKED_NOT_REACTIVATABLE");
  });
});
