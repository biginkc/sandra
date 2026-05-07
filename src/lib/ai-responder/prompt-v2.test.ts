import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static checks on migration 052's content. Verifies the v2 prompt has
 * the required structural sections, contains no AI-tell punctuation that
 * would defeat the humanizer rules, and shapes a valid UPDATE.
 *
 * This is a content-only test — it doesn't run the migration. The
 * `db-migrate.yml` GitHub Actions workflow applies the SQL to test +
 * prod Supabase projects; this file just guards the SQL artifact.
 */

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../supabase/migrations/052_ai_responder_prompt_v2.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

/** Extracted v2 prompt body (between $V2$ ... $V2$). The full file also
 *  includes the SQL comment header + UPDATE statement; tests that check
 *  prompt CONTENT (not SQL shape) should use this. */
const v2Body = sql.match(/\$V2\$([\s\S]*?)\$V2\$/)?.[1] ?? "";

describe("migration 052 — required prompt sections", () => {
  it("contains a ROLE block (filter, not closer)", () => {
    expect(v2Body).toMatch(/(^|\n)ROLE\b/);
    expect(v2Body).toMatch(/filter\.\s*You hand off/);
  });

  it("contains a PIVOT rule", () => {
    expect(v2Body).toMatch(/(^|\n)PIVOT\b/);
    expect(v2Body).toMatch(/cash offer if the number worked/);
  });

  it("contains a MIRROR tone rule", () => {
    expect(v2Body).toMatch(/(^|\n)MIRROR\b/);
    expect(v2Body).toMatch(/match the seller'?s casualness/i);
  });

  it("contains an ANTI-REPETITION rule", () => {
    expect(v2Body).toMatch(/(^|\n)ANTI-REPETITION\b/);
    expect(v2Body).toMatch(/never repeat the property address/i);
  });

  it("contains an ESCALATE list with key triggers", () => {
    expect(v2Body).toMatch(/ESCALATE IMMEDIATELY/);
    expect(v2Body).toMatch(/divorce, death, deceased, passed away, probate/);
    expect(v2Body).toMatch(/multi-property/i);
  });

  it("contains hard NEVERS", () => {
    expect(v2Body).toMatch(/(^|\n)NEVERS/);
    expect(v2Body).toMatch(/NEVER quote a price/);
    expect(v2Body).toMatch(/NEVER ask for SSN/);
  });

  it("contains WRITING STYLE / humanizer rules", () => {
    expect(v2Body).toMatch(/(^|\n)WRITING STYLE/);
    expect(v2Body).toMatch(/em-dashes/i);
  });

  it("contains 6 reply examples", () => {
    expect(v2Body).toMatch(/(^|\n)Example 1 -/);
    expect(v2Body).toMatch(/(^|\n)Example 6 -/);
  });
});

describe("migration 052 — forbidden AI-tells in prompt content", () => {
  it("does not use any em-dashes", () => {
    expect(v2Body).not.toMatch(/—/);
  });

  it("does not use any en-dashes", () => {
    expect(v2Body).not.toMatch(/–/);
  });

  it("does not embed the phrase 'as an investor'", () => {
    expect(v2Body).not.toMatch(/\bas an investor\b/i);
  });

  it("does not instruct the model to use 'no-obligation cash offer'", () => {
    // The phrase appears inside an AVOID rule (which is the whole point);
    // assert we never instruct the model to USE it.
    expect(v2Body).not.toMatch(/use\s+no-obligation cash offer/i);
    expect(v2Body).not.toMatch(/^Use no-obligation cash offer/m);
  });

  it("does not instruct the model to ask 'main reason for selling'", () => {
    expect(v2Body).not.toMatch(/^Ask the seller their main reason for selling/m);
    expect(v2Body).not.toMatch(/Ask their main reason/);
  });
});

describe("migration 052 — SQL shape", () => {
  it("is an UPDATE on ai_responder_configs", () => {
    expect(sql).toMatch(/update\s+ai_responder_configs/i);
  });

  it("targets only active configs", () => {
    expect(sql).toMatch(/where\s+active\s*=\s*true/i);
  });

  it("raises min_confidence to 0.85", () => {
    expect(sql).toMatch(/min_confidence\s*=\s*0\.85/);
  });

  it("touches updated_at", () => {
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/);
  });

  it("uses dollar-quoting for the multi-line prompt body", () => {
    expect(sql).toMatch(/\$V2\$/);
    const opens = (sql.match(/\$V2\$/g) ?? []).length;
    expect(opens).toBe(2);
  });
});
