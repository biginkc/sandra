/**
 * Deliberately broken copies of the search_properties migration SQL. Each must (a) actually change
 * the SQL (checked standalone by scripts/check-search-mutations.ts before any suite run, so a
 * regex that silently stops matching cannot turn a mutation into a no-op) and (b) be killed by
 * the RPC integration suite (CI loops over MUTATION_NAMES).
 */
export const MUTATION_NAMES = ["drop-org-gate", "drop-agent-join", "drop-deleted-at", "drop-like-escape", "add-limit-100", "drop-sms-channel", "drop-length-cap", "drop-structured", "auth-uid-null"] as const;

export function mutate(sql: string, name: string | undefined): string {
  switch (name) {
    case "drop-org-gate": return sql.replace(/\b\w+\.org_id in \(select org_id from visible_orgs\)/g, "true");
    case "drop-agent-join": return sql.replace("(p.homeowner_contact_id = c.id or p.agent_contact_id = c.id)", "p.homeowner_contact_id = c.id");
    case "drop-deleted-at": return sql.replace(/\s+and p\.deleted_at is null/g, "");
    case "drop-like-escape": return sql.replace("replace(replace(replace(lower(bounds.q), E'\\\\', E'\\\\\\\\'), '%', E'\\\\%'), '_', E'\\\\_') as q_like", "lower(bounds.q) as q_like");
    case "add-limit-100": return sql.replace("and p.deleted_at is null;\n  $search$", "and p.deleted_at is null limit 100;\n  $search$");
    case "drop-sms-channel": return sql.replace("m.channel = 'sms'", "true");
    case "drop-length-cap": return sql.replace("rtrim(left(btrim(regexp_replace(coalesce($1,''), '\\s+', ' ', 'g')),100))", "btrim(regexp_replace(coalesce($1,''), '\\s+', ' ', 'g'))");
    case "drop-structured": return sql.replace("(i.is_structured and length(i.qd) >= 3", "(length(i.qd) >= 3");
    case "auth-uid-null": return sql.replaceAll("auth.uid()", "null::uuid");
    default: return sql;
  }
}
