import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(process.cwd(), "supabase", rel), "utf8");
const up = read("migrations/20261014130000_rep_sms_inbound_stamp.sql");
const down = read("rollbacks/20261014130000_rep_sms_inbound_stamp.sql");

// Behaviour (first writer wins, org scoped, authenticated denied, idempotent, rollback) was
// exercised on a scratch Postgres 16; these pin the contract so it cannot drift silently.
describe("rep SMS inbound stamp migration", () => {
  it("adds nullable columns to the obligation and the delivery-ledger draft only", () => {
    expect(up).toMatch(/alter table public\.rep_sms_obligations\s+add column if not exists inbound_message_id uuid;/);
    expect(up).toMatch(/alter table public\.rep_sms_delivery_ledger\s+add column if not exists inbound_message_id uuid;/);
    expect(up).not.toMatch(/not null\s*;/i);
  });
  it("binds first-writer-wins inside the caller's org and exposes it to service_role only", () => {
    expect(up).toContain("and inbound_message_id is null");
    expect(up.match(/org_id = p_org_id/g)?.length).toBeGreaterThanOrEqual(4);
    expect(up).toMatch(/revoke all on function public\.fn_bind_rep_sms_inbound_stamp\(text,uuid,uuid,uuid\)\s+from public, anon, authenticated;/);
    expect(up).toMatch(/grant execute on function public\.fn_bind_rep_sms_inbound_stamp\(text,uuid,uuid,uuid\)\s+to service_role;/);
  });
  it("replaces no existing function and the rollback undoes exactly what was added", () => {
    expect(up.match(/create or replace function/g)).toHaveLength(1);
    expect(down).toContain("drop function if exists public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid);");
    expect(down).toContain("alter table public.rep_sms_delivery_ledger drop column if exists inbound_message_id;");
    expect(down).toContain("alter table public.rep_sms_obligations drop column if exists inbound_message_id;");
  });
});
