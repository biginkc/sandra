export const DEFAULT_PROD_BASE_URL = "https://sandra-sooty.vercel.app";
export const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
export const TEST_PROJECT_REF = "ncsngxlcyxylaeskiteu";
export const PROD_CANARY_ENV_FILES = [
  ".env.prod-canary.local",
  ".env.local",
] as const;

export function assertProdSupabaseUrl(url: string): void {
  if (url.includes(TEST_PROJECT_REF)) {
    throw new Error(
      [
        `Refusing to run production canaries against the test project (${TEST_PROJECT_REF}).`,
        "Use production Supabase values, preferably in .env.prod-canary.local.",
      ].join(" "),
    );
  }

  if (!url.includes(PROD_PROJECT_REF)) {
    throw new Error(
      `Supabase URL ${url} does not match the Sandra production ref (${PROD_PROJECT_REF}).`,
    );
  }
}
