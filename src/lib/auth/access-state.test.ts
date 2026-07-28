import { describe, expect, it } from "vitest";

import {
  hasActiveSandraAccess,
  isMissingHugoAccessColumnError,
} from "./access-state";

describe("isMissingHugoAccessColumnError", () => {
  it("recognizes the PostgREST schema-cache error for Hugo access columns", () => {
    expect(
      isMissingHugoAccessColumnError({
        code: "PGRST204",
        message:
          "Could not find the 'access_status' column of 'memberships' in the schema cache",
      }),
    ).toBe(true);
  });

  it("does not treat unrelated schema errors as a local compatibility case", () => {
    expect(
      isMissingHugoAccessColumnError({
        code: "PGRST204",
        message: "Could not find the 'role' column of 'memberships' in the schema cache",
      }),
    ).toBe(false);
    expect(
      isMissingHugoAccessColumnError({
        code: "23505",
        message: "duplicate key value violates unique constraint",
      }),
    ).toBe(false);
  });
});

describe("hasActiveSandraAccess", () => {
  const now = Date.parse("2026-07-27T12:00:00.000Z");

  it("accepts an active, non-expired membership", () => {
    expect(
      hasActiveSandraAccess(
        { access_status: "active", access_expires_at: "2026-07-28T12:00:00Z" },
        now,
      ),
    ).toBe(true);
  });

  it("denies suspended, revoked, and expired access", () => {
    expect(hasActiveSandraAccess({ access_status: "suspended" }, now)).toBe(false);
    expect(hasActiveSandraAccess({ access_status: "revoked" }, now)).toBe(false);
    expect(
      hasActiveSandraAccess(
        { access_status: "active", access_expires_at: "2026-07-27T11:59:59Z" },
        now,
      ),
    ).toBe(false);
  });

  it("denies an identity prepared for deletion", () => {
    expect(
      hasActiveSandraAccess(
        {
          access_status: "active",
          deletion_prepared_at: "2026-07-27T11:00:00Z",
        },
        now,
      ),
    ).toBe(false);
  });

  it("fails closed on malformed expiration timestamps", () => {
    expect(
      hasActiveSandraAccess({ access_status: "active", access_expires_at: "not-a-date" }, now),
    ).toBe(false);
  });
});
