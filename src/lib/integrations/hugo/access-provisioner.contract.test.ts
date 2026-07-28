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
const inventoryMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260728090000_hugo_access_inventory.sql",
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
    expect(migration).toContain("array_agg(id order by id)");
    expect(migration).toContain("HUGO_IDENTITY_AMBIGUOUS");
    expect(migration).not.toContain("order by id\n  limit 1");
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
    expect(migration).toContain(
      "and v_membership.hugo_config = coalesce(p_config, '{}'::jsonb)",
    );
    expect(migration).toContain(
      "and v_membership.access_expires_at is not distinct from p_access_expires_at",
    );
    expect(migration).toContain(
      "mismatches fall through to apply them.",
    );
    expect(migration).not.toContain(
      "elsif v_membership.access_status = p_status and v_membership.role = p_role then",
    );
    expect(migration).toContain("hugo_access_operations");
    expect(migration).toContain("hugo_has_durable_activity");
    expect(migration).toContain("FINAL_OWNER_GUARD");
    expect(migration).toContain("trg_hugo_membership_owner_guard");
    expect(migration).toContain("REVOKED_NOT_REACTIVATABLE");
  });

  it("defines a deterministic service-role-only read-only inventory", () => {
    expect(inventoryMigration).toContain(
      "create or replace function public.hugo_list_access()",
    );
    expect(inventoryMigration).toContain("returns table (");
    for (const field of [
      "email text",
      "app_user_id uuid",
      "role text",
      "config jsonb",
      "status text",
      "access_expires_at timestamptz",
      "has_durable_activity boolean",
    ]) {
      expect(inventoryMigration).toContain(field);
    }
    expect(inventoryMigration).toContain("perform public.hugo_require_service_role();");
    expect(inventoryMigration).toContain(
      "order by lower(trim(coalesce(u.email, ''))), m.user_id;",
    );
    expect(inventoryMigration).toContain(
      "revoke execute on function public.hugo_list_access() from public, anon, authenticated;",
    );
    expect(inventoryMigration).toContain(
      "grant execute on function public.hugo_list_access() to service_role;",
    );
    expect(inventoryMigration).not.toMatch(/\binsert\s+into\b|\bupdate\s+[^\n]+\bset\b|\bdelete\s+from\b/i);
  });
});
