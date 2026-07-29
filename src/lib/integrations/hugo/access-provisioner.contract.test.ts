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
const hardDeleteMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260728110000_hugo_auth_hard_delete.sql",
  ),
  "utf8",
);
const forwardHashMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260728130000_hugo_access_operation_request_hash.sql",
  ),
  "utf8",
);
const authorizationHardeningMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260728150000_hugo_access_authorization_hardening.sql",
  ),
  "utf8",
);
const terminalRevocationMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260729170000_hugo_revoked_access_terminal.sql",
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
      expect(migration).toContain(
        `revoke execute on function public.${fn} from public;`,
      );
      expect(migration).toContain(
        `revoke execute on function public.${fn} from anon;`,
      );
      expect(migration).toContain(
        `revoke execute on function public.${fn} from authenticated;`,
      );
      expect(migration).toContain(
        `grant execute on function public.${fn} to service_role;`,
      );
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
    expect(migration).toContain("mismatches fall through to apply them.");
    expect(migration).not.toContain(
      "elsif v_membership.access_status = p_status and v_membership.role = p_role then",
    );
    expect(migration).toContain("hugo_access_operations");
    expect(migration).toContain("hugo_has_durable_activity");
    expect(migration).toContain("FINAL_OWNER_GUARD");
    expect(migration).toContain("trg_hugo_membership_owner_guard");
    expect(migration).toContain("REVOKED_NOT_REACTIVATABLE");
  });

  it("ships a forward-only repair that makes revoked access terminal", () => {
    expect(terminalRevocationMigration).toContain(
      "p_status[[:space:]]*<>[[:space:]]*'revoked'",
    );
    expect(terminalRevocationMigration).toContain(
      "A revoked Sandra grant is terminal and cannot change status.",
    );
    expect(terminalRevocationMigration).toContain(
      "HUGO_REVOKED_TERMINAL_INSTALL_STATE_CHANGED",
    );
    expect(terminalRevocationMigration).toContain(
      "HUGO_REVOKED_TERMINAL_INSTALL_FAILED",
    );
    expect(terminalRevocationMigration).toContain(
      "hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)",
    );
  });

  it("binds every lifecycle receipt to a canonical request hash", () => {
    expect(migration).toContain("request_hash text");
    expect(migration).toContain(
      "create or replace function public.hugo_request_hash(",
    );
    expect(migration).toContain("digest(");
    expect(migration).toContain("'{request_hash}'");
    expect(migration).toContain(
      "create or replace function public.hugo_store_access_operation(",
    );
    expect(migration).toContain(
      "public.hugo_store_access_operation(p_operation_id, v_operation",
    );
    expect(migration).toContain(
      "public.hugo_store_access_operation(p_operation_id, 'preparePristineDelete'",
    );
    expect(migration).toContain(
      "public.hugo_store_access_operation(p_operation_id, 'deleteIdentity'",
    );
    expect(migration).toContain("v_prior_hash is distinct from v_request_hash");
    expect(migration).toContain(
      "Operation id was already used with a different request.",
    );
    expect(migration).not.toContain(
      "if (v_receipt->>'ok')::boolean then\n    insert into public.hugo_access_operations",
    );
    expect(hardDeleteMigration).toContain(
      "v_prior_hash is distinct from v_request_hash",
    );
    expect(hardDeleteMigration).toContain(
      "public.hugo_store_access_operation(p_operation_id, 'deleteIdentity'",
    );
  });

  it("ships a forward-only hash migration for already-provisioned environments", () => {
    expect(forwardHashMigration).toContain(
      "alter table public.hugo_access_operations\n  add column if not exists request_hash text;",
    );
    expect(forwardHashMigration).toContain(
      "create or replace function public.hugo_sandra_canonical_request_payload(",
    );
    expect(forwardHashMigration).toContain(
      "create trigger trg_hugo_sandra_access_operation_hash",
    );
    expect(forwardHashMigration).toContain(
      "alter function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)\n      rename to hugo_apply_access_unhashed;",
    );
    expect(forwardHashMigration).toContain("v_prior_hash = v_hash");
    expect(forwardHashMigration).toContain(
      "Operation id was already used with a different request.",
    );
    expect(forwardHashMigration).toContain(
      "hugo_prepare_pristine_delete_unhashed",
    );
    expect(forwardHashMigration).toContain("hugo_delete_identity_unhashed");
    expect(forwardHashMigration).toContain(
      "p_operation_id, p_email, p_role, v_config, p_status, p_access_expires_at",
    );
  });

  it("hash-binds invalid requests without retaining their raw values", () => {
    expect(forwardHashMigration).toContain(
      "when public.hugo_sandra_config_is_safe(coalesce(p_requested_config, '{}'::jsonb))",
    );
    expect(authorizationHardeningMigration).toContain(
      "create or replace function public.hugo_record_invalid_access_request(",
    );
    expect(authorizationHardeningMigration).toContain(
      "p_request_hash !~ '^[0-9a-f]{64}$'",
    );
    expect(authorizationHardeningMigration).toContain(
      "current_setting('hugo.preserve_request_hash', true) = '1'",
    );
    expect(authorizationHardeningMigration).toContain(
      "perform set_config('hugo.preserve_request_hash', '1', true)",
    );
    expect(authorizationHardeningMigration).toContain(
      "else 'redacted@invalid'",
    );
    expect(authorizationHardeningMigration).toContain(
      "p_operation_id, null, v_role, v_config, v_status",
    );
    expect(authorizationHardeningMigration).toContain(
      "revoke all on table public.hugo_access_operations",
    );
    expect(authorizationHardeningMigration).toContain(
      "revoke all on table public.hugo_access_operation_claims",
    );
  });

  it("ships a forward-only authorization repair for hosted environments", () => {
    for (const helper of [
      "hugo_request_hash(",
      "hugo_config_is_safe(",
      "hugo_sandra_config_is_safe(",
      "hugo_find_user_id(",
      "hugo_has_durable_activity(",
      "hugo_has_prior_sign_in(",
      "hugo_membership_owner_guard()",
      "hugo_apply_access(",
      "hugo_prepare_pristine_delete(",
      "hugo_delete_identity(",
      "hugo_list_access()",
    ]) {
      expect(authorizationHardeningMigration).toContain(
        `create or replace function public.${helper}`,
      );
    }
    expect(authorizationHardeningMigration).toContain(
      "create policy memberships_self_select",
    );
    for (const lifecyclePredicate of [
      "access_status = 'active'",
      "deletion_prepared_at is null",
      "access_expires_at is null or access_expires_at > now()",
    ]) {
      expect(authorizationHardeningMigration).toContain(lifecyclePredicate);
    }
    expect(authorizationHardeningMigration).toContain(
      "create trigger trg_hugo_membership_lifecycle_service_guard",
    );
    expect(authorizationHardeningMigration).toContain(
      "create or replace function public.hugo_has_active_org_access(p_org_id uuid)",
    );
    for (const policy of [
      "skip_trace_cache_authenticated_select",
      "saved_filters_read_own_plus_base",
      "saved_filters_insert_own",
      "saved_filters_update_own",
      "saved_filters_delete_own",
      "user_oauth_tokens_self_read",
      "user_integration_prefs_self_all",
      '"authenticated users can read metric snapshots"',
      "counties_authenticated_select",
      "fips_codes_authenticated_select",
      "zip_county_xref_authenticated_select",
    ]) {
      expect(authorizationHardeningMigration).toContain(
        `create policy ${policy}`,
      );
    }
    for (const privateRpc of [
      "delete_contact_hugo_unchecked",
      "merge_duplicate_properties_hugo_unchecked",
      "ensure_sms_conversation_id_hugo_unchecked",
      "campaign_kpis_hugo_unchecked",
      "preview_campaign_cadence_reschedule_hugo_unchecked",
    ]) {
      expect(authorizationHardeningMigration).toContain(privateRpc);
    }
  });

  it("reserves operation ids before Auth provisioning and verifies the claim", () => {
    expect(authorizationHardeningMigration).toContain(
      "create table if not exists public.hugo_access_operation_claims",
    );
    expect(authorizationHardeningMigration).toContain(
      "create or replace function public.hugo_preflight_access_operation(",
    );
    expect(authorizationHardeningMigration).toContain(
      "'proceed', true, 'request_hash', v_hash",
    );
    expect(authorizationHardeningMigration).toContain("v_claim_hash <> v_hash");
    expect(authorizationHardeningMigration).toContain(
      "set consumed_at = now()",
    );
    expect(authorizationHardeningMigration).toContain(
      "create or replace function public.hugo_record_identity_provision_failure(",
    );
    expect(authorizationHardeningMigration).toContain(
      "'IDENTITY_PROVISION_FAILED'",
    );
    expect(authorizationHardeningMigration).toContain(
      "'OPERATION_PREFLIGHT_REQUIRED'",
    );
    expect(authorizationHardeningMigration).toContain(
      "grant execute on function public.hugo_record_identity_provision_failure(",
    );
    expect(authorizationHardeningMigration).not.toContain(
      "v_receipt := public.hugo_apply_access_claimed_unchecked",
    );
  });

  it("keeps one active non-expiring owner after every membership mutation", () => {
    expect(authorizationHardeningMigration).toContain(
      "before insert or update or delete on public.memberships",
    );
    expect(authorizationHardeningMigration).toContain(
      "hashtextextended('hugo-sandra-permanent-owner-v2', 0)",
    );
    expect(authorizationHardeningMigration).toContain(
      "create table if not exists public.hugo_owner_guard_serialization",
    );
    expect(authorizationHardeningMigration).toContain(
      "set version = version + 1",
    );
    expect(authorizationHardeningMigration).toContain(
      "and m.access_expires_at is null",
    );
    expect(authorizationHardeningMigration).toContain(
      "HUGO_PERMANENT_OWNER_REQUIRED",
    );
  });

  it("checks stored retries before current identity and lifecycle state", () => {
    for (const [signature, identityLookup] of [
      [
        "create or replace function public.hugo_apply_access(",
        "v_user_id := public.hugo_find_user_id(v_email);",
      ],
      [
        "create or replace function public.hugo_prepare_pristine_delete(",
        "v_user_id := public.hugo_find_user_id(v_email);",
      ],
      [
        "create or replace function public.hugo_delete_identity(",
        "v_user_id := public.hugo_find_user_id(v_email);",
      ],
    ]) {
      const body = authorizationHardeningMigration.slice(
        authorizationHardeningMigration.lastIndexOf(signature),
      );
      expect(
        body.indexOf("select op.operation, op.request_hash, op.receipt"),
      ).toBeGreaterThan(-1);
      expect(
        body.indexOf("select op.operation, op.request_hash, op.receipt"),
      ).toBeLessThan(body.indexOf(identityLookup));
    }
    expect(authorizationHardeningMigration).not.toContain(
      "v_receipt := public.hugo_prepare_pristine_delete_authorization_unchecked",
    );
    expect(authorizationHardeningMigration).not.toContain(
      "v_receipt := public.hugo_delete_identity_authorization_unchecked",
    );
  });

  it("protects every pristine-delete proof", () => {
    expect(authorizationHardeningMigration).toContain(
      "public.hugo_has_prior_sign_in(v_user_id)",
    );
    expect(authorizationHardeningMigration).toContain(
      "c.confrelid = 'auth.users'::regclass",
    );
    expect(authorizationHardeningMigration).toContain(
      "op.operation = 'preparePristineDelete'",
    );
    expect(authorizationHardeningMigration).toContain(
      "op.receipt->>'ok' = 'true'",
    );
    expect(authorizationHardeningMigration).toContain(
      "PRISTINE_DELETE_REQUIRED",
    );
  });

  it("pseudonymizes deleted identifiers without changing retry evidence", () => {
    expect(authorizationHardeningMigration).toContain(
      "create or replace function public.hugo_pseudonymize_deleted_identity(",
    );
    for (const identifier of [
      "set email = v_pseudonym_email",
      "app_user_id = v_pseudonym_id",
      "requested = replace(",
      "receipt = jsonb_set(",
      "update public.hugo_access_operation_claims claim",
    ]) {
      expect(authorizationHardeningMigration).toContain(identifier);
    }
    expect(authorizationHardeningMigration).toContain(
      "current_setting('hugo.pseudonymizing', true) = '1'",
    );
    expect(authorizationHardeningMigration).toContain(
      "new.request_hash := old.request_hash",
    );
    expect(authorizationHardeningMigration).toContain(
      "perform public.hugo_pseudonymize_deleted_identity(v_email, v_user_id)",
    );
    expect(authorizationHardeningMigration).toContain(
      "HUGO_IDENTITY_PSEUDONYMIZATION_FAILED",
    );
  });

  it("serializes owner checks with a shared lifecycle lock", () => {
    expect(migration).toContain(
      "hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)",
    );
    expect(migration).not.toContain(
      "hashtextextended(p_operation_id::text, 0)",
    );
    expect(
      migration.match(
        /hashtextextended\('hugo-sandra-privileged-lifecycle-v1', 0\)/g,
      ),
    ).toHaveLength(4);
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
    expect(inventoryMigration).toContain(
      "perform public.hugo_require_service_role();",
    );
    expect(inventoryMigration).toContain(
      "order by lower(trim(coalesce(u.email, ''))), m.user_id;",
    );
    expect(inventoryMigration).toContain(
      "revoke execute on function public.hugo_list_access() from public, anon, authenticated;",
    );
    expect(inventoryMigration).toContain(
      "grant execute on function public.hugo_list_access() to service_role;",
    );
    expect(inventoryMigration).not.toMatch(
      /\binsert\s+into\b|\bupdate\s+[^\n]+\bset\b|\bdelete\s+from\b/i,
    );
  });

  it("hard-deletes Auth after the guarded local cleanup and keeps retries safe", () => {
    const missingMembershipBranch = hardDeleteMigration.slice(
      hardDeleteMigration.indexOf("if not found then"),
      hardDeleteMigration.indexOf(
        "elsif v_membership.deletion_prepared_at is null",
      ),
    );
    expect(missingMembershipBranch).toContain(
      "v_activity := public.hugo_has_durable_activity(v_user_id)\n        or public.hugo_has_prior_sign_in(v_user_id);",
    );
    expect(missingMembershipBranch).toContain("elsif not v_has_prepare then");
    expect(missingMembershipBranch).toContain("v_should_delete_auth := true;");
    expect(
      hardDeleteMigration.indexOf("delete from public.memberships"),
    ).toBeLessThan(hardDeleteMigration.indexOf("delete from auth.users"));
    expect(hardDeleteMigration).toContain(
      "delete from auth.users where id = v_user_id;",
    );
    expect(hardDeleteMigration).toContain(
      "get diagnostics v_deleted_count = row_count;",
    );
    expect(hardDeleteMigration).toContain(
      "if v_deleted_count not in (0, 1) then",
    );
    expect(hardDeleteMigration).toContain("HUGO_AUTH_DELETE_FAILED");
    expect(hardDeleteMigration).toContain(
      "-- Zero rows is an idempotent retry or a concurrent already-completed",
    );
    expect(hardDeleteMigration).toContain(
      "where operation_id = p_operation_id;",
    );
    expect(hardDeleteMigration).toContain(
      "return public.hugo_receipt_with_request_hash(v_prior, v_request_hash);",
    );
    expect(hardDeleteMigration).toContain(
      "perform public.hugo_store_access_operation(p_operation_id, 'deleteIdentity'",
    );
    expect(hardDeleteMigration).toContain(
      "revoke execute on function public.hugo_delete_identity(uuid, text) from authenticated;",
    );
    expect(hardDeleteMigration).toContain(
      "grant execute on function public.hugo_delete_identity(uuid, text) to service_role;",
    );
  });
});
