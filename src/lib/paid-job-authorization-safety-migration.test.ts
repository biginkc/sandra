import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260816070000_paid_job_authorization_safety.sql",
  ),
  "utf8",
);
const cassJobSource = readFileSync(
  join(process.cwd(), "src/lib/enrichment/cass-job.ts"),
  "utf8",
);
const jobsActionSource = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/jobs/actions.ts"),
  "utf8",
);
const leadsActionSource = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/leads/actions.ts"),
  "utf8",
);

describe("paid job authorization safety migration", () => {
  it("requires a durable authorization receipt before CASS can start", () => {
    expect(migration).toContain("create table if not exists public.cass_job_authorizations");
    expect(migration).toContain("CASS_JOB_AUTHORIZATION_REQUIRED");
    expect(migration).toContain("CASS_JOB_RECEIPT_REQUIRED");
    expect(migration).toMatch(
      /grant execute on function public\.create_authorized_cass_job[\s\S]+to authenticated, service_role/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.claim_authorized_cass_job_start[\s\S]+to authenticated, service_role/,
    );
    expect(migration).toContain("request_key uuid not null");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("p_request_key uuid");
    expect(migration).toContain("returns table(job_id uuid, claim_token uuid, created boolean, job_status text)");
  });

  it("durably fences each paid CASS property lookup and reuses saved provider output", () => {
    expect(migration).toContain(
      "create table if not exists public.cass_property_lookup_outcomes",
    );
    expect(migration).toContain("claim_cass_property_lookup");
    expect(migration).toContain("complete_cass_property_lookup");
    expect(migration).toContain("state in ('submitting', 'completed', 'retryable', 'ambiguous')");
    expect(migration).toContain("source_job_id");
    expect(migration).toMatch(
      /revoke all on public\.cass_property_lookup_outcomes from public, anon, authenticated/,
    );
  });

  it("atomically enforces the persisted CSV retry budget and active membership", () => {
    expect(migration).toContain("membership.access_status = 'active'");
    expect(migration).toContain("membership.deletion_prepared_at is null");
    expect(migration).toContain("membership.access_expires_at > now()");
    expect(migration).toContain("v_job.retry_count >= v_job.max_retries");
    expect(migration).toContain("job.retry_count < job.max_retries");
    expect(migration).toContain("return found");
    expect(migration).toContain("CSV_IMPORT_JOB_CONTROLLED_FIELDS");
    expect(migration).toContain(
      "before insert or update of type, status, retry_count, max_retries, error_class on public.jobs",
    );
    expect(migration).toContain("new.error_class is not null");
    expect(migration).toContain(
      "new.error_class is distinct from old.error_class",
    );
  });

  it("creates one request-keyed skip-trace retry child and validates its full target set", () => {
    expect(migration).toContain("create_skip_trace_retry_job");
    expect(migration).toContain("SKIP_TRACE_RETRY_TARGETS_MISMATCH");
    expect(migration).toContain("p_parent_job_id");
    expect(migration).toContain("idempotency_key");
    expect(migration).toMatch(
      /revoke all on function public\.create_skip_trace_retry_job\(uuid, uuid\[\]\)[\s\S]+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.create_skip_trace_retry_job\(uuid, uuid\[\]\) to service_role/,
    );
  });

  it("requires exact standalone replay targets while allowing an import replay to shrink", () => {
    expect(migration).toContain("p_purpose = 'import'");
    expect(migration).toContain("v_property_ids <@ v_existing.property_ids");
    expect(migration).toContain(
      "v_property_ids is distinct from v_existing.property_ids",
    );
  });

  it("allows only the false-to-true DNC ratchet, not piggyback mutations", () => {
    expect(migration).toContain("new.do_not_contact is true");
    expect(migration).toContain("old.do_not_contact is false");
    expect(migration).toContain(
      "to_jsonb(new) - array['do_not_contact', 'updated_at']",
    );
    expect(migration).toContain("DNC_RATCHET_ONLY");
  });

  it("pins each job item to both parent tenants with composite foreign keys", () => {
    expect(migration).toContain("alter table public.job_items add column if not exists org_id uuid");
    expect(migration).toContain("alter column org_id set default null");
    expect(migration).toContain("foreign key (job_id, org_id) references public.jobs(id, org_id)");
    expect(migration).toContain(
      "foreign key (property_id, org_id) references public.properties(id, org_id)",
    );
    expect(migration).toContain(
      "before insert or update of job_id, property_id, org_id on public.job_items",
    );
    expect(migration).toContain("on delete set null (property_id)");
    expect(migration).not.toContain(
      "references public.properties(id, org_id) on delete cascade",
    );
  });

  it("routes auto-start producers through atomic request-keyed create-and-claim receipts", () => {
    expect(cassJobSource).toContain('"create_authorized_cass_job"');
    expect(cassJobSource).toContain('"claim_authorized_cass_job_start"');
    expect(jobsActionSource).toContain("sourceJobId: failedJobId");
    expect(jobsActionSource).toContain("requestKey: failedJobId");
    expect(leadsActionSource).toContain("createStandaloneCassJob(supabase");
    expect(leadsActionSource).toContain("requestKey");
    expect(leadsActionSource).toContain("[{ jobId, claimToken }]");
  });

  it("keeps ambiguous paid results terminal across parent-import retries", () => {
    expect(cassJobSource).toContain(
      '["submission_unknown"]',
    );
    expect(cassJobSource).toContain("outcome.verified.raw as Json");
  });
});
