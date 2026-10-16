import { createHash } from "node:crypto";

import { SEED_ORDER, TABLES, type Query, type ReplayExport, type ReplayTable } from "./schema";

/** Deterministic replay-org id for a batch (uuid-v5 style over a fixed namespace string). */
export function replayOrgId(batchId: string): string {
  const h = createHash("sha1").update(`messages-v2-replay-org:${batchId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const REPLAY_ORG_NAME_PREFIX = "Replay ";

const CONFLICT: Record<ReplayTable, string> = {
  contacts: "on conflict (id) do nothing",
  properties: "on conflict (id) do nothing",
  property_contacts: "on conflict do nothing",
  message_threads: "on conflict do nothing",
  messages: "on conflict (id) do nothing",
  sms_phone_suppressions: "on conflict do nothing",
  consent_events: "on conflict do nothing",
  ai_responder_configs: "",
  jev_outcome_thresholds: "",
};

/** Tables whose rows are replaced wholesale for the replay org (config, not history). */
const REPLACE_TABLES: ReadonlySet<ReplayTable> = new Set(["ai_responder_configs", "jev_outcome_thresholds"]);

function tagId(table: ReplayTable, row: Record<string, unknown>): string {
  if (table === "property_contacts") return `${row.property_id}|${row.relationship}|${row.source_identity}`;
  return String(row.id);
}

export type SeedOptions = {
  ownerUserId?: string | null;
  /** Default false: the replay zeroes the AI reply delay so runs finish promptly. */
  keepReplyDelay?: boolean;
};

export type SeedSummary = {
  batchId: string;
  orgId: string;
  inserted: Record<string, number>;
  tagged: number;
  warnings: string[];
};

async function tableExists(query: Query, table: string): Promise<boolean> {
  const { rows } = await query("select to_regclass($1) is not null as present", [`public.${table}`]);
  return rows[0]?.present === true;
}

/**
 * Load an export into the (local/test) database under the batch's replay org.
 * Caller owns the transaction. Idempotent: re-running changes nothing, and every
 * seeded row is tagged in replay_row_tags so --wipe can prove nothing is left.
 */
export async function seedExport(query: Query, exp: ReplayExport, opts: SeedOptions = {}): Promise<SeedSummary> {
  if (!(await tableExists(query, "replay_batches"))) {
    throw new Error("replay_batches is missing: apply migration 20261008180000_replay_harness.sql to the target database first");
  }
  const orgId = replayOrgId(exp.batchId);
  const warnings: string[] = [];

  await query(
    `insert into public.organizations (id, name) values ($1, $2) on conflict (id) do nothing`,
    [orgId, `${REPLAY_ORG_NAME_PREFIX}${exp.batchId}`],
  );
  await query(
    `insert into public.replay_batches (id, org_id, source_label, window_start, window_end, inbound_count)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set source_label = excluded.source_label, window_start = excluded.window_start,
       window_end = excluded.window_end, inbound_count = excluded.inbound_count`,
    [exp.batchId, orgId, `production replay ${exp.window.start.slice(0, 10)}..${exp.window.end.slice(0, 10)}`, exp.window.start, exp.window.end, exp.inbound.length],
  );

  const inserted: Record<string, number> = {};
  let tagged = 0;
  for (const table of SEED_ORDER) {
    const spec = TABLES[table];
    const rows = exp.tables[table] ?? [];
    if (rows.length === 0) {
      inserted[table] = 0;
      continue;
    }
    if (spec.optional && !(await tableExists(query, table))) {
      warnings.push(`${table}: not present in the target database; skipped`);
      inserted[table] = 0;
      continue;
    }
    const remapped = rows.map((r): Record<string, unknown> => {
      const row: Record<string, unknown> = { ...r, org_id: orgId };
      if (table === "ai_responder_configs" && !opts.keepReplyDelay) {
        row.reply_delay_min_seconds = 0;
        row.reply_delay_max_seconds = 0;
      }
      return row;
    });

    // Never adopt a row that already lives in a real (non-replay) org.
    if (table === "contacts" || table === "properties" || table === "messages") {
      const { rows: clash } = await query(
        `select count(*)::int as n from public.${table}
          where id = any($1::uuid[]) and org_id <> $2
            and org_id not in (select org_id from public.replay_batches)`,
        [remapped.map((r) => r.id), orgId],
      );
      if (Number(clash[0]?.n) > 0) {
        throw new Error(`${table}: ${clash[0].n} exported id(s) already exist in a non-replay org; refusing to seed into a database holding real data`);
      }
    }

    if (REPLACE_TABLES.has(table)) {
      await query(`delete from public.${table} where org_id = $1`, [orgId]);
    }
    const cols = spec.columns.map((c) => `"${c}"`).join(", ");
    const res = await query(
      `with ins as (
         insert into public.${table} (${cols})
         select ${cols} from json_populate_recordset(null::public.${table}, $1::json)
         ${CONFLICT[table]}
         returning 1
       ) select count(*)::int as n from ins`,
      [JSON.stringify(remapped)],
    );
    inserted[table] = Number(res.rows[0]?.n ?? 0);

    const ids = remapped.map((r) => tagId(table, r));
    await query(
      `insert into public.replay_row_tags (batch_id, table_name, row_id)
       select $1, $2, unnest($3::text[]) on conflict do nothing`,
      [exp.batchId, table, ids],
    );
    tagged += ids.length;
  }

  if (exp.tables.ai_responder_configs.length === 0) {
    warnings.push("export carried no ai_responder_configs row: the AI responder will not run for the replay org");
  }

  if (opts.ownerUserId) {
    const { rows: u } = await query(`select 1 from auth.users where id = $1`, [opts.ownerUserId]);
    if (u.length === 0) throw new Error(`--owner-user ${opts.ownerUserId} does not exist in auth.users of the target database`);
    await query(
      `insert into public.memberships (org_id, user_id, role, access_status)
       values ($1, $2, 'owner', 'active') on conflict do nothing`,
      [orgId, opts.ownerUserId],
    );
  }

  return { batchId: exp.batchId, orgId, inserted, tagged, warnings };
}

export type WipeSummary = { batchId: string; orgId: string; deletedRows: number; passes: number; leftoverTagged: number };

/**
 * Remove everything a replay batch created or seeded: every row in the replay
 * org (including rows the replay run itself produced), then the org and the
 * batch. Scoped strictly to the batch's own org, and refuses an org that is not
 * named "Replay <batch>". Caller owns the transaction.
 */
export async function wipeBatch(query: Query, batchId: string): Promise<WipeSummary> {
  const { rows } = await query(
    `select b.org_id, o.name from public.replay_batches b join public.organizations o on o.id = b.org_id where b.id = $1`,
    [batchId],
  );
  if (rows.length === 0) throw new Error(`no replay batch "${batchId}" in this database`);
  const orgId = String(rows[0].org_id);
  if (String(rows[0].name) !== `${REPLAY_ORG_NAME_PREFIX}${batchId}`) {
    throw new Error(`refusing to wipe: org ${orgId} is not named "${REPLAY_ORG_NAME_PREFIX}${batchId}"`);
  }

  const { rows: tableRows } = await query(
    `select c.table_name
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'
        and c.table_name not in ('organizations', 'replay_batches')
      order by c.table_name`,
  );
  let pending = tableRows.map((r) => String(r.table_name));
  let deletedRows = 0;
  let passes = 0;
  // Delete with foreign keys enforced; a table blocked by a child is retried
  // after the other tables have been cleared (no superuser / replica mode needed).
  while (pending.length > 0 && passes < 25) {
    passes += 1;
    const blocked: string[] = [];
    for (const table of pending) {
      await query("savepoint replay_wipe");
      try {
        const res = await query(`with d as (delete from public."${table}" where org_id = $1 returning 1) select count(*)::int as n from d`, [orgId]);
        deletedRows += Number(res.rows[0]?.n ?? 0);
        await query("release savepoint replay_wipe");
      } catch (error) {
        await query("rollback to savepoint replay_wipe");
        const code = (error as { code?: string }).code;
        if (code === "23503" || code === "23001") blocked.push(table);
        else throw error;
      }
    }
    if (blocked.length === pending.length) {
      throw new Error(`wipe stuck: foreign keys keep blocking ${blocked.join(", ")}`);
    }
    pending = blocked;
  }
  if (pending.length > 0) throw new Error(`wipe did not converge: ${pending.join(", ")}`);

  // Proof, BEFORE the batch row (and with it the tags) goes away: no tagged row may remain.
  const leftoverTagged = await countTaggedRowsPresent(query, batchId);
  if (leftoverTagged > 0) throw new Error(`wipe left ${leftoverTagged} tagged row(s) behind; rolled back`);

  await query(`delete from public.replay_batches where id = $1`, [batchId]); // cascades tags + outbound log
  await query(`delete from public.organizations where id = $1`, [orgId]);

  return { batchId, orgId, deletedRows, passes, leftoverTagged };
}

/** Rows still present for tagged ids (used by the integration test and the wipe CLI proof). */
export async function countTaggedRowsPresent(query: Query, batchId: string): Promise<number> {
  const { rows } = await query(`select table_name, array_agg(row_id) as ids from public.replay_row_tags where batch_id = $1 group by 1`, [batchId]);
  let present = 0;
  for (const r of rows) {
    const table = String(r.table_name) as ReplayTable;
    const ids = r.ids as string[];
    if (table === "property_contacts") {
      const res = await query(
        `select count(*)::int as n from public.property_contacts where (property_id::text || '|' || relationship || '|' || source_identity) = any($1::text[])`,
        [ids],
      );
      present += Number(res.rows[0].n);
    } else {
      const res = await query(`select count(*)::int as n from public.${table} where id::text = any($1::text[])`, [ids]);
      present += Number(res.rows[0].n);
    }
  }
  return present;
}
