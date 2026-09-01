export const CI_E2E_OWNER = "github-actions" as const;
export const CI_E2E_PURPOSE = "ci-e2e" as const;
const DOMAIN = "bmhgroupkc.com";

export type E2EPrincipal = "primary" | "assignee";
export type E2EIdentity = {
  runSlug: string;
  email: string;
  password: string;
  principal: E2EPrincipal;
  appMetadata: { owner: typeof CI_E2E_OWNER; purpose: typeof CI_E2E_PURPOSE; run_slug: string; principal: E2EPrincipal };
};

export function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export function assertPairwiseDisjoint(values: readonly string[]): void {
  const normalized = values.map(normalizeIdentity).filter(Boolean);
  if (normalized.length !== values.length || new Set(normalized).size !== normalized.length) {
    throw new Error("E2E identities must be present and pairwise disjoint.");
  }
}

export function assertDedicatedProjectUrl(value: string, projectRef: string): void {
  const ref = normalizeIdentity(projectRef);
  const raw = value.trim();
  const expectedOrigin = `https://${ref}.supabase.co`;
  if (raw !== expectedOrigin && raw !== `${expectedOrigin}/`) {
    throw new Error("E2E CI project URL is not the exact dedicated project origin.");
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("E2E CI project URL is invalid."); }
  if (parsed.protocol !== "https:" || parsed.hostname !== `${ref}.supabase.co` || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("E2E CI project URL is not the exact dedicated project origin.");
  }
}

const slugPattern = /^gha-[1-9][0-9]*-[1-9][0-9]*$/;
const email = (slug: string, principal: E2EPrincipal) =>
  `e2e-ci+${slug}${principal === "primary" ? "" : `-${principal}`}@${DOMAIN}`;

export function createIdentity(runSlug: string, password: string, principal: E2EPrincipal = "primary"): E2EIdentity {
  if (!slugPattern.test(runSlug)) throw new Error("CI E2E identity requires a run-namespaced slug.");
  if (password.length < 32) throw new Error("CI E2E identity requires a job-scoped password.");
  return { runSlug, email: email(runSlug, principal), password, principal,
    appMetadata: { owner: CI_E2E_OWNER, purpose: CI_E2E_PURPOSE, run_slug: runSlug, principal } };
}

export function identityFromEnvironment(env: NodeJS.ProcessEnv = process.env): E2EIdentity {
  const runSlug = env.E2E_RUN_SLUG;
  const password = env.E2E_TEST_USER_PASSWORD;
  if (!runSlug || !password || !env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT) {
    throw new Error("CI E2E identity inputs are missing; refusing shared identity fallback.");
  }
  if (runSlug !== `gha-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`) {
    throw new Error("CI E2E identity does not match the GitHub run namespace.");
  }
  return createIdentity(runSlug, password);
}

export function assertIdentity(user: { email?: string | null; app_metadata?: unknown }, expected: E2EIdentity): void {
  const metadata = user.app_metadata && typeof user.app_metadata === "object" ? user.app_metadata as Record<string, unknown> : {};
  if (user.email?.trim().toLowerCase() !== expected.email || metadata.owner !== CI_E2E_OWNER || metadata.purpose !== CI_E2E_PURPOSE || metadata.run_slug !== expected.runSlug || metadata.principal !== expected.principal) {
    throw new Error("E2E identity owner, purpose, namespace, or principal mismatch.");
  }
}

export function assertBrowserQaProtected(user: { email?: string | null; app_metadata?: unknown }): void {
  const metadata = user.app_metadata && typeof user.app_metadata === "object" ? user.app_metadata as Record<string, unknown> : {};
  if (metadata.owner === "browser-qa" || metadata.purpose === "esign-browser") throw new Error("CI E2E refused to touch a browser-QA identity.");
  if ((user.email ?? "").toLowerCase().startsWith("primary_e2e@")) throw new Error("CI E2E refused a browser-QA alias.");
}
