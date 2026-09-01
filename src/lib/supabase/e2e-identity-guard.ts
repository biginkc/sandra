import { createHash, randomBytes } from "node:crypto";

export const CI_E2E_OWNER = "github-actions";
export const CI_E2E_PURPOSE = "ci-e2e";
export const CI_E2E_EMAIL_DOMAIN = "bmhgroupkc.com";
export const CI_E2E_EMAIL_PREFIX = "e2e-ci+";

export type E2EPrincipal = "primary" | "assignee";

export type E2ERunEnvironment = {
  runSlug: string;
  email: string;
  password: string;
};

export type E2EIdentity = E2ERunEnvironment & {
  principal: E2EPrincipal;
  appMetadata: {
    owner: typeof CI_E2E_OWNER;
    purpose: typeof CI_E2E_PURPOSE;
    run_slug: string;
    principal: E2EPrincipal;
  };
};

export type AuthUserIdentity = {
  id: string;
  email?: string | null;
  updated_at?: string | null;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  phone_confirmed_at?: string | null;
  confirmation_sent_at?: string | null;
  recovery_sent_at?: string | null;
  email_change_sent_at?: string | null;
  new_email?: string | null;
  app_metadata?: unknown;
  user_metadata?: unknown;
};

export type BrowserQaSnapshot = {
  version: 1;
  count: number;
  fingerprints: Record<string, string>;
};

const GITHUB_RUN_SLUG = /^gha-[1-9][0-9]*-[1-9][0-9]*$/;
const LOCAL_RUN_SLUG = /^local-[1-9][0-9]*-[a-f0-9]{12}$/;
const GENERATED_PASSWORD_MIN_LENGTH = 32;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function principalSuffix(principal: E2EPrincipal): string {
  return principal === "primary" ? "" : `-${principal}`;
}

export function ciE2EEmail(
  runSlug: string,
  principal: E2EPrincipal = "primary",
): string {
  return `${CI_E2E_EMAIL_PREFIX}${runSlug}${principalSuffix(principal)}@${CI_E2E_EMAIL_DOMAIN}`;
}

export function deriveGitHubRunSlug(
  runId: string | undefined,
  runAttempt: string | undefined,
): string {
  if (!runId || !/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("CI E2E identity requires a numeric GITHUB_RUN_ID.");
  }
  if (!runAttempt || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error("CI E2E identity requires a numeric GITHUB_RUN_ATTEMPT.");
  }
  return `gha-${runId}-${runAttempt}`;
}

export function createGitHubRunEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): E2ERunEnvironment {
  const runSlug = deriveGitHubRunSlug(
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
  );
  return {
    runSlug,
    email: ciE2EEmail(runSlug),
    password: randomBytes(32).toString("base64url"),
  };
}

function createLocalRunEnvironment(): E2ERunEnvironment {
  const runSlug = `local-${process.pid}-${randomBytes(6).toString("hex")}`;
  return {
    runSlug,
    email: ciE2EEmail(runSlug),
    password: randomBytes(32).toString("base64url"),
  };
}

export function isProtectedBrowserQaUser(user: AuthUserIdentity): boolean {
  const email = normalizeEmail(user.email ?? "");
  const domainSuffix = `@${CI_E2E_EMAIL_DOMAIN}`;
  const localPart = email.endsWith(domainSuffix)
    ? email.slice(0, -domainSuffix.length)
    : "";
  const reservedBrowserQaNamespace =
    localPart.startsWith("e2e-") && !localPart.startsWith(CI_E2E_EMAIL_PREFIX);
  const metadata = metadataRecord(user.app_metadata);
  const metadataMarkers = [metadata.owner, metadata.purpose]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  const browserQaMetadata = metadataMarkers.some(
    (value) => value.includes("browser") && value.includes("qa"),
  );
  return reservedBrowserQaNamespace || browserQaMetadata;
}

export function assertValidE2EIdentity(identity: E2EIdentity): void {
  const validRunSlug =
    GITHUB_RUN_SLUG.test(identity.runSlug) ||
    LOCAL_RUN_SLUG.test(identity.runSlug);
  if (!validRunSlug) {
    throw new Error("CI E2E identity has an empty or malformed run slug.");
  }
  if (
    normalizeEmail(identity.email) !==
    ciE2EEmail(identity.runSlug, identity.principal)
  ) {
    throw new Error("CI E2E identity is outside the exact run namespace.");
  }
  if (isProtectedBrowserQaUser({ id: "candidate", email: identity.email })) {
    throw new Error(
      "CI E2E identity collides with the protected browser-QA namespace.",
    );
  }
  if (
    !identity.password ||
    identity.password.length < GENERATED_PASSWORD_MIN_LENGTH
  ) {
    throw new Error(
      "CI E2E identity requires a generated job-scoped password.",
    );
  }
  if (
    identity.appMetadata.owner !== CI_E2E_OWNER ||
    identity.appMetadata.purpose !== CI_E2E_PURPOSE ||
    identity.appMetadata.run_slug !== identity.runSlug ||
    identity.appMetadata.principal !== identity.principal
  ) {
    throw new Error(
      "CI E2E identity metadata does not match its exact run namespace.",
    );
  }
}

