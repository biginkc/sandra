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

const slugPattern = /^gha-[1-9][0-9]*-[1-9][0-9]*$/;
const email = (slug: string, principal: E2EPrincipal) =>
  `e2e-ci+${slug}${principal === "primary" ? "" : `-${principal}`}@${DOMAIN}`;

export function createIdentity(runSlug: string, password: string, principal: E2EPrincipal = "primary"): E2EIdentity {
  if (!slugPattern.test(runSlug)) throw new Error("CI E2E identity requires a run-namespaced slug.");
  if (password.length < 32) throw new Error("CI E2E identity requires a job-scoped password.");
  return { runSlug, email: email(runSlug, principal), password, principal,
    appMetadata: { owner: CI_E2E_OWNER, purpose: CI_E2E_PURPOSE, run_slug: runSlug, principal } };
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
