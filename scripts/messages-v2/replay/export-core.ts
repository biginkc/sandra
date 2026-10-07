import { PhoneMasker, assertNoRealPhones, last10 } from "./mask";
import {
  TABLES,
  type Query,
  type ReplayExport,
  type ReplayInbound,
  type ReplayTable,
} from "./schema";

export type ExportOptions = {
  batchId: string;
  days: number;
  contextDays: number;
  orgId?: string | null;
  now: Date;
  salt: string;
  /** Extra business numbers to leave unmasked (e.g. SENDILLO_FROM_NUMBER). */
  businessNumbers?: readonly string[];
  /** Mask contact names and emails deterministically. Default true. */
  maskPii?: boolean;
};

const NAME_COLUMNS: Record<string, "first" | "last" | "entity"> = { first_name: "first", last_name: "last", entity_name: "entity" };

const q = (cols: readonly string[]) => cols.map((c) => `"${c}"`).join(", ");

async function tableExists(query: Query, table: string): Promise<boolean> {
  const { rows } = await query("select to_regclass($1) is not null as present", [`public.${table}`]);
  return rows[0]?.present === true;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Build the replay export through `query`. READ-ONLY by construction: it only
 * issues SELECTs. The CLI additionally runs it inside `begin read only` with a
 * statement timeout (see runReadOnly in export.ts), so even a bug here could
 * not write.
 */
export async function buildExport(query: Query, opts: ExportOptions): Promise<ReplayExport> {
  const windowEnd = opts.now;
  const windowStart = new Date(windowEnd.getTime() - opts.days * 86_400_000);
  const contextStart = new Date(windowStart.getTime() - opts.contextDays * 86_400_000);

  // 1. Inbound SMS in the window (replayed), oldest first.
  const inboundRes = await query(
    `select m.id, m.org_id, m.external_id, m.from_address, m.to_address, m.body, m.created_at,
            m.contact_id, m.property_id, m.conversation_id
       from public.messages m
      where m.channel = 'sms' and m.direction = 'inbound'
        and m.created_at >= $1 and m.created_at < $2
        and ($3::uuid is null or m.org_id = $3::uuid)
      order by m.created_at asc, m.id asc`,
    [windowStart.toISOString(), windowEnd.toISOString(), opts.orgId ?? null],
  );
  const orgIds = [...new Set(inboundRes.rows.map((r) => String(r.org_id)))];
  if (orgIds.length > 1) {
    throw new Error(`inbound messages span ${orgIds.length} orgs; pass --org <uuid>`);
  }
  const sourceOrgId = opts.orgId ?? orgIds[0] ?? null;
  if (!sourceOrgId) throw new Error("no inbound SMS in the window and no --org given; nothing to export");

  const contactIds = new Set<string>();
  const propertyIds = new Set<string>();
  const conversationIds = new Set<string>();
  for (const r of inboundRes.rows) {
    if (r.contact_id) contactIds.add(String(r.contact_id));
    if (r.property_id) propertyIds.add(String(r.property_id));
    if (r.conversation_id) conversationIds.add(String(r.conversation_id));
  }

  // 2. Baseline context: SMS history in the same threads BEFORE the window.
  const baselineRes = conversationIds.size
    ? await query(
        `select ${q(TABLES.messages.columns)} from public.messages
          where org_id = $1 and channel = 'sms' and conversation_id = any($2::uuid[])
            and created_at >= $3 and created_at < $4
          order by created_at asc, id asc`,
        [sourceOrgId, [...conversationIds], contextStart.toISOString(), windowStart.toISOString()],
      )
    : { rows: [] };
  for (const r of baselineRes.rows) {
    if (r.contact_id) contactIds.add(String(r.contact_id));
    if (r.property_id) propertyIds.add(String(r.property_id));
  }

  // 3. Reference only (never seeded): what really happened in the window.
  const outboundRef = conversationIds.size
    ? await query(
        `select id, conversation_id, direction, status, provider, created_at
           from public.messages
          where org_id = $1 and channel = 'sms' and direction = 'outbound'
            and conversation_id = any($2::uuid[]) and created_at >= $3 and created_at < $4
          order by created_at asc, id asc`,
        [sourceOrgId, [...conversationIds], windowStart.toISOString(), windowEnd.toISOString()],
      )
    : { rows: [] };
  const pipelineRef =
    inboundRes.rows.length && (await tableExists(query, "pipeline_runs"))
      ? await query(
          `select id, inbound_message_id, status, mode, final_outcome, reason
             from public.pipeline_runs where org_id = $1 and inbound_message_id = any($2::uuid[])`,
          [sourceOrgId, inboundRes.rows.map((r) => r.id)],
        )
      : { rows: [] };

  // 4. Context rows.
  const fetched: Partial<Record<ReplayTable, Record<string, unknown>[]>> = { messages: baselineRes.rows };
  const ids = (s: Set<string>) => [...s];

  fetched.contacts = contactIds.size
    ? (await query(`select ${q(TABLES.contacts.columns)} from public.contacts where org_id = $1 and id = any($2::uuid[]) order by id`, [sourceOrgId, ids(contactIds)])).rows
    : [];
  fetched.properties = propertyIds.size
    ? (await query(`select ${q(TABLES.properties.columns)} from public.properties where org_id = $1 and id = any($2::uuid[]) order by id`, [sourceOrgId, ids(propertyIds)])).rows
    : [];
  // A property's homeowner contact may sit outside the exported contacts: drop the pointer.
  for (const p of fetched.properties) {
    if (p.homeowner_contact_id && !contactIds.has(String(p.homeowner_contact_id))) p.homeowner_contact_id = null;
  }
  fetched.property_contacts = propertyIds.size
    ? (await query(`select ${q(TABLES.property_contacts.columns)} from public.property_contacts where org_id = $1 and property_id = any($2::uuid[]) and contact_id = any($3::uuid[]) order by property_id, relationship, source_identity`, [sourceOrgId, ids(propertyIds), ids(contactIds)])).rows
    : [];
  fetched.message_threads = contactIds.size
    ? (await query(`select ${q(TABLES.message_threads.columns)} from public.message_threads where org_id = $1 and channel = 'sms' and contact_id = any($2::uuid[]) and property_id = any($3::uuid[]) order by id`, [sourceOrgId, ids(contactIds), ids(propertyIds)])).rows
    : [];
  fetched.consent_events = contactIds.size
    ? (await query(`select ${q(TABLES.consent_events.columns)} from public.consent_events where org_id = $1 and contact_id = any($2::uuid[]) and occurred_at < $3 order by occurred_at, id`, [sourceOrgId, ids(contactIds), windowStart.toISOString()])).rows
    : [];

  // Suppressions: any phone belonging to an exported contact (matched on last 10 digits).
  const sellerDigits = new Set<string>();
  for (const c of fetched.contacts) {
    for (const col of TABLES.contacts.phoneColumns ?? []) {
      const d = last10(c[col] as string | null);
      if (d) sellerDigits.add(d);
    }
  }
  for (const r of inboundRes.rows) {
    const d = last10(r.from_address as string | null);
    if (d) sellerDigits.add(d);
  }
  const suppressionRes = sellerDigits.size
    ? await query(`select ${q(TABLES.sms_phone_suppressions.columns)} from public.sms_phone_suppressions where org_id = $1 and right(regexp_replace(phone_e164, '\\D', '', 'g'), 10) = any($2::text[]) and suppressed_at < $3 order by id`, [sourceOrgId, [...sellerDigits], windowStart.toISOString()])
    : { rows: [] };
  fetched.sms_phone_suppressions = suppressionRes.rows;

  fetched.ai_responder_configs = (await tableExists(query, "ai_responder_configs"))
    ? (await query(`select ${q(TABLES.ai_responder_configs.columns)} from public.ai_responder_configs where org_id = $1 order by id`, [sourceOrgId])).rows
    : [];
  fetched.jev_outcome_thresholds = (await tableExists(query, "jev_outcome_thresholds"))
    ? (await query(`select ${q(TABLES.jev_outcome_thresholds.columns)} from public.jev_outcome_thresholds where org_id = $1 order by id`, [sourceOrgId])).rows
    : [];

  // 5. Business numbers: our own senders (inbound `to`, outbound `from`) stay as-is.
  const business = new Set<string>();
  for (const r of inboundRes.rows) if (last10(r.to_address as string)) business.add(last10(r.to_address as string)!);
  for (const r of baselineRes.rows) {
    const mine = r.direction === "inbound" ? r.to_address : r.from_address;
    if (last10(mine as string)) business.add(last10(mine as string)!);
  }
  for (const n of opts.businessNumbers ?? []) if (last10(n)) business.add(last10(n)!);
  // A "business" number that is also a contact phone is a seller; never keep those.
  for (const d of sellerDigits) business.delete(d);

  // 6. Mask. Prime the masker with every real seller number in sorted order so
  //    collision probing is independent of query order.
  const masker = new PhoneMasker(opts.salt, [...business], opts.maskPii !== false);
  for (const d of [...sellerDigits].sort()) masker.mask(d);

  const maskRow = (table: ReplayTable, row: Record<string, unknown>) => {
    const spec = TABLES[table];
    const out: Record<string, unknown> = {};
    for (const col of spec.columns) {
      if (spec.nullColumns?.includes(col)) {
        out[col] = null;
        continue;
      }
      const nameKind = table === "contacts" ? NAME_COLUMNS[col] : undefined;
      if (nameKind) {
        out[col] = masker.maskName(nameKind, row[col] as string | null);
        continue;
      }
      out[col] = maskValue(
        row[col],
        spec.phoneColumns?.includes(col) ?? false,
        spec.rawColumns?.includes(col) ?? false,
        masker,
      );
    }
    return out;
  };

  const tables = {} as ReplayExport["tables"];
  for (const t of Object.keys(TABLES) as ReplayTable[]) {
    tables[t] = (fetched[t] ?? []).map((r) => maskRow(t, r));
  }
  // The replay org's own email/identity is not exported; metadata is reduced to routing hints.
  for (const m of tables.messages) m.metadata = reduceMetadata(m.metadata);

  const inbound: ReplayInbound[] = inboundRes.rows.map((r) => ({
    id: String(r.id),
    externalId: String(r.external_id ?? r.id),
    from: masker.maskOrKeep(r.from_address as string) ?? String(r.from_address),
    to: String(r.to_address),
    body: masker.maskText(String(r.body ?? "")),
    receivedAt: iso(r.created_at),
    contactId: (r.contact_id as string | null) ?? null,
    propertyId: (r.property_id as string | null) ?? null,
    conversationId: (r.conversation_id as string | null) ?? null,
  }));

  const result: ReplayExport = {
    version: 1,
    batchId: opts.batchId,
    createdAt: opts.now.toISOString(),
    sourceOrgId,
    window: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      days: opts.days,
      contextDays: opts.contextDays,
    },
    businessNumbers: [...business].sort().map((d) => `+1${d}`),
    tables,
    inbound,
    reference: {
      pipelineRuns: pipelineRef.rows.map((r) => scrub(r, masker)),
      outboundInWindow: outboundRef.rows.map((r) => scrub(r, masker)),
    },
    counts: {
      inbound: inbound.length,
      ...Object.fromEntries((Object.keys(tables) as ReplayTable[]).map((t) => [t, tables[t].length])),
      referencePipelineRuns: pipelineRef.rows.length,
      referenceOutbound: outboundRef.rows.length,
    },
  };

  // Last line of defence: fail closed if any real phone survived.
  assertNoRealPhones({ ...result, businessNumbers: undefined }, business, { maskPii: opts.maskPii !== false });
  return result;
}

function scrub(row: Record<string, unknown>, masker: PhoneMasker): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, maskValue(v, false, k === "id" || k.endsWith("_id"), masker)]));
}

function maskValue(value: unknown, isPhone: boolean, raw: boolean, masker: PhoneMasker): unknown {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return masker.maskNumber(value);
  if (typeof value === "string") {
    if (isPhone) return masker.maskOrKeep(value);
    return raw ? value : masker.maskText(value);
  }
  if (Array.isArray(value)) return value.map((v) => maskValue(v, false, false, masker));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskValue(v, false, false, masker)]),
    );
  }
  return value;
}

/** Keep only routing hints from message metadata (provider payloads can carry phones/handles). */
function reduceMetadata(meta: unknown): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const key of ["routing", "keyword", "source"]) if (key in m) keep[key] = m[key];
  return Object.keys(keep).length ? keep : null;
}
