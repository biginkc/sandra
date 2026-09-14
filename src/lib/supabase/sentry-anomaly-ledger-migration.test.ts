import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260914120000_sentry_anomaly_ledger.sql"),
  "utf8",
).toLowerCase();

describe("Sentry anomaly ledger migration", () => {
  it("serializes concurrent observations on a stable signal and source key", () => {
    expect(migration).toContain("primary key (signal_kind, source_id)");
    expect(migration).toContain("on conflict (signal_kind, source_id) do nothing");
    expect(migration).toContain("for update");
  });

  it("limits the ledger and RPC to service role", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("revoke all on public.sentry_anomaly_ledger from public, anon, authenticated");
    expect(migration).toMatch(/revoke all on function public\.observe_sentry_anomaly[\s\S]*from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.observe_sentry_anomaly[\s\S]*to service_role/);
    expect(migration).toMatch(/revoke all on function public\.ack_sentry_anomaly[\s\S]*from public, anon, authenticated/);
    expect(migration).toContain("grant select on public.sentry_anomaly_ledger to service_role");
  });

  it("leases first, hourly repeat, and recovery only once, then acknowledges delivery", () => {
    expect(migration).toContain("'decision', 'new'");
    expect(migration).toContain("last_emit_at + interval '1 hour'");
    expect(migration).toContain("v_kind := 'repeat'");
    expect(migration).toContain("if not v_row.is_active then");
    expect(migration).toContain("v_kind := 'recovered'");
    expect(migration).toContain("claim_expires_at = p_observed_at + interval '2 minutes'");
    expect(migration).toContain("v_row.claim_token is distinct from p_claim_token");
    expect(migration).toContain("last_emit_at = case when p_delivered then pg_catalog.now() else last_emit_at end");
  });
});