export function identityForPrincipal(
  run: E2ERunEnvironment,
  principal: E2EPrincipal = "primary",
): E2EIdentity {
  const identity: E2EIdentity = {
    ...run,
    email: ciE2EEmail(run.runSlug, principal),
    principal,
    appMetadata: {
      owner: CI_E2E_OWNER,
      purpose: CI_E2E_PURPOSE,
      run_slug: run.runSlug,
      principal,
    },
  };
  assertValidE2EIdentity(identity);
  return identity;
}

export function ensureE2ERunEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): E2ERunEnvironment {
  const supplied = [
    env.E2E_RUN_SLUG,
    env.E2E_TEST_USER_EMAIL,
    env.E2E_TEST_USER_PASSWORD,
  ];
  const suppliedCount = supplied.filter(Boolean).length;
  let run: E2ERunEnvironment;

  if (suppliedCount === 0) {
    if (env.CI === "1" || env.GITHUB_ACTIONS === "true") {
      throw new Error(
        "GitHub E2E must emit one job-scoped identity before Playwright starts.",
      );
    }
    run = createLocalRunEnvironment();
  } else {
    if (suppliedCount !== supplied.length) {
      throw new Error("E2E identity environment is incomplete.");
    }
    run = {
      runSlug: env.E2E_RUN_SLUG!,
      email: env.E2E_TEST_USER_EMAIL!,
      password: env.E2E_TEST_USER_PASSWORD!,
    };
  }

  if (env.CI === "1" || env.GITHUB_ACTIONS === "true") {
    const expectedSlug = deriveGitHubRunSlug(
      env.GITHUB_RUN_ID,
      env.GITHUB_RUN_ATTEMPT,
    );
    if (
      run.runSlug !== expectedSlug ||
      normalizeEmail(run.email) !== ciE2EEmail(expectedSlug)
    ) {
      throw new Error(
        "GitHub E2E identity does not match this run ID and attempt.",
      );
    }
  }

  const primary = identityForPrincipal(run);
  env.E2E_RUN_SLUG = primary.runSlug;
  env.E2E_TEST_USER_EMAIL = primary.email;
  env.E2E_TEST_USER_PASSWORD = primary.password;
  return run;
}

export function assertExistingUserMatchesIdentity(
  user: AuthUserIdentity,
  expected: E2EIdentity,
): void {
  assertValidE2EIdentity(expected);
  const metadata = metadataRecord(user.app_metadata);
  if (
    normalizeEmail(user.email ?? "") !== normalizeEmail(expected.email) ||
    metadata.owner !== expected.appMetadata.owner ||
    metadata.purpose !== expected.appMetadata.purpose ||
    metadata.run_slug !== expected.appMetadata.run_slug ||
    metadata.principal !== expected.appMetadata.principal
  ) {
    throw new Error(
      "Existing auth user does not match the exact CI E2E namespace and metadata.",
    );
  }
}

export function assertCleanupCandidate(
  user: AuthUserIdentity,
  expected: E2EIdentity,
): void {
  if (!user.id) {
    throw new Error("CI E2E cleanup candidate is missing its auth user ID.");
  }
  assertExistingUserMatchesIdentity(user, expected);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotProtectedBrowserQaUsers(
  users: readonly AuthUserIdentity[],
): BrowserQaSnapshot {
  const fingerprints: Record<string, string> = {};
  for (const user of users.filter(isProtectedBrowserQaUser)) {
    const key = digest(`${user.id}\0${normalizeEmail(user.email ?? "")}`);
    fingerprints[key] = digest(
      JSON.stringify(
        stableValue({
          updated_at: user.updated_at ?? null,
          last_sign_in_at: user.last_sign_in_at ?? null,
          email_confirmed_at: user.email_confirmed_at ?? null,
          phone_confirmed_at: user.phone_confirmed_at ?? null,
          confirmation_sent_at: user.confirmation_sent_at ?? null,
          recovery_sent_at: user.recovery_sent_at ?? null,
          email_change_sent_at: user.email_change_sent_at ?? null,
          new_email: user.new_email ?? null,
          app_metadata: metadataRecord(user.app_metadata),
          user_metadata: metadataRecord(user.user_metadata),
        }),
      ),
    );
  }
  return {
    version: 1,
    count: Object.keys(fingerprints).length,
    fingerprints,
  };
}

export function assertBrowserQaSnapshotUnchanged(
  before: BrowserQaSnapshot,
  after: BrowserQaSnapshot,
): void {
  if (
    before.version !== 1 ||
    after.version !== 1 ||
    before.count !== after.count ||
    JSON.stringify(stableValue(before.fingerprints)) !==
      JSON.stringify(stableValue(after.fingerprints))
  ) {
    throw new Error(
      "Protected browser-QA auth identities changed during the E2E job.",
    );
  }
}
