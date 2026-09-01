import { afterEach, beforeEach, describe, expect, it } from "vitest";

import globalSetup, {
  assertLockTargetsExpectedProject,
  isCiEnvironment,
} from "../../../e2e/global-setup";

/**
 * Behavior tests for e2e/global-setup.ts's fail-closed guarantees —
 * actually invoking the real exported function under different
 * environments, not scanning workflow YAML text. Codex review flagged
 * (BLOCKING) that the original version warned-and-proceeded unlocked on
 * every failure mode, including in CI, where a silently-unprotected run is
 * exactly the race this guard exists to prevent.
 */
const ENV_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "E2E_CI_SUPABASE_DB_URL",
  "E2E_CI_SUPABASE_PROJECT_REF",
] as const;
const ORIGINAL_ENV = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

// Nothing listens on loopback port 1 — connection attempts here fail with
// ECONNREFUSED near-instantly (no DNS lookup, no TLS handshake reached),
// so these tests stay fast without needing a real Postgres instance.
const REFUSED_CONNECTION_URL = "postgresql://postgres.testref:pw@127.0.0.1:1/postgres";

function resetEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  resetEnv();
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original !== undefined) process.env[key] = original;
  }
});

describe("e2e/global-setup.ts fail-closed behavior", () => {
  describe("missing E2E_CI_SUPABASE_DB_URL", () => {
    it("throws in CI instead of proceeding unlocked", async () => {
      process.env.CI = "1";
      await expect(globalSetup()).rejects.toThrow(/E2E_CI_SUPABASE_DB_URL is not set/);
    });

    it("warns and proceeds unlocked outside CI", async () => {
      // CI/GITHUB_ACTIONS both unset by resetEnv() in beforeEach.
      const teardown = await globalSetup();
      expect(typeof teardown).toBe("function");
      await expect(teardown()).resolves.toBeUndefined();
    });
  });

  describe("refused connection", () => {
    it("throws in CI instead of proceeding unlocked", async () => {
      process.env.CI = "1";
      process.env.E2E_CI_SUPABASE_DB_URL = REFUSED_CONNECTION_URL;
      await expect(globalSetup()).rejects.toThrow(/could not acquire the DB advisory lock/);
    });

    it("warns and proceeds unlocked outside CI", async () => {
      process.env.E2E_CI_SUPABASE_DB_URL = REFUSED_CONNECTION_URL;
      const teardown = await globalSetup();
      expect(typeof teardown).toBe("function");
      await expect(teardown()).resolves.toBeUndefined();
    });
  });

  describe("project-ref mismatch (unconditional — not CI-gated)", () => {
    it("throws in CI when the pooler username's ref doesn't match E2E_CI_SUPABASE_PROJECT_REF", async () => {
      process.env.CI = "1";
      process.env.E2E_CI_SUPABASE_DB_URL =
        "postgresql://postgres.wrongref:pw@example.invalid:6543/postgres";
      process.env.E2E_CI_SUPABASE_PROJECT_REF = "rightref";
      await expect(globalSetup()).rejects.toThrow(/does not match E2E_CI_SUPABASE_PROJECT_REF/);
    });

    it("throws outside CI too — a wrong-project lock protects nothing regardless of environment", async () => {
      process.env.E2E_CI_SUPABASE_DB_URL =
        "postgresql://postgres.wrongref:pw@example.invalid:6543/postgres";
      process.env.E2E_CI_SUPABASE_PROJECT_REF = "rightref";
      await expect(globalSetup()).rejects.toThrow(/does not match E2E_CI_SUPABASE_PROJECT_REF/);
    });

    it("never attempts a network connection when the ref mismatches (fails on URL parsing alone)", async () => {
      // example.invalid is a reserved, guaranteed-unresolvable TLD (RFC
      // 2606). If this test ever reaches a real connection attempt, DNS
      // resolution would be the failure mode instead of the ref-mismatch
      // message asserted above and in the CI case — proving the mismatch
      // check runs strictly before any Client is created.
      process.env.E2E_CI_SUPABASE_DB_URL =
        "postgresql://postgres.wrongref:pw@example.invalid:6543/postgres";
      process.env.E2E_CI_SUPABASE_PROJECT_REF = "rightref";
      await expect(globalSetup()).rejects.toThrow(/does not match E2E_CI_SUPABASE_PROJECT_REF/);
    });
  });

  describe("assertLockTargetsExpectedProject (direct unit tests)", () => {
    it("passes through and returns the parsed URL when the ref matches", () => {
      const url = assertLockTargetsExpectedProject(
        "postgresql://postgres.rightref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
        { E2E_CI_SUPABASE_PROJECT_REF: "rightref" },
      );
      expect(url.hostname).toBe("aws-0-us-east-1.pooler.supabase.com");
    });

    it("skips the check entirely when E2E_CI_SUPABASE_PROJECT_REF isn't set", () => {
      expect(() =>
        assertLockTargetsExpectedProject(
          "postgresql://postgres.anyref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
          {},
        ),
      ).not.toThrow();
    });

    it("throws on an unparseable pooler username", () => {
      expect(() =>
        assertLockTargetsExpectedProject(
          "postgresql://not-a-pooler-username:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
          { E2E_CI_SUPABASE_PROJECT_REF: "rightref" },
        ),
      ).toThrow(/does not match E2E_CI_SUPABASE_PROJECT_REF/);
    });

    it("throws on an invalid connection URL", () => {
      expect(() =>
        assertLockTargetsExpectedProject("not a url at all", {
          E2E_CI_SUPABASE_PROJECT_REF: "rightref",
        }),
      ).toThrow(/not a valid connection URL/);
    });
  });

  describe("isCiEnvironment", () => {
    it("is true when GITHUB_ACTIONS is 'true'", () => {
      expect(isCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
    });
    it("is true when CI is '1'", () => {
      expect(isCiEnvironment({ CI: "1" })).toBe(true);
    });
    it("is true when CI is 'true'", () => {
      expect(isCiEnvironment({ CI: "true" })).toBe(true);
    });
    it("is false with no CI signal", () => {
      expect(isCiEnvironment({})).toBe(false);
    });
    it("is false when CI is set to an unrelated truthy-looking value", () => {
      expect(isCiEnvironment({ CI: "0" })).toBe(false);
    });
  });
});
