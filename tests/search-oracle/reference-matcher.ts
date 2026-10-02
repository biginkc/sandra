// Naive reference for Search matching semantics (PLAN.md section 1). Written from the plan's
// stated semantics plus the tokenization/linkage SQL only; deliberately unoptimised.
import type { OracleFixture, OracleMembership, OracleProperty, OracleContact } from "./types";

export interface MatchOptions {
  /** Fixed clock for membership expiry. Default: Date.now(). */
  now?: Date;
  /** Plan section 1 has no is_training filter (stress #1 says training "never"). Default false = section 1 literal. */
  excludeTraining?: boolean;
}

const MAX_TOKENS = 6;

/** Postgres btrim(x) with no characters argument strips spaces only. */
function btrimSpaces(s: string): string {
  return s.replace(/^ +/, "").replace(/ +$/, "");
}

/** left(btrim(q),100); codepoint-based like Postgres. */
export function normalizeQuery(q: string | null | undefined): string {
  return Array.from(btrimSpaces(q ?? "").replace(/\s+/g, " ")).slice(0, 100).join("");
}

const digitsOnly = (s: string | null) => (s ?? "").replace(/[^0-9]/g, "");

export function propertySearchText(p: OracleProperty): string {
  return [p.address, p.city, p.state, p.zip, p.market, p.apn, p.mls_number].map((x) => x ?? "").join(" ").toLowerCase();
}
export function contactSearchText(c: OracleContact): string {
  return [c.first_name, c.last_name, c.entity_name, c.email].map((x) => x ?? "").join(" ").toLowerCase();
}

/** Tokens of search_prefix_tsquery / the messages.fts document: lowercase, non-alnum -> space, split. */
export function tokenize(text: string | null | undefined): string[] {
  return (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((t) => t !== "");
}

/** null when the SQL returns null: no token has length >= 3. First 6 tokens are ANDed as prefixes (short ones included). */
export function prefixQueryTokens(q: string): string[] | null {
  const tokens = tokenize(q).slice(0, MAX_TOKENS);
  return tokens.some((t) => Array.from(t).length >= 3) ? tokens : null;
}

function messageMatches(body: string | null, qTokens: string[]): boolean {
  const docTokens = tokenize(body);
  return qTokens.every((qt) => docTokens.some((dt) => dt.startsWith(qt)));
}

export function visibleOrgIds(memberships: OracleMembership[], userId: string | null, now: Date): Set<string> {
  const out = new Set<string>();
  if (!userId) return out;
  for (const m of memberships) {
    if (m.user_id !== userId || m.access_status !== "active" || m.deletion_prepared_at !== null) continue;
    if (m.access_expires_at !== null && !(new Date(m.access_expires_at).getTime() > now.getTime())) continue;
    out.add(m.org_id);
  }
  return out;
}

export function referenceMatch(
  fixture: OracleFixture,
  query: { q: string; includeMessages: boolean },
  userId: string | null,
  opts: MatchOptions = {},
): Set<string> {
  const result = new Set<string>();
  const now = opts.now ?? new Date();
  const orgs = visibleOrgIds(fixture.memberships, userId, now);
  const q = normalizeQuery(query.q);
  if (Array.from(q).length < 3 || orgs.size === 0) return result;

  const qLower = q.toLowerCase();
  let qd = digitsOnly(q);
  if (qd.length === 11 && qd.startsWith("1")) qd = qd.slice(1); // coordinator ruling: drop US country code
  const live = (p: OracleProperty) =>
    p.deleted_at === null && orgs.has(p.org_id) && !(opts.excludeTraining && p.is_training);
  const propsById = new Map(fixture.properties.map((p) => [p.id, p]));
  const candidates = new Set<string>();

  for (const p of fixture.properties) {
    if (orgs.has(p.org_id) && propertySearchText(p).includes(qLower)) candidates.add(p.id);
  }

  const matchedContacts = new Map<string, OracleContact>();
  for (const c of fixture.contacts) {
    if (!orgs.has(c.org_id)) continue;
    const nameHit = contactSearchText(c).includes(qLower);
    const phoneHit = qd.length >= 3 && [c.phone_1, c.phone_2, c.phone_3].some((ph) => digitsOnly(ph).includes(qd));
    if (nameHit || phoneHit) matchedContacts.set(c.id, c);
  }
  for (const p of fixture.properties) {
    for (const cid of [p.homeowner_contact_id, p.agent_contact_id]) {
      const c = cid ? matchedContacts.get(cid) : undefined;
      if (!c) continue;
      if (c.org_id !== p.org_id) continue; // coordinator ruling: same-org only
      candidates.add(p.id);
    }
  }

  const qTokens = query.includeMessages ? prefixQueryTokens(q) : null;
  if (qTokens) {
    for (const m of fixture.messages) {
      if (!orgs.has(m.org_id) || m.channel !== "sms" || m.conversation_id === null || m.property_id === null) continue;
      const p = propsById.get(m.property_id);
      if (!p || p.org_id !== m.org_id) continue; // linkage: message.property_id with same org
      if (messageMatches(m.body, qTokens)) candidates.add(p.id);
    }
  }

  for (const id of candidates) {
    const p = propsById.get(id);
    if (p && live(p)) result.add(id);
  }
  return result;
}
