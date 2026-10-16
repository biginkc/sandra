import { createHash } from "node:crypto";

import type { Client } from "pg";

import { assertCanaryOrg, assertRunId, runTag } from "./d-lane-fixture";

/**
 * Run 7 (D lane): tag-only cleanup with a before/after proof.
 *
 * Tagged rows are defined ONLY by the run tag, inside the canary org:
 *   properties  org = canary AND address starts with `STRESS <runId> `
 *   contacts    org = canary AND last_name = `STRESS <runId>`
 *   any public table with property_id / contact_id: rows pointing at a tagged property or contact
 *   pipeline_run_steps: rows of a tagged pipeline run
 * Everything else is "untagged" and its count must be identical before and after. Nothing is deleted by org
 * alone, by date, or by id list from outside: a row the tag does not reach is never touched.
 */
export const MEASURED_TABLES = [
  "properties",
  "contacts",
  "messages",
  "pipeline_runs",
  "pipeline_run_steps",
  "sequence_enrollments",
  "sms_classification_runs",
  "hold_alert_deliveries",
  "ai_reply_drafts",
  "jev_lead_decisions",
  "ai_disposition_reviews",
  "consent_events",
] as const;

export type Snapshot = { at: string; tag: string; orgId: string; tables: Record<string, { total: number; tagged: number; untagged: number }>; sha256: string };

const TAGGED_PROPS = `select id from public.properties where org_id = $1 and starts_with(address, $2 || ' ')`;
const TAGGED_CONTACTS = `select id from public.contacts where org_id = $1 and last_name = $2`;

async function columnsOf(pg: Client, table: string): Promise<Set<string>> {
  const { rows } = await pg.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table]);
  return new Set(rows.map((r) => r.column_name as string));
}

/** SQL predicate (params $1 org, $2 tag) for "this row is tagged", or null when the table cannot carry the tag. */
async function taggedPredicate(pg: Client, table: string): Promise<string | null> {
  if (table === "properties") return `org_id = $1 and starts_with(address, $2 || ' ')`;
  if (table === "contacts") return `org_id = $1 and last_name = $2`;
  if (table === "pipeline_run_steps") return `run_id in (select id from public.pipeline_runs where property_id in (${TAGGED_PROPS}) or contact_id in (${TAGGED_CONTACTS}))`;
  const cols = await columnsOf(pg, table);
  const parts: string[] = [];
  if (cols.has("property_id")) parts.push(`property_id in (${TAGGED_PROPS})`);
  if (cols.has("contact_id")) parts.push(`contact_id in (${TAGGED_CONTACTS})`);
  return parts.length ? parts.join(" or ") : null;
}

export async function snapshot(pg: Client, orgId: string, runId: string): Promise<Snapshot> {
  assertCanaryOrg(orgId);
  assertRunId(runId);
  const tag = runTag(runId);
  const tables: Snapshot["tables"] = {};
  for (const t of MEASURED_TABLES) {
    const exists = await pg.query("select to_regclass($1) as r", [`public.${t}`]);
    if (!exists.rows[0].r) continue;
    const pred = await taggedPredicate(pg, t);
    const { rows } = await pg.query(
      `select count(*)::int as total, ${pred ? `count(*) filter (where ${pred})::int` : "0"} as tagged from public.${t}`,
      pred ? [orgId, tag] : [],
    );
    tables[t] = { total: rows[0].total, tagged: rows[0].tagged, untagged: rows[0].total - rows[0].tagged };
  }
  const body = JSON.stringify({ tag, orgId, tables });
  return { at: new Date().toISOString(), tag, orgId, tables, sha256: createHash("sha256").update(body).digest("hex") };
}

/** Deletes tagged rows only. Multi-pass so FK order does not matter; each statement runs under a savepoint. */
export async function deleteTagged(pg: Client, orgId: string, runId: string): Promise<{ deleted: Record<string, number>; passes: number }> {
  assertCanaryOrg(orgId);
  assertRunId(runId);
  const tag = runTag(runId);
  const { rows: tableRows } = await pg.query(
    "select distinct table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name) where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.column_name in ('property_id', 'contact_id')",
  );
  const dependents = tableRows.map((r) => r.table_name as string).filter((t) => t !== "properties" && t !== "contacts");
  const order = ["pipeline_run_steps", ...dependents, "properties", "contacts"];
  const deleted: Record<string, number> = {};
  let passes = 0;
  await pg.query("begin");
  try {
    for (; passes < 6; passes++) {
      let remaining = 0;
      for (const t of order) {
        const pred = await taggedPredicate(pg, t);
        if (!pred) continue;
        await pg.query("savepoint s");
        try {
          const res = await pg.query(`delete from public.${t} where ${pred}`, [orgId, tag]);
          deleted[t] = (deleted[t] ?? 0) + (res.rowCount ?? 0);
          await pg.query("release savepoint s");
        } catch {
          await pg.query("rollback to savepoint s");
          remaining++;
        }
      }
      if (remaining === 0) break;
    }
    await pg.query("commit");
  } catch (e) {
    await pg.query("rollback");
    throw e;
  }
  return { deleted, passes: passes + 1 };
}

export type CleanupVerdict = { ok: boolean; changedUntagged: string[]; taggedLeft: string[] };
export function compareSnapshots(before: Snapshot, after: Snapshot): CleanupVerdict {
  const changedUntagged = Object.keys(before.tables).filter((t) => before.tables[t].untagged !== after.tables[t]?.untagged);
  const taggedLeft = Object.keys(after.tables).filter((t) => after.tables[t].tagged !== 0);
  return { ok: changedUntagged.length === 0 && taggedLeft.length === 0, changedUntagged, taggedLeft };
}
