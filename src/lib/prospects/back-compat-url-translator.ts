/**
 * Back-compat URL translator: legacy chip params → FilterBlock[] stack.
 *
 * Translates the 5 chip params that page.tsx wires today (?vacant=, ?cass=,
 * ?engagement=, ?market=, ?assignee=) into the equivalent block stack the
 * new Phase 05 drawer renders. Used by Plan 09's prospects-query rewrite
 * when the page receives a request that has NO `?filters=` param but DOES
 * have one or more legacy chip params — typically a saved bookmark, a
 * Slack-shared deep link, or a stale browser tab from before the drawer
 * shipped.
 *
 * Contract:
 *  - Pure function — no I/O, no awaits, no side effects.
 *  - Accepts the same `Record<string, string | string[] | undefined>` shape
 *    Next.js 16 hands to the page (after `await searchParams`).
 *  - Returns `FilterBlock[]` in stable order: vacancy → cass → engagement
 *    → market → assignee. Stable order matters because the drawer renders
 *    blocks top-to-bottom in array order; bookmark replays should look
 *    identical run-to-run.
 *  - Each returned block carries a fresh client-generated UUID via
 *    `newBlockId()` — same primitive used by the drawer's "+ Add Block"
 *    flow so React keys remain unique across the whole stack.
 *  - Whitelist enforced on `cass` (only "verified" — the only value the
 *    legacy chip exposed). Garbage values silently produce no block.
 *  - Boolean coercion on `vacant`: only "1" or "true" count as on; other
 *    values (including "0", "false", "yes", garbage) drop the block.
 *  - The legacy "contacted" bucket loosely meant "we sent something" —
 *    SPEC §41-46 Engagement formalizes this as `attempted | replied` (the
 *    two non-opted-out, non-never-contacted buckets), so the translation
 *    emits both values under combinator: "any".
 *  - v1 only — once any saved bookmarks/links have aged out and the
 *    canonical-URL self-heal redirect is wired (Plan 09), this module can
 *    be deleted.
 */

import { newBlockId, type FilterBlock } from "./filter-schema";

type RawSearchParams = Record<string, string | string[] | undefined>;

function pickFirst(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function translateLegacyChipParams(raw: RawSearchParams): FilterBlock[] {
  const out: FilterBlock[] = [];

  // ?vacant=1 | ?vacant=true → vacancy: yes (anything else dropped)
  const vacantRaw = pickFirst(raw.vacant);
  if (vacantRaw === "1" || vacantRaw === "true") {
    out.push({ id: newBlockId(), kind: "vacancy", tri: "yes" });
  }

  // ?cass=verified → cass: any [verified] (whitelist; only value the legacy
  // chip exposed; garbage / unverified / invalid / ambiguous are dropped)
  const cassRaw = pickFirst(raw.cass);
  if (cassRaw === "verified") {
    out.push({
      id: newBlockId(),
      kind: "cass",
      combinator: "any",
      values: ["verified"],
    });
  }

  // ?engagement=contacted → engagement: any [attempted, replied]
  // The legacy "contacted" chip loosely meant "we sent something at any
  // point". The SPEC §41-46 Engagement block formalizes this as the two
  // non-opted-out, non-never-contacted buckets — we emit both.
  const engRaw = pickFirst(raw.engagement);
  if (engRaw === "contacted") {
    out.push({
      id: newBlockId(),
      kind: "engagement",
      combinator: "any",
      values: ["attempted", "replied"],
    });
  }

  // ?market=<value> → market: any [value]. Trim whitespace so a stray
  // trailing space in a bookmarked URL doesn't produce a non-matching
  // exact filter. Empty / whitespace-only collapses to no block.
  const marketRaw = pickFirst(raw.market)?.trim();
  if (marketRaw) {
    out.push({
      id: newBlockId(),
      kind: "market",
      combinator: "any",
      values: [marketRaw],
    });
  }

  // ?assignee=<uuid> | ?assignee=unassigned → assignee: any [<value>].
  // The applyAssigneeBlock helper handles the "unassigned" sentinel and
  // UUID list cases — we just pass the raw value through. Empty / whitespace
  // collapses to no block. UUID format is NOT validated here; if the
  // bookmark carries a stale UUID, RLS / .in() will simply match no rows.
  const assigneeRaw = pickFirst(raw.assignee)?.trim();
  if (assigneeRaw) {
    out.push({
      id: newBlockId(),
      kind: "assignee",
      combinator: "any",
      values: [assigneeRaw],
    });
  }

  return out;
}
