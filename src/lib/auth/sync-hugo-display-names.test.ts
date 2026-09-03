import { describe, expect, it } from "vitest";

import {
  APPLY_ARM,
  HUGO_PROJECT_REF,
  SANDRA_PROJECT_REF,
  assertSupabaseProjectUrl,
  buildNameSyncPlan,
  buildReviewedOverrideGrants,
  parseNameSyncArgs,
} from "../../../scripts/sync-hugo-display-names.mjs";

describe("Hugo authoritative display-name sync", () => {
  it("pins both identity endpoints to the reviewed Supabase projects", () => {
    expect(
      assertSupabaseProjectUrl(
        `https://${HUGO_PROJECT_REF}.supabase.co`,
        HUGO_PROJECT_REF,
        "Hugo",
      ),
    ).toBe(`https://${HUGO_PROJECT_REF}.supabase.co`);
    expect(() =>
      assertSupabaseProjectUrl(
        `https://${SANDRA_PROJECT_REF}.supabase.co`,
        HUGO_PROJECT_REF,
        "Hugo",
      ),
    ).toThrow(/unexpected Hugo project URL/i);
  });

  it("is dry-run by default and requires the exact apply arm", () => {
    expect(parseNameSyncArgs([])).toEqual({ apply: false });
    expect(parseNameSyncArgs([`--apply=${APPLY_ARM}`])).toEqual({ apply: true });
    expect(() => parseNameSyncArgs(["--apply=yes"])).toThrow(/unarmed/i);
  });

  it("plans only active central names and preserves other app metadata", () => {
    const plan = buildNameSyncPlan(
      [
        {
          app_id: "sandra",
          app_user_id: "stale-user-1",
          desired_status: "active",
          access_ends_at: null,
          profiles: {
            email: "ALEX@example.test",
            display_name: "Alex Rivera",
            status: "active",
          },
        },
        {
          app_id: "sandra",
          app_user_id: "user-2",
          desired_status: "revoked",
          access_ends_at: null,
          profiles: {
            email: "former@example.test",
            display_name: "Former User",
            status: "active",
          },
        },
      ],
      [
        {
          id: "user-1",
          email: "alex@example.test",
          app_metadata: { provisioning_origin: "hugo" },
        },
        { id: "user-2", email: "former@example.test", app_metadata: {} },
      ],
    );

    expect(plan.updates).toEqual([
      {
        userId: "user-1",
        displayName: "Alex Rivera",
        appMetadata: {
          provisioning_origin: "hugo",
          display_name: "Alex Rivera",
        },
      },
    ]);
    expect(plan.unresolvedCount).toBe(0);
    expect(plan.identifierMismatchCount).toBe(1);
    expect(plan.sealedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports a missing Sandra identity without trusting the stale app user id", () => {
    const plan = buildNameSyncPlan(
      [
        {
          user_id: "hugo-user-1",
          app_id: "sandra",
          app_user_id: "missing-sandra-user",
          desired_status: "active",
          access_ends_at: null,
          profiles: {
            email: "missing@example.test",
            display_name: "Missing Person",
            status: "active",
          },
        },
      ],
      [],
    );

    expect(plan.updates).toEqual([]);
    expect(plan.unresolvedCount).toBe(1);
    expect(plan.identifierMismatchCount).toBe(0);
  });

  it("fails closed when a grant points to an existing different identity", () => {
    expect(() =>
      buildNameSyncPlan(
        [
          {
            user_id: "hugo-user-1",
            app_id: "sandra",
            app_user_id: "wrong-user",
            desired_status: "active",
            access_ends_at: null,
            profiles: {
              email: "right@example.test",
              display_name: "Right Person",
              status: "active",
            },
          },
        ],
        [
          {
            id: "wrong-user",
            email: "wrong@example.test",
            app_metadata: {},
          },
        ],
      ),
    ).toThrow(/different Sandra identity/i);
  });

  it("adds reviewed role-account labels only for active exact-email users", () => {
    expect(
      buildReviewedOverrideGrants(
        [
          { id: "gretchen-id", email: "GRETCHEN@bmhgroupkc.com" },
          { id: "info-id", email: "info@bmhgroupkc.com" },
          { id: "unknown-id", email: "unknown@bmhgroupkc.com" },
        ],
        ["gretchen-id", "unknown-id"],
      ),
    ).toEqual([
      expect.objectContaining({
        app_user_id: "gretchen-id",
        profiles: expect.objectContaining({ display_name: "Gretchen" }),
      }),
    ]);
  });
});
