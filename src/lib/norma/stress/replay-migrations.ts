/**
 * Migrations the Norma stress gate leaves out of the provisioned source and replays itself, after the Norma files.
 *
 * The provisioned stack is built without the Norma migrations, so `tasks.source_key`, `norma_call_requests` and the `fn_norma_*`
 * functions do not exist there. A migration whose SQL-language function body reads any of them fails to apply (Postgres checks a
 * `language sql` body at creation), so it must be excluded with the Norma files and replayed after them. One list, used by the
 * replay (db.ts), the full-chain config and, verbatim, the workflow's --exclude-migrations arguments (checked by
 * replay-migrations.test.ts).
 */
export const NORMA_STRESS_REPLAY_PATTERNS = ["*_norma_*", "*_my_leads_work_*", "*_my_leads_approved_*"] as const;

/** Same glob semantics as scripts/ci/provision-disposable-stack.mjs `excluded()`: `*` is any run of characters, nothing else. */
export function matchesReplayPattern(file: string, patterns: readonly string[] = NORMA_STRESS_REPLAY_PATTERNS): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(file));
}

/** The migration files to replay: every match, Norma files first (by version), then the rest (by version). */
export function replayMigrations(files: readonly string[]): string[] {
  const matched = files.filter((f) => /^\d{14}_.+\.sql$/.test(f) && matchesReplayPattern(f));
  const norma = matched.filter((f) => matchesReplayPattern(f, ["*_norma_*"])).sort();
  return [...norma, ...matched.filter((f) => !norma.includes(f)).sort()];
}
