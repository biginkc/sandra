import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifierMigrationFiles, loadClassifierMigration, sq2FixLanded } from "./migration";

function fakeRepo(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "s1-mig-"));
  mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(root, "supabase/migrations", name), sql);
  return root;
}

describe("classifier migration discovery", () => {
  it("applies the first classifier migration and every later file that redefines a classifier function, in order", () => {
    const root = fakeRepo({
      "20261001000000_older.sql": "begin; create function public.my_leads_work_classified() ...; commit;",
      "20261015010000_my_leads_work_queue_classifier.sql": "begin;\nselect 1;\ncommit;\n",
      "20261015015000_unrelated.sql": "begin; select 2; commit;",
      "20261015020200_my_leads_sq2_fix.sql": "begin;\ncreate or replace function public.my_leads_work_classified() returns int language sql as 'select 3';\ncommit;\n",
    });
    expect(classifierMigrationFiles(root)).toEqual(["20261015010000_my_leads_work_queue_classifier.sql", "20261015020200_my_leads_sq2_fix.sql"]);
    const sql = loadClassifierMigration(root);
    expect(sql.indexOf("select 1")).toBeLessThan(sql.indexOf("select 3"));
    expect(sql).not.toMatch(/^\s*begin;/im);
    expect(sql).not.toMatch(/commit;\s*$/i);
    expect(sq2FixLanded(root)).toBe(true);
  });
  it("SQ2 excusal stays only while the fix migration is absent", () => {
    expect(sq2FixLanded(fakeRepo({ "20261015010000_my_leads_work_queue_classifier.sql": "begin; select 1; commit;" }))).toBe(false);
  });
  it("this checkout's classifier SQL loads", () => {
    expect(loadClassifierMigration()).toMatch(/fn_my_leads_work_page/);
  });
});
