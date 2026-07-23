import fs from "node:fs";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

/**
 * Production suites must start from a storage state captured by completing the
 * real Hugo flow in a browser. They must never recreate a Sandra password
 * login after the Hugo cutover.
 */
export function requireHugoAuthStorageState(
  envName = "PROD_HUGO_STORAGE_STATE",
  baseURL = process.env.PROD_BASE_URL ?? "https://sandra.bmhgroupkc.com",
): string {
  const configured = process.env[envName];
  if (!configured) {
    throw new Error(
      `Set ${envName} to a Playwright storage-state file captured after a real Hugo login.`,
    );
  }
  const resolved = path.resolve(configured);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${envName} does not exist: ${resolved}`);
  }
  const state = JSON.parse(fs.readFileSync(resolved, "utf8")) as {
    cookies?: Array<{ name?: string; domain?: string }>;
  };
  const hostname = new URL(baseURL).hostname;
  const hasSandraCookie = state.cookies?.some((cookie) => {
    const domain = cookie.domain?.replace(/^\./, "");
    return (
      /^sb-copflsklaefwzipsrjqz-auth-token(?:\.(?:0|[1-9]\d*))?$/.test(
        cookie.name ?? "",
      ) &&
      Boolean(domain) &&
      (hostname === domain || hostname.endsWith(`.${domain}`))
    );
  });
  if (!hasSandraCookie) {
    throw new Error(
      `${envName} does not contain Sandra production auth state for ${hostname}.`,
    );
  }
  return resolved;
}

export async function assertExpectedSandraUser(page: Page): Promise<void> {
  const email = process.env.PROD_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new Error("Set PROD_EMAIL to the expected Hugo-authenticated user.");
  }
  await page.goto("/dashboard");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTitle(email, { exact: true })).toContainText(email);
}
