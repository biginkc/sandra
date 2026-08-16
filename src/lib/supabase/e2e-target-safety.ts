const SHARED_E2E_PROJECT_REF = "ncsngxlcyxylaeskiteu";

export function assertSafeE2ESupabaseTarget(
  rawUrl: string,
  options: { allowLocal: boolean },
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("E2E fixtures refusing an invalid Supabase URL.");
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
