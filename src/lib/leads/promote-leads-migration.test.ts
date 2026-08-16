import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260815230000_promote_leads_jobs.sql",
    import.meta.url,
  ),
  "utf8",
).toLowerCase();

describe("promote-leads durable job migration", () => {
  it("adds replay-safe job and item identities without rewriting history", () => {
    expect(migration).toContain("'promote_leads'::text");
    expect(migration).toMatch(/add column if not exists idempotency_key uuid/);
    expect(migration).toMatch(
      /unique index[^;]+\(org_id, type, idempotency_key\)[^;]+idempotency_key is not null/,
    );
    expect(migration).toMatch(/add column if not exists item_key text/);
    expect(migration).toMatch(/add column if not exists workflow_claim_token uuid/);
    expect(migration).toMatch(/foreign key \(property_id\) references public\.properties\(id\) on delete set null/);
    expect(migration).toMatch(/unique index[^;]+\(job_id, item_key\)/);
    expect(migration).toMatch(
      /unique index[^;]+\(parent_job_id\)[^;]+type = 'promote_leads'[^;]+status in \('queued', 'running'\)/,
    );
  });

  it("creates an authenticated transactional request RPC with active membership and request binding", () => {
    expect(migration).toContain("create or replace function public.create_promote_leads_job");
    expect(migration).toContain("v_actor uuid := auth.uid()");
    expect(migration).toContain("m.access_status = 'active'");
    expect(migration).toContain("m.deletion_prepared_at is null");
    expect(migration).toContain("m.access_expires_at is null or m.access_expires_at > now()");
    expect(migration).toMatch(/array_agg\(distinct property_id order by property_id\)/);
    expect(migration).toMatch(/idempotency key reuse with different properties/);
    expect(migration).toMatch(/one or more properties are unavailable/);
    expect(migration).toMatch(/for share of p;[\s\S]+get diagnostics v_available = row_count/);
    expect(migration).toMatch(/get diagnostics v_inserted = row_count/);
    expect(migration).toMatch(/audience changed before durable item creation/);
    expect(migration).toContain("set search_path = public, pg_temp");
  });

  it("uses only the permanent property lock at both creation and the atomic status write", () => {
    expect(migration).toContain("p.is_dnc_locked");
    expect(migration).toMatch(/status = 'new_lead'/);
    expect(migration).toMatch(/qualified_at = now\(\)/);
    expect(migration).toMatch(/qualified_by = v_job.created_by::text/);
    expect(migration).not.toContain("sms_opted_out");
    expect(migration).not.toContain("sms_phone_suppressions");
    expect(migration).not.toContain("outreach_dispo");
    expect(migration).not.toContain("do_not_contact");
  });

  it("keeps service-role item processing tenant-bound and terminal counters ledger-derived", () => {
    expect(migration).toContain("create or replace function public.process_promote_leads_item");
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toMatch(/p\.org_id = v_job\.org_id/);
    expect(migration).toMatch(/count\(\*\) filter \(where ji\.status <> 'pending'\)/);
    expect(migration).toMatch(/'partially_completed'/);
    expect(migration).toContain("create or replace function public.retry_promote_leads_job");
    expect(migration).toContain("create or replace function public.fail_promote_leads_workflow");
    expect(migration).toMatch(/workflow_claim_token is distinct from p_claim_token/);
    expect(migration).toMatch(/'workflow_failed'[\s\S]+status = 'pending'/);
  });

  it("does not overwrite a job when a late workflow-start failure loses the queued-state race", () => {
    expect(migration).toMatch(/get diagnostics v_changed = row_count/);
    expect(migration).toMatch(/select j\.status[\s\S]+for update of j/);
    expect(migration).toMatch(/if v_changed \+ v_missing_changed = 0 then[\s\S]+return coalesce\(v_summary/);
    expect(migration).toMatch(/jsonb_build_object\('status', j\.status\)/);
    expect(migration).toMatch(
      /set error_class = 'database'[\s\S]+where id = p_job and type = 'promote_leads' and status = 'failed'/,
    );
  });

  it("records removed properties as non-retryable missing outcomes in every failure checkpoint", () => {
    const failureFunctions = migration.slice(
      migration.indexOf("create or replace function public.fail_promote_leads_item"),
      migration.indexOf("create or replace function public.retry_promote_leads_job"),
    );
    expect(failureFunctions.match(/property_id is null/g)).toHaveLength(3);
    expect(failureFunctions.match(/'outcome', 'missing', 'retryable', false/g)).toHaveLength(3);
    expect(failureFunctions.match(/property_id is not null/g)).toHaveLength(3);
  });

  it("ratchets concurrent property deletion over a retryable promotion failure", () => {
    expect(migration).toContain(
      "create or replace function public.preserve_promote_leads_item_on_property_delete()",
    );
    expect(migration).toMatch(
      /before delete on public\.properties[\s\S]+preserve_promote_leads_item_on_property_delete\(\)/,
    );
    expect(migration).toMatch(
      /ji\.status = 'error'[\s\S]+output_payload->>'retryable'[\s\S]+set status = 'skipped'/,
    );
    expect(migration).toMatch(/'outcome', 'missing', 'retryable', false, 'reason', 'property_removed'/);
  });

  it("pins ACLs so users create or retry while only service-role processes items", () => {
    expect(migration).toMatch(/revoke all on function public\.process_promote_leads_item[^;]+from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.process_promote_leads_item[^;]+to service_role/);
    expect(migration).toMatch(/grant execute on function public\.create_promote_leads_job[^;]+to authenticated/);
    expect(migration).toMatch(/grant execute on function public\.retry_promote_leads_job[^;]+to authenticated/);
    expect(migration).toMatch(/grant execute on function public\.fail_promote_leads_workflow\(uuid, uuid, text\)[^;]+to service_role/);
  });
});
