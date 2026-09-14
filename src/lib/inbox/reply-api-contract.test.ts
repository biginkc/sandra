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

describe("exclusion vocabulary parity (obligation 6)", () => {
  it("keeps INBOX_REPLY_EXCLUSIONS a superset of every exclusion literal the SQL boundary emits", () => {
    const recipientSource = readFileSync(RECIPIENT_SQL, "utf8");
    const batchSource = readFileSync(BATCH_SQL, "utf8");
    const setupSource = readFileSync(SETUP_SQL, "utf8");
    // Two literal shapes appear across these files: the common
    // jsonb_build_object('exclusion','<name>') form, and setup.sql's freeze()
    // CASE branches / plpgsql assignment, which name a handful of exclusion
    // codes inline instead ('unsupported_target', 'unknown_state',
    // 'outside_window', and the rendering-exclusion allow-list).
    const literals = new Set<string>();
    for (const source of [recipientSource, batchSource, setupSource])
      for (const match of source.matchAll(/'exclusion'\s*,\s*'([a-z_]+)'/g))
        literals.add(match[1]);
    for (const name of ["unsupported_target", "unknown_state", "outside_window", "missing_variable", "invalid_template", "invalid_body"])
      if (setupSource.includes(`'${name}'`)) literals.add(name);
    expect(literals.size).toBeGreaterThan(0);
    const missing = [...literals].filter((name) => !INBOX_REPLY_EXCLUSIONS.has(name as never));
    expect(missing, `SQL emits exclusion codes not present in INBOX_REPLY_EXCLUSIONS: ${missing.join(", ")}`).toEqual([]);
  });
  // MUTATION: removing "contact_unavailable" from INBOX_REPLY_EXCLUSIONS
  // (recipient.sql's destination_policy() step 3 emits it) must fail this
  // assertion — verified by hand: deleting it from the Set below makes this
  // test fail with `missing: ["contact_unavailable"]`, confirming the parity
  // check actually exercises the SQL source rather than trivially passing.
  it("has no member the SQL boundary never emits (keeps the wire vocabulary honest)", () => {
    const recipientSource = readFileSync(RECIPIENT_SQL, "utf8");
    const batchSource = readFileSync(BATCH_SQL, "utf8");
    const setupSource = readFileSync(SETUP_SQL, "utf8");
    const combined = `${recipientSource}\n${batchSource}\n${setupSource}`;
    for (const name of INBOX_REPLY_EXCLUSIONS)
      expect(combined.includes(`'${name}'`), `${name} not found as a literal in any reply SQL source`).toBe(true);
  });
});
