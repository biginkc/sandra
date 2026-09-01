const SHARED_E2E_PROJECT_REF = "ncsngxlcyxylaeskiteu";
const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

type E2ETargetSafetyOptions = {
  allowLocal: boolean;
  expectedProjectRef?: string;
  requireExpectedProjectRef?: boolean;
};

type E2ETargetEnvironment = Readonly<Record<string, string | undefined>>;

export function assertSafeE2ESupabaseTarget(
  rawUrl: string,
  options: E2ETargetSafetyOptions,
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("E2E fixtures refusing an invalid Supabase URL.");
  }

  const expectedProjectRef = options.expectedProjectRef;
  if (options.requireExpectedProjectRef || expectedProjectRef) {
    if (!expectedProjectRef) {
      throw new Error("E2E CI requires an expected Supabase project ref.");
    }
    if (!SUPABASE_PROJECT_REF_PATTERN.test(expectedProjectRef)) {
      throw new Error("E2E CI received a malformed Supabase project ref.");
    }
    if (url.hostname !== `${expectedProjectRef}.supabase.co`) {
      throw new Error(
        "E2E CI Supabase URL does not match the expected project ref.",
      );
    }
    return;
  }

  if (url.hostname === `${SHARED_E2E_PROJECT_REF}.supabase.co`) return;

  const isLocalHost =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const isExpectedLocalApi = isLocalHost && url.port === "54321";
  if (options.allowLocal && isExpectedLocalApi) return;

  throw new Error(
    "E2E fixtures refusing to run against a database outside the approved test project or explicitly enabled local Supabase.",
  );
}

export function assertSafeE2ESupabaseTargetFromEnvironment(
  rawUrl: string,
  environment: E2ETargetEnvironment = process.env,
): void {
  const isCi =
    environment.GITHUB_ACTIONS === "true" ||
    environment.CI === "1" ||
    environment.CI === "true";
  assertSafeE2ESupabaseTarget(rawUrl, {
    allowLocal: environment.E2E_ALLOW_LOCAL_SUPABASE === "1",
    expectedProjectRef: environment.E2E_CI_SUPABASE_PROJECT_REF,
    requireExpectedProjectRef: isCi,
  });
}
