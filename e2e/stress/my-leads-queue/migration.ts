import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The classifier SQL from THIS checkout. The rolled-back lanes apply it inside their own outer transaction (exactly like the A1 integration
 * test), so they always test the SQL on disk. Applying only the first classifier migration would `create or replace` the functions OVER
 * any later fix, so every migration from the first classifier file onward that (re)defines one of the classifier functions is applied,
 * in filename order. Nothing is committed.
 */
export const CLASSIFIER_MIGRATION_PREFIX = "20261015010000_my_leads_work_queue_classifier";
const CLASSIFIER_FUNCTIONS = /\b(my_leads_work_classified|fn_my_leads_work_page|fn_my_leads_work_facts|fn_my_leads_badge_v2|my_leads_add_business_days)\b/;
/** The migration that carries the SQ2 fix (design v9 17, PR #876). Its presence retires the SQ2 excusal. */
export const SQ2_FIX_MIGRATION_PREFIX = "20261015020200";

const migrationsDir = (root: string) => path.join(root, "supabase/migrations");
const defaultRoot = () => path.resolve(__dirname, "../../..");

export function classifierMigrationFiles(root = defaultRoot()): string[] {
  const dir = migrationsDir(root);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const first = files.find((f) => f.startsWith(CLASSIFIER_MIGRATION_PREFIX));
  if (!first) throw new Error(`classifier migration ${CLASSIFIER_MIGRATION_PREFIX}*.sql not found in ${dir}`);
  return files.filter((f) => f >= first && (f === first || CLASSIFIER_FUNCTIONS.test(readFileSync(path.join(dir, f), "utf8"))));
}

const unwrap = (sql: string) => sql.replace(/^\s*begin;\s*/im, "").replace(/\s*commit;\s*$/i, "");

/** Every classifier migration, in order, as one script without transaction wrappers. */
export function loadClassifierMigration(root = defaultRoot()): string {
  const dir = migrationsDir(root);
  return classifierMigrationFiles(root).map((f) => `-- ${f}\n${unwrap(readFileSync(path.join(dir, f), "utf8"))}`).join("\n;\n");
}

/** True once the SQ2 fix migration is in this checkout: from then on SQ2 mismatches gate the run like any other. */
export function sq2FixLanded(root = defaultRoot()): boolean {
  return readdirSync(migrationsDir(root)).some((f) => f.startsWith(SQ2_FIX_MIGRATION_PREFIX) && f.endsWith(".sql"));
}
