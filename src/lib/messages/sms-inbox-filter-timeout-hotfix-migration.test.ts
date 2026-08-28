import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260828170000_messages_filter_timeout_hotfix.sql",
  ),
  "utf8",
).toLowerCase();

const rollback = readFileSync(
  join(
    process.cwd(),
    "supabase/rollbacks/20260828170000_messages_filter_timeout_hotfix.sql",
  ),
  "utf8",
).toLowerCase();

describe("Messages filter timeout hotfix migration", () => {
  it("adds a bounded partial inbox index without unbounded text columns", () => {
    expect(migration).toContain(
      "idx_messages_sms_inbox_org_conversation_latest",
    );
    expect(migration).toContain(
      "on public.messages (\n    org_id,\n    conversation_id,\n    created_at desc,\n    id desc",
    );
    expect(migration).toContain(
      "where channel = 'sms'\n    and contact_id is not null\n    and conversation_id is not null\n    and status not in ('queued', 'paused')",
    );
    const includeClause = migration.match(
      /include \(([\s\S]*?)\)\n  where/,
    )?.[1];
    expect(includeClause).toBeDefined();
    expect(includeClause).not.toMatch(/from_address|to_address/);
  });

  it("removes only the recent workset reread and redundant ordering", () => {
    expect(migration).toContain("recent_eligible as materialized (");
    expect(migration).toContain("recent_eligible as not materialized (");
    expect(migration).toContain(
      "(array_agg(e.id) filter (where e.latest_rank = 1))[1] as last_message_id",
    );
    expect(migration).toContain(
      "(array_agg(e.contact_id) filter (where e.latest_rank = 1))[1] as contact_id",
    );
    expect(migration).not.toContain(
      "new_fragment := '(array_agg(e.property_id)",
    );
  });

  it("fails closed on definition drift and keeps a narrow timeout safety net", () => {
    expect(migration).toContain("if fragment_position = 0 then");
    expect(migration).toContain("raise exception 'messages filter hotfix:");
    expect(migration).toContain("set statement_timeout = '15s'");
    expect(migration).not.toContain("set search_path");
  });

  it("provides a forward-safe rollback for every database change", () => {
    expect(rollback).toContain("recent_eligible as not materialized (");
    expect(rollback).toContain("recent_eligible as materialized (");
    expect(rollback).toContain("reset statement_timeout");
    expect(rollback).toContain(
      "drop index if exists public.idx_messages_sms_inbox_org_conversation_latest",
    );
  });
});
