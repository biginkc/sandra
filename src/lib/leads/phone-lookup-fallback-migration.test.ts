import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260902171248_allow_unknown_phone_for_lead_intake.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("unknown phone intake migration", () => {
  it("removes the global unknown-type blocker idempotently", () => {
    expect(migration).toMatch(
      /drop trigger if exists contacts_phone_type_required on public\.contacts/iu,
    );
    expect(migration).toMatch(
      /drop function if exists public\.enforce_phone_type_on_write\(\)/iu,
    );
    expect(migration).not.toMatch(/create\s+trigger/iu);
  });
});
