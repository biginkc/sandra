import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const forward = readFileSync(
  new URL(
    "../../../supabase/migrations/20261031120000_homeowner_from_property_links.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollback = readFileSync(
  new URL(
    "../../../supabase/rollbacks/20261031120000_homeowner_from_property_links.sql",
    import.meta.url,
  ),
  "utf8",
);

const EXCLUDED_DISPOS =
  /outreach_dispo not in \('wrong_number', 'bad_number', 'dnc', 'opted_out'\)/;

describe("homeowner from property links migration", () => {
  it("is a single transaction with lock and statement timeouts", () => {
    expect(forward).toMatch(/^[\s\S]*?begin;[\s\S]*commit;\s*$/i);
    expect(forward).toContain("set local lock_timeout = '5s';");
    expect(forward).toMatch(/set local statement_timeout = '\d+s';/);
  });

  it("picks the newest inbound texter, then the first link, and never a do-not-contact or training person", () => {
    const resolver = forward.slice(
      forward.indexOf("create or replace function public.resolve_homeowner_from_links"),
      forward.indexOf("create or replace function public.fill_homeowner_from_links"),
    );
    expect(resolver).toMatch(/m\.direction = 'inbound'[\s\S]*m\.channel = 'sms'[\s\S]*order by m\.created_at desc/);
    expect(resolver).toMatch(/order by pc\.source_position asc, pc\.created_at asc/);
    // The texter must be linked to this lead; a stray message never picks a stranger.
    expect(resolver).toMatch(/exists \(\s*select 1 from public\.property_contacts pc[\s\S]*?pc\.contact_id = m\.contact_id/);
    expect(resolver.match(/not coalesce\(c\.do_not_contact, false\)/g)).toHaveLength(2);
    expect(resolver.match(/not public\.is_training_target\(null, /g)).toHaveLength(2);
    expect(resolver).toContain("stable");
  });

  it("fills only an empty homeowner on a contactable, unlocked, live lead, with the contact row locked first", () => {
    const fill = forward.slice(
      forward.indexOf("create or replace function public.fill_homeowner_from_links"),
      forward.indexOf("revoke all on function public.resolve_homeowner_from_links"),
    );
    expect(fill).toContain("p.homeowner_contact_id is null");
    expect(fill).toContain("p.deleted_at is null");
    expect(fill).toContain("not p.is_dnc_locked");
    expect(fill).toContain("not p.is_training");
    expect(fill).toMatch(EXCLUDED_DISPOS);
    // The candidate contact is locked FOR SHARE and re-checked on its newest
    // version, so a do_not_contact flip racing the write is skipped instead of
    // permanently DNC-locking the lead.
    expect(fill).toMatch(/from public\.contacts c\s+where c\.id = public\.resolve_homeowner_from_links\(p_property_id, p_org_id\)\s+and c\.org_id = p_org_id\s+and not c\.do_not_contact\s+for share\s*\)/);
  });

  it("locks the helpers down to the service role", () => {
    for (const fn of ["resolve_homeowner_from_links", "fill_homeowner_from_links"]) {
      expect(forward).toContain(
        `revoke all on function public.${fn}(uuid, uuid) from public, anon, authenticated;`,
      );
      expect(forward).toContain(`grant execute on function public.${fn}(uuid, uuid) to service_role;`);
    }
  });

  it("has both import functions fill the homeowner on every exit", () => {
    for (const fn of ["upsert_dealmachine_property_contact", "upsert_assigns_property_contact"]) {
      const start = forward.indexOf(`create or replace function public.${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const end = forward.indexOf("$$;", forward.indexOf("as $$", start)) + 3;
      const body = forward.slice(start, end);
      const returns = body.match(/return v_contact_id;/g) ?? [];
      const fills = body.match(/perform public\.fill_homeowner_from_links\(p_property_id, p_org_id\);\s*return v_contact_id;/g) ?? [];
      expect(returns).toHaveLength(2);
      expect(fills).toHaveLength(2);
    }
  });

  it("keeps the import functions' identity, dedup and DNC behaviour unchanged", () => {
    // Behaviour that existed before this migration and must survive it verbatim.
    expect(forward).toContain("perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':dealmachine:' || p_source_identity, 0));");
    expect(forward).toContain("if p_source_identity !~ '^[^:]+:[1-8]:[0-9a-f]{8}$' then");
    expect(forward.match(/update public\.contacts set do_not_contact = true where id = v_contact_id and org_id = p_org_id and do_not_contact = false;/g)).toHaveLength(2);
    expect(forward).toMatch(/relationship = 'dealmachine_contact'/);
    expect(forward).toMatch(/relationship = 'assigns_contact'/);
  });

  it("keeps the ledger free of a foreign key to properties (a table-level lock for the whole migration)", () => {
    const table = forward.slice(
      forward.indexOf("create table public.homeowner_link_backfill"),
      forward.indexOf("alter table public.homeowner_link_backfill enable row level security;"),
    );
    expect(table).toMatch(/property_id uuid primary key,/);
    expect(table).not.toMatch(/references/i);
    expect(forward).toContain("alter table public.homeowner_link_backfill enable row level security;");
    expect(forward).toContain("revoke all on public.homeowner_link_backfill from public, anon, authenticated;");
  });

  it("resolves, writes and records the backfill in one statement from RETURNING, with every guard on the write", () => {
    const backfill = forward.slice(forward.indexOf("with candidate as ("));
    const candidate = backfill.slice(0, backfill.indexOf("written as ("));
    const written = backfill.slice(backfill.indexOf("written as ("), backfill.indexOf("insert into public.homeowner_link_backfill"));
    // The candidate contact is locked FOR SHARE (contact before property) and
    // its do_not_contact flag re-checked on the newest row version, so a flip
    // racing the write is skipped instead of permanently DNC-locking the lead.
    expect(candidate).toMatch(/join public\.contacts c on c\.id = r\.contact_id and c\.org_id = p\.org_id/);
    expect(candidate).toMatch(/and not c\.do_not_contact\s+for share of c\s*\)/);
    expect(written).toMatch(/update public\.properties p\s+set homeowner_contact_id = c\.contact_id\s+from candidate c/);
    expect(written).toContain("p.homeowner_contact_id is null");
    expect(written).toContain("p.deleted_at is null");
    expect(written).toContain("not p.is_dnc_locked");
    expect(written).toContain("not p.is_training");
    expect(written).toMatch(EXCLUDED_DISPOS);
    expect(written).toMatch(/returning p\.id, p\.org_id, p\.homeowner_contact_id\s*\)\s*$/);
    expect(backfill).toMatch(/insert into public\.homeowner_link_backfill \(property_id, org_id, contact_id\)\s+select id, org_id, homeowner_contact_id from written;/);
    // Nothing between the write and the record: no separate insert, no reconciliation delete.
    expect(backfill).not.toContain("delete from public.homeowner_link_backfill");
  });

  it("rolls back only its own writes and restores the prior import functions", () => {
    expect(rollback).toMatch(/^[\s\S]*?begin;[\s\S]*commit;\s*$/i);
    expect(rollback).toMatch(/set homeowner_contact_id = null\s+from public\.homeowner_link_backfill b[\s\S]*p\.homeowner_contact_id = b\.contact_id/);
    // Leads that became DNC-locked since the backfill are read-only: skipped,
    // reported, and their ledger rows kept; the table goes only when empty.
    expect(rollback).toMatch(/p\.homeowner_contact_id = b\.contact_id and p\.is_dnc_locked/);
    expect(rollback).toMatch(/raise notice 'homeowner_from_property_links rollback: % backfilled lead\(s\) are now DNC-locked/);
    expect(rollback).toMatch(/else\s+drop table public\.homeowner_link_backfill;\s+end if;/);
    expect(rollback).toContain("drop function if exists public.fill_homeowner_from_links(uuid, uuid);");
    expect(rollback).toContain("drop function if exists public.resolve_homeowner_from_links(uuid, uuid);");
    expect(rollback).not.toContain("fill_homeowner_from_links(p_property_id, p_org_id)");
    expect(rollback).toContain("create or replace function public.upsert_dealmachine_property_contact(");
    expect(rollback).toContain("create or replace function public.upsert_assigns_property_contact(");
  });
});
