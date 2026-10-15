import { requireLoopbackPostgresUrl } from "../../../src/lib/testing/loopback-postgres-url";

/**
 * Lane guards for the My Leads queue stress harness. They run before any connection is opened and fail closed.
 *
 *  - The database URL comes ONLY from an explicit variable (MYLEADS_STRESS_DB_URL, then TEST_SUPABASE_DB_URL) or the
 *    documented local default. This harness never opens, reads or parses a `.env*` file: a remote URL cannot arrive that way.
 *  - The URL must be loopback (127.0.0.1 / localhost / [::1]), with no query string that could redirect the host.
 *  - No hosted Supabase project reference may appear anywhere in the environment variables this harness reads.
 *  - Lanes that COMMIT rows (races) additionally require the explicit acknowledgement MYLEADS_STRESS_DISPOSABLE_DB=1 and refuse
 *    a database that already holds non-harness leads. Read-only/rolled-back lanes never commit anything.
 *  - Providers are never called: the only sender is the in-process fake (races.ts sqlSendDriver, and the mocked provider and
 *    sendSmsToContact in race.dispatch.integration.test.ts).
 */
export const DEFAULT_LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
export const HARNESS_ADDRESS_PREFIX = "S1RACE ";

export class GuardRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GuardRefusal";
  }
}

type Env = Readonly<Record<string, string | undefined>>;
const HOSTED = /ncsngxlcyxylaeskiteu|copflsklaefwzipsrjqz|\.supabase\.co\b|\.supabase\.in\b|\.pooler\.supabase\.com\b|\.neon\.tech\b|\.rds\.amazonaws\.com\b/i;

export function resolveDbUrl(env: Env = process.env): string {
  const url = env.MYLEADS_STRESS_DB_URL ?? env.TEST_SUPABASE_DB_URL ?? DEFAULT_LOCAL_DB_URL;
  try {
    requireLoopbackPostgresUrl(url);
  } catch {
    throw new GuardRefusal("DB_NOT_LOOPBACK", "the stress harness only runs against a loopback Postgres (127.0.0.1 / localhost / [::1]) with no query string.");
  }
  return url;
}

export function assertEnvLooksLocal(env: Env = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value || !/^(MYLEADS_STRESS_.*|TEST_SUPABASE_.*|NEXT_PUBLIC_SUPABASE_URL|SUPABASE_URL|DATABASE_URL|E2E_CI_SUPABASE_DB_URL)$/.test(key)) continue;
    if (HOSTED.test(value)) throw new GuardRefusal("HOSTED_REF_IN_ENV", `${key} points at a hosted service; refusing.`);
  }
}

export function assertCommitLaneAllowed(env: Env = process.env): void {
  if (env.MYLEADS_STRESS_DISPOSABLE_DB !== "1")
    throw new GuardRefusal("DISPOSABLE_DB_NOT_ACKNOWLEDGED", "set MYLEADS_STRESS_DISPOSABLE_DB=1 to confirm this database is a disposable local one before a lane that commits rows (the race lanes).");
}

/** The race lanes commit; refuse a database that holds any lead this harness did not create. */
export function assertOnlyHarnessLeads(counts: { properties: number; foreign: number }): void {
  if (counts.foreign > 0)
    throw new GuardRefusal("NON_HARNESS_DATA", `${counts.foreign} of ${counts.properties} leads were not created by this harness; the race lanes only run on an otherwise empty disposable database.`);
}
