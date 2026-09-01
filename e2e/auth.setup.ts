import { test as setup, expect } from "@playwright/test";
import { createBrowserClient } from "@supabase/ssr";

import {
  adminClient,
  ensureTestUser,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from "./fixtures";
import type { Database } from "../src/lib/supabase/types";

const AUTH_FILE = "e2e/.auth/user.json";

/**
 * One-time auth setup. The production UI is intentionally Hugo-only, while
 * the isolated E2E project has no Hugo OAuth client. Assert the real login
 * surface, then use the test project's password grant out of band solely to
 * seed Supabase SSR cookies for the remaining golden paths.
 */
setup("authenticate", async ({ page }) => {
  const admin = adminClient();
  await ensureTestUser(admin);

  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: /sign in with hugo/i }),
  ).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByText(/forgot password/i)).toHaveCount(0);

  const url = process.env.TEST_SUPABASE_URL ?? "";
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY ?? "";
  if (!url || !anonKey) {
    throw new Error("E2E auth setup requires test Supabase URL and anon key.");
  }

  const cookieJar = new Map<string, string>();
  const auth = createBrowserClient<Database>(url, anonKey, {
    isSingleton: false,
    cookies: {
      getAll: () =>
        [...cookieJar].map(([name, value]) => ({ name, value })),
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
  await page.context().addCookies(
    [...cookieJar].map(([name, value]) => ({
      name,
      value,
      url: "http://localhost:3456",
      sameSite: "Lax" as const,
    })),
  );

  await page.goto("/dashboard");
  await expect(page.locator("text=Sign out")).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
