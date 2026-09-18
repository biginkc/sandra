import { createBrowserClient } from "@supabase/ssr";
import { test as base, expect, type BrowserContextOptions } from "@playwright/test";

export type { Page, Request } from "@playwright/test";

import type { Database } from "../../src/lib/supabase/types";
import {
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from "../fixtures";

type StorageState = Exclude<BrowserContextOptions["storageState"], undefined>;

type AcceptanceAuthSession = {
  auth: ReturnType<typeof createBrowserClient<Database>>;
  storageState: StorageState;
};

/**
 * Open a new ordinary Supabase session for the exact run user.
 *
 * The setup project still provisions the user and verifies the login shell,
 * but its storageState is intentionally not reused by acceptance tests. The
 * workset/session SQL limits are part of the contract, so each test gets a
 * distinct refresh token and the fixture revokes that session before the next
 * serial test starts.
 */
async function openAcceptanceAuthSession(): Promise<AcceptanceAuthSession> {
  const url = process.env.TEST_SUPABASE_URL ?? "";
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY ?? "";
  if (!url || !anonKey) {
    throw new Error(
      "Inbox acceptance auth fixture requires TEST_SUPABASE_URL and TEST_SUPABASE_ANON_KEY.",
    );
  }

  const cookieJar = new Map<string, string>();
  const auth = createBrowserClient<Database>(url, anonKey, {
    isSingleton: false,
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.value) cookieJar.set(cookie.name, cookie.value);
          else cookieJar.delete(cookie.name);
        }
      },
    },
  });

  const { error } = await auth.auth.signInWithPassword({
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  });
  if (error) throw error;
  if (cookieJar.size === 0) {
    throw new Error(
      "Inbox acceptance auth fixture sign-in returned no browser cookies.",
    );
  }

  return {
    auth,
    storageState: {
      cookies: [...cookieJar].map(([name, value]) => ({
        name,
        value,
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax" as const,
      })),
      origins: [],
    },
  };
}

type AcceptanceFixtures = {
  storageState: StorageState;
};

/**
 * Acceptance-only Playwright test object.
 *
 * Keep this suite serial and retain the existing advisory lock/provider
 * double. Replacing only storageState preserves Playwright's normal fresh
 * browser context per test while preventing every context from sharing the
 * setup project's long-lived auth/workset session.
 */
export const test = base.extend<AcceptanceFixtures>({
  storageState: async ({}, runFixture) => {
    const session = await openAcceptanceAuthSession();
    try {
      await runFixture(session.storageState);
    } finally {
      // This run identity is namespaced by E2E_RUN_SLUG and is not shared by
      // another acceptance run. Global scope is therefore the only Supabase
      // sign-out mode that revokes the server-side session/workset promptly;
      // local scope would merely clear cookies and leave the session active.
      session.auth.auth.stopAutoRefresh();
      const { error } = await session.auth.auth.signOut({ scope: "global" });
      if (error) {
        throw new Error(
          `Inbox acceptance auth fixture could not revoke its test session: ${error.message}`,
        );
      }
    }
  },
});

export { expect };
