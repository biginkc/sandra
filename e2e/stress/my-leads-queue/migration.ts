import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The classifier migration from THIS checkout, minus its transaction wrapper. The rolled-back lanes apply it inside
 * their own outer transaction (exactly like the A1 integration test), so they always test the SQL on disk and never
 * depend on which migrations a long-lived local database happens to carry. Nothing is committed.
 */
export const CLASSIFIER_MIGRATION_PREFIX = "20261015010000_my_leads_work_queue_classifier";

export function loadClassifierMigration(root = path.resolve(__dirname, "../../..")): string {
  const dir = path.join(root, "supabase/migrations");
  const file = readdirSync(dir).find((f) => f.startsWith(CLASSIFIER_MIGRATION_PREFIX) && f.endsWith(".sql"));
  if (!file) throw new Error(`classifier migration ${CLASSIFIER_MIGRATION_PREFIX}*.sql not found in ${dir}`);
  const sql = readFileSync(path.join(dir, file), "utf8");
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error("classifier migration transaction wrapper changed");
  return sql.replace(/^begin;\s*/im, "").replace(/\s*commit;\s*$/i, "");
}
