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

describe("Jitter call-activity softphone writeback RPC contract", () => {
  it("accepts only the batch and softphone providers at the RPC boundary", () => {
    expect(activityRpcSql()).toContain(
      "coalesce(p_body ->> 'provider', '') not in ('jitter', 'sandra_softphone')",
    );
  });

  it("selects softphone rows first for softphone payloads and preserves wrap-up fields", () => {
    const sql = activityRpcSql();
    expect(sql).toContain("v_softphone_payload boolean");
    expect(sql).toContain("if v_softphone_payload then");
    expect(sql).toContain("a.provider = 'sandra_softphone'");

    const updateBody = sql.slice(
      sql.indexOf("if v_softphone_match then"),
      sql.indexOf("else", sql.indexOf("if v_softphone_match then")),
    );
    expect(updateBody).toContain("jitter_session_id = v_jitter_session_id");
    expect(updateBody).not.toMatch(
      /(?:operator_user_id|outcome|disposition|do_not_call_requested|notes)\s*=/,
    );
  });

  it("stamps a no-row insert with the payload provider and attempt/session identity", () => {
    const sql = activityRpcSql();
    const insertBody = sql.slice(
      sql.indexOf("insert into public.call_activities"),
      sql.indexOf("on conflict", sql.indexOf("insert into public.call_activities")),
    );

    expect(insertBody).toContain("p_attempt_id");
    expect(insertBody).toContain("v_jitter_session_id");
    expect(insertBody).toContain("p_body ->> 'provider'");
    expect(insertBody).toContain("v_wrap_token");
    expect(sql).toContain("v_wrap_token uuid := null");
  });
});
