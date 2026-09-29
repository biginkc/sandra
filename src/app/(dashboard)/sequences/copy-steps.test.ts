import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20260929237000_sequence_detail.sql", "utf8");

describe("sequence_copy_steps migration contract", () => {
  it("rejects a non-empty target before inserting and preserves the source", () => {
    expect(migration).toMatch(/if exists \(\s*select 1 from public\.sequence_steps where sequence_id = p_target/);
    expect(migration).toMatch(/raise exception 'TARGET_NOT_EMPTY'/);
    expect(migration).toMatch(/insert into public\.sequence_steps/);
    expect(migration).not.toMatch(/delete from public\.sequence_steps/);
  });
});
