import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260825010000_jitter_softphone_artifact_writeback_match.sql",
);

function activityRpcSql(): string {
  const source = fs.readFileSync(migrationPath, "utf8");
  const start = source.indexOf(
    "create or replace function public.jitter_writeback_call_activity(",
  );
  const end = source.indexOf(
    "-- Artifact routes can resolve the softphone parent",
    start,
  );
  if (start < 0 || end < 0) throw new Error("call activity RPC not found");
  return source.slice(start, end);
}

function migrationSql(): string {
  return fs.readFileSync(migrationPath, "utf8");
}

describe("Jitter call-activity softphone writeback RPC contract", () => {
  it("dispatches softphone before entering the origin/main Jitter branch", () => {
    const sql = activityRpcSql();
    expect(sql).toContain("if (p_body ->> 'provider') = 'sandra_softphone' then");
    expect(sql).toContain(
      "return public.jitter_writeback_call_activity_softphone(",
    );
    expect(sql).toContain(
      "elsif (p_body ->> 'provider') is distinct from 'jitter' then",
    );
  });

  it("keeps the softphone helper separate and operator-field preserving", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "create or replace function public.jitter_writeback_call_activity_softphone(",
    );
    expect(sql).toContain("a.provider = 'sandra_softphone'");
    expect(sql).toContain("jitter_session_id = v_jitter_session_id");
    expect(sql).not.toContain("wrap_token = coalesce(wrap_token, v_wrap_token)");
  });

  it("stamps a no-row insert with the literal Jitter provider and attempt/session identity", () => {
    const sql = activityRpcSql();
    const insertBody = sql.slice(
      sql.indexOf("insert into public.call_activities"),
      sql.indexOf("on conflict", sql.indexOf("insert into public.call_activities")),
    );

    expect(insertBody).toContain("p_attempt_id");
    expect(insertBody).toContain("v_jitter_session_id");
    expect(insertBody).toContain("'jitter'");
    expect(insertBody).not.toContain("p_body ->> 'provider'");
    expect(sql).not.toContain("v_wrap_token");
  });

  it("adds a defensive org/provider/attempt uniqueness fence for softphone rows", () => {
    const sql = migrationSql();

    expect(sql).toMatch(
      /create unique index if not exists idx_call_activities_org_provider_softphone_attempt\s+on public\.call_activities \(org_id, provider, jitter_attempt_id\)\s+where provider = 'sandra_softphone';/,
    );
    expect(sql).toContain("group by org_id, jitter_attempt_id");
    expect(sql).toContain("and jitter_attempt_id is not null");
    expect(sql).toContain("having count(*) > 1");
    // Random-UUID attempt ids make duplicates impossible in production; the
    // migration verifies that invariant and fails loudly instead of merging.
    expect(sql).toContain("softphone attempt-id duplicates exist");
    expect(sql).not.toContain("skipping softphone attempt uniqueness index");
    expect(sql).toContain(
      "on conflict (org_id, provider, jitter_attempt_id)\n          where provider = 'sandra_softphone' do update",
    );
  });

  it("keeps lead existence checks on Jitter artifacts but relaxes them for Sandra artifacts", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "if v_activity.provider = 'jitter' and (not exists (",
    );
    expect(sql.match(/if v_activity\.provider = 'jitter' and \(not exists \(/g)).toHaveLength(2);
  });

  it("relaxes only matched softphone lead ids and requires both before insert", () => {
    const sql = migrationSql();

    expect(sql).toContain("elsif not v_softphone_payload then");
    expect(sql).toContain(
      "(v_property_id is not null and v_existing.property_id is distinct from v_property_id)",
    );
    expect(sql).toContain(
      "(v_contact_id is not null and v_existing.contact_id is distinct from v_contact_id)",
    );
    expect(sql).toContain(
      "if v_property_id is null or v_contact_id is null then",
    );
    expect(sql).toContain("A writeback-first row already carries the authoritative lead links");
  });

  it("keeps the origin/main Jitter branch free of softphone dispatch state", () => {
    const sql = activityRpcSql();
    const jitterBranch = sql.slice(
      sql.indexOf("-- BEGIN origin/main Jitter branch"),
    );
    expect(jitterBranch).toContain("a.provider = 'jitter'");
    expect(jitterBranch).toContain("a.jitter_session_id = v_jitter_session_id");
    expect(jitterBranch).toContain("a.jitter_attempt_id = p_attempt_id");
    expect(jitterBranch).not.toContain("sandra_softphone");
    expect(jitterBranch).not.toContain("v_softphone");
    expect(jitterBranch).not.toContain("wrap_token");
    expect(jitterBranch).not.toContain("p_body ->> 'provider'");
  });
});
