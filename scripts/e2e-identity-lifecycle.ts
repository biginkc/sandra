import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";

import type { Database } from "../src/lib/supabase/types";
import {
  assertBrowserQaSnapshotUnchanged,
  assertCleanupCandidate,
  assertExistingUserMatchesIdentity,
  createGitHubRunEnvironment,
  ensureE2ERunEnvironment,
  identityForPrincipal,
  snapshotProtectedBrowserQaUsers,
  type BrowserQaSnapshot,
  type E2EIdentity,
} from "../src/lib/supabase/e2e-identity-guard";
import { assertSafeE2ESupabaseTargetFromEnvironment } from "../src/lib/supabase/e2e-target-safety";

const MAX_USER_PAGES = 50;
const USERS_PER_PAGE = 1000;

function appendGitHubEnvironment(name: string, value: string): void {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) throw new Error("E2E identity emission requires GITHUB_ENV.");
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("E2E identity emission rejected a multiline value.");
  }
  appendFileSync(githubEnv, `${name}=${value}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function statePath(): string {
  const value = process.env.E2E_QA_GUARD_STATE;
  if (!value) throw new Error("E2E browser-QA guard state path is missing.");
  return value;
}

function adminClient(): SupabaseClient<Database> {
  const url = process.env.TEST_SUPABASE_URL ?? "";
  const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "E2E identity lifecycle requires the test Supabase URL and service-role key.",
    );
  }
  assertSafeE2ESupabaseTargetFromEnvironment(url);
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function listAllUsers(client: SupabaseClient<Database>): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: USERS_PER_PAGE,
    });
    if (error) {
      throw new Error(`E2E identity user inventory failed: ${error.message}`);
    }
    const pageUsers = data?.users ?? [];
    users.push(...pageUsers);
    if (pageUsers.length < USERS_PER_PAGE) return users;
  }
  throw new Error(
    "E2E identity user inventory exceeded its fail-closed page bound.",
  );
}

function currentRunIdentities(): E2EIdentity[] {
  const run = ensureE2ERunEnvironment();
  return [
    identityForPrincipal(run, "primary"),
    identityForPrincipal(run, "assignee"),
  ];
}

function exactMatches(users: readonly User[], identity: E2EIdentity): User[] {
  return users.filter(
    (user) => user.email?.trim().toLowerCase() === identity.email,
  );
}

function assertNoRunCollision(
  users: readonly User[],
  identities: readonly E2EIdentity[],
): void {
  const expectedEmails = new Set(identities.map((identity) => identity.email));
  for (const identity of identities) {
    const matches = exactMatches(users, identity);
    if (matches.length > 1) {
      throw new Error(
        "CI E2E preflight found duplicate users in an exact run namespace.",
      );
    }
    if (matches[0]) assertExistingUserMatchesIdentity(matches[0], identity);
  }

  for (const user of users) {
    const metadata = user.app_metadata ?? {};
    if (
      metadata.owner === "github-actions" &&
      metadata.purpose === "ci-e2e" &&
      metadata.run_slug === identities[0]?.runSlug &&
      !expectedEmails.has(user.email?.trim().toLowerCase() ?? "")
    ) {
      throw new Error(
        "CI E2E preflight found unexpected metadata inside this run namespace.",
      );
    }
  }
}

function emit(): void {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Job-scoped E2E identity emission is GitHub Actions only.");
  }
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp)
    throw new Error("E2E identity emission requires RUNNER_TEMP.");
  const run = createGitHubRunEnvironment();
  const primary = identityForPrincipal(run);
  const guardState = path.join(
    runnerTemp,
    `sandra-e2e-browser-qa-${run.runSlug}.json`,
  );
  appendGitHubEnvironment("E2E_RUN_SLUG", primary.runSlug);
  appendGitHubEnvironment("E2E_TEST_USER_EMAIL", primary.email);
  console.log(`::add-mask::${primary.password}`);
  appendGitHubEnvironment("E2E_TEST_USER_PASSWORD", primary.password);
  appendGitHubEnvironment("E2E_QA_GUARD_STATE", guardState);
  console.log(
    "Emitted one job-scoped E2E identity without logging private values.",
  );
}

async function preflight(): Promise<void> {
  const identities = currentRunIdentities();
  const client = adminClient();
  const users = await listAllUsers(client);
  assertNoRunCollision(users, identities);
  const snapshot = snapshotProtectedBrowserQaUsers(users);
  writeFileSync(statePath(), `${JSON.stringify(snapshot)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    `Protected browser-QA circuit breaker armed for ${snapshot.count} identity record(s).`,
  );
}

function readSnapshot(): BrowserQaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    throw new Error(
      "E2E cleanup refused to run without a valid browser-QA snapshot.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as BrowserQaSnapshot).version !== 1 ||
    typeof (parsed as BrowserQaSnapshot).count !== "number" ||
    !(parsed as BrowserQaSnapshot).fingerprints ||
    typeof (parsed as BrowserQaSnapshot).fingerprints !== "object"
  ) {
    throw new Error("E2E cleanup refused an invalid browser-QA snapshot.");
  }
  return parsed as BrowserQaSnapshot;
}

async function cleanup(): Promise<void> {
  const identities = currentRunIdentities();
  const before = readSnapshot();
  const client = adminClient();
  const usersBefore = await listAllUsers(client);

  // Fail before any cleanup write if a browser-QA identity changed during the
  // job. A later operator can retry exact-run cleanup after adjudication.
  assertBrowserQaSnapshotUnchanged(
    before,
    snapshotProtectedBrowserQaUsers(usersBefore),
  );

  let deleted = 0;
  for (const identity of identities) {
    const matches = exactMatches(usersBefore, identity);
    if (matches.length > 1) {
      throw new Error("CI E2E cleanup refused duplicate exact-run users.");
    }
    const candidate = matches[0];
    if (!candidate) continue;
    assertCleanupCandidate(candidate, identity);
    const { error } = await client.auth.admin.deleteUser(candidate.id);
    if (error) {
      throw new Error(`CI E2E exact-run cleanup failed: ${error.message}`);
    }
    deleted += 1;
  }

  const usersAfter = await listAllUsers(client);
  assertBrowserQaSnapshotUnchanged(
    before,
    snapshotProtectedBrowserQaUsers(usersAfter),
  );
  for (const identity of identities) {
    if (exactMatches(usersAfter, identity).length > 0) {
      throw new Error("CI E2E exact-run cleanup did not remove its identity.");
    }
  }
  console.log(
    `Removed ${deleted} exact-run E2E principal(s); no other auth users were targeted.`,
  );
}

const command = process.argv[2];
if (command === "emit") {
  emit();
} else if (command === "preflight") {
  await preflight();
} else if (command === "cleanup") {
  await cleanup();
} else {
  throw new Error("Usage: e2e-identity-lifecycle.ts <emit|preflight|cleanup>");
}
