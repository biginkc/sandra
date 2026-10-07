import { ReplaySafetyError, applyStubEnv, assertHarnessEnv, assertSafeDbUrl, assertSafeSupabaseUrl, type EnvLike } from "./safety";

/**
 * The compare script reads a JSON file and calls two classifier APIs. It opens no database and has no
 * SMS code path. These checks make that hold even if someone's shell has production values exported:
 * - seller-SMS credentials (Sendillo/Twilio/Dialpad) must not be present in the process (reuses assertHarnessEnv);
 * - any Supabase/DB URL in the environment must be local or an explicitly allowed non-production project.
 * OPENAI_API_KEY is intentionally NOT blanked here or in replay:server's BLANKED_ENV logic; the replay
 * server never receives it because compare runs standalone.
 */
export function assertCompareSafety(env: EnvLike, prodRefs: readonly string[], allowProjectRef: string | null = null): void {
  const probe: EnvLike = { ...env };
  applyStubEnv(probe); // the stub flag is a precondition of assertHarnessEnv; the credential check is what matters here
  assertHarnessEnv(probe);
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) {
    const v = (env[name] ?? "").trim();
    if (v) assertSafeSupabaseUrl(v, { prodRefs, allowProjectRef });
  }
  for (const name of ["SUPABASE_LOCAL_DB_URL", "DATABASE_URL", "POSTGRES_URL", "SUPABASE_DB_URL"]) {
    const v = (env[name] ?? "").trim();
    if (v) assertSafeDbUrl(v, { prodRefs, allowProjectRef });
  }
}

export { ReplaySafetyError };
