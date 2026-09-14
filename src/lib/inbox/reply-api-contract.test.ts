import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INBOX_REPLY_EXCLUSIONS, INBOX_REPLY_RECIPIENT_LIMIT } from "./reply-api-contract";

const RECIPIENT_SQL = join(
  process.cwd(),
  "experiments/inbox-reply-preparation/recipient.sql",
);
const BATCH_SQL = join(
  process.cwd(),
  "experiments/inbox-reply-preparation/batch.sql",
);
const SETUP_SQL = join(
  process.cwd(),
  "experiments/inbox-reply-review/setup.sql",
);

describe("D5 bulk-reply recipient cap parity", () => {
  it("keeps INBOX_REPLY_RECIPIENT_LIMIT in sync with inbox_reply_preparation.recipient_limit()", () => {
    const source = readFileSync(RECIPIENT_SQL, "utf8");
    const match = /CREATE FUNCTION inbox_reply_preparation\.recipient_limit\(\)[^$]*\$\$\s*SELECT (\d+)\s*\$\$/.exec(
      source,
    );
    expect(
      match,
      "recipient_limit() definition not found or shape changed in recipient.sql",
    ).not.toBeNull();
    const sqlLimit = Number(match?.[1]);
    expect(sqlLimit).toBe(INBOX_REPLY_RECIPIENT_LIMIT);
  });
});

// Extracts every single-quoted snake_case literal from any SQL span that
// assigns a value to the 'exclusion' jsonb key or the plpgsql `reason`
// variable — INCLUDING literals buried inside a CASE...END expression used
// as that value (setup.sql's freeze() does this for the time-based
// exclusions). Deliberately scoped to the assigned VALUE expression, not the
// whole source line: a line like `... IN ('opt_out','provider_auto_opt_out')
// THEN RETURN jsonb_build_object('exclusion','sms_suppressed')` contains
// unrelated snake_case literals ('opt_out') that are not exclusion codes —
// scanning the full line would falsely flag them as missing from
// INBOX_REPLY_EXCLUSIONS. Scoping to `'exclusion',<value>` / `reason:=<value>`
// captures exactly the assigned literal(s), CASE arms included, with no
// unrelated-literal noise.
function exclusionLiterals(source: string): Set<string> {
  const literals = new Set<string>();
  const valuePattern = /(?:'exclusion'\s*,\s*|reason\s*:=\s*)(CASE\b[\s\S]*?\bEND\b|'[a-z_]+')/g;
  // Inside a captured CASE...END span, only literals actually being compared
  // TO or returned AS the value count — not jsonb key-path accessors like
  // `->>'reason'` or `->>'state'` that happen to appear in the WHEN
  // condition. Those are always immediately preceded by `->`/`->>`, i.e. a
  // `>` right before the opening quote; a real value literal never is.
  const valueLiteral = /(?<!>)'([a-z_]+)'/g;
  for (const match of source.matchAll(valuePattern))
    for (const literal of match[1].matchAll(valueLiteral))
      literals.add(literal[1]);
  return literals;
}

describe("exclusion vocabulary parity (obligation 6)", () => {
  it("keeps INBOX_REPLY_EXCLUSIONS a superset of every exclusion literal the SQL boundary emits, including CASE-arm literals", () => {
    const recipientSource = readFileSync(RECIPIENT_SQL, "utf8");
    const batchSource = readFileSync(BATCH_SQL, "utf8");
    const setupSource = readFileSync(SETUP_SQL, "utf8");
    const literals = new Set<string>();
    for (const source of [recipientSource, batchSource, setupSource])
      for (const literal of exclusionLiterals(source)) literals.add(literal);
    expect(literals.size).toBeGreaterThan(0);
    // setup.sql's freeze() assigns the time-based exclusions via a CASE arm
    // (`'exclusion',CASE WHEN ...->>'reason'='unknown_state' THEN
    // 'unknown_state' ELSE 'outside_window' END`) — confirm the CASE-arm scan
    // actually reaches inside it, not just the direct jsonb_build_object form.
    expect(literals.has("unknown_state")).toBe(true);
    expect(literals.has("outside_window")).toBe(true);
    const missing = [...literals].filter((name) => !INBOX_REPLY_EXCLUSIONS.has(name as never));
    expect(missing, `SQL emits exclusion codes not present in INBOX_REPLY_EXCLUSIONS: ${missing.join(", ")}`).toEqual([]);
  });
  // MUTATION: removing "contact_unavailable" from INBOX_REPLY_EXCLUSIONS
  // (recipient.sql's destination_policy() step 3 emits it) must fail this
  // assertion — verified by hand: deleting it from the Set below makes this
  // test fail with `missing: ["contact_unavailable"]`, confirming the parity
  // check actually exercises the SQL source rather than trivially passing.
  it("catches a CASE-arm-only literal introduced in a fixture copy that never reached INBOX_REPLY_EXCLUSIONS", () => {
    // Proves exclusionLiterals() actually descends into CASE arms rather than
    // trivially passing: a synthetic fixture mirroring setup.sql's own
    // CASE-arm shape, with a literal ("bogus_case_arm_exclusion") that is
    // deliberately absent from INBOX_REPLY_EXCLUSIONS, must be extracted and
    // must fail the superset check.
    const fixture = `
      SELECT value||jsonb_build_object('exclusion',CASE WHEN some_fn(value)->>'reason'='bogus_case_arm_exclusion' THEN 'bogus_case_arm_exclusion' ELSE 'outside_window' END,'recipient',NULL);
    `;
    const literals = exclusionLiterals(fixture);
    expect(literals.has("bogus_case_arm_exclusion")).toBe(true);
    const missing = [...literals].filter((name) => !INBOX_REPLY_EXCLUSIONS.has(name as never));
    expect(missing).toEqual(["bogus_case_arm_exclusion"]);
  });
  it("has no member the SQL boundary never emits (keeps the wire vocabulary honest)", () => {
    const recipientSource = readFileSync(RECIPIENT_SQL, "utf8");
    const batchSource = readFileSync(BATCH_SQL, "utf8");
    const setupSource = readFileSync(SETUP_SQL, "utf8");
    const combined = `${recipientSource}\n${batchSource}\n${setupSource}`;
    for (const name of INBOX_REPLY_EXCLUSIONS)
      expect(combined.includes(`'${name}'`), `${name} not found as a literal in any reply SQL source`).toBe(true);
  });
});
