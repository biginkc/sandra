const SHARED_E2E_PROJECT_REF = "ncsngxlcyxylaeskiteu";

export function assertSafeE2ESupabaseTarget(
  rawUrl: string,
  options: { allowLocal: boolean; dedicatedCi?: boolean; expectedProjectRef?: string },
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("E2E fixtures refusing an invalid Supabase URL.");
  }

  const dedicatedCi = options.dedicatedCi === true;
  if (dedicatedCi) {
    const expectedProjectRef = options.expectedProjectRef?.trim().toLowerCase() ?? "";
    if (!/^[a-z0-9-]+$/.test(expectedProjectRef) || expectedProjectRef === SHARED_E2E_PROJECT_REF) {
      throw new Error("E2E fixtures refusing an invalid dedicated CI project identity.");
    }
    const expectedOrigin = `https://${expectedProjectRef}.supabase.co`;
    const normalizedRawUrl = rawUrl.trim();
    if (normalizedRawUrl !== expectedOrigin && normalizedRawUrl !== `${expectedOrigin}/`) {
      throw new Error("E2E fixtures refusing a non-canonical dedicated CI URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== `${expectedProjectRef}.supabase.co` ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("E2E fixtures refusing a dedicated CI URL outside the expected project.");
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
