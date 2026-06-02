import { afterEach, describe, expect, it } from "vitest";

import { isAdminEmail, isEmailAllowed } from "./allowlist";

const originalAdminEmails = process.env.ADMIN_EMAILS;

afterEach(() => {
  process.env.ADMIN_EMAILS = originalAdminEmails;
});

describe("isEmailAllowed", () => {
  it("allows BMH Group workspace email addresses", () => {
    expect(isEmailAllowed("Jarrad@BMHGROUPKC.COM")).toBe(true);
  });

  it("rejects the old pre-prod test backdoor email", () => {
    const oldBackdoorEmail = ["claude", "test.com"].join("@");
    expect(isEmailAllowed(oldBackdoorEmail)).toBe(false);
  });

  it("rejects missing and non-BMH email addresses", () => {
    expect(isEmailAllowed(null)).toBe(false);
    expect(isEmailAllowed("person@example.com")).toBe(false);
  });
});

describe("isAdminEmail", () => {
  it("does not grant admin access when ADMIN_EMAILS is unset", () => {
    delete process.env.ADMIN_EMAILS;

    expect(isAdminEmail("admin-one@bmhgroupkc.com")).toBe(false);
  });

  it("only grants admin access to ADMIN_EMAILS entries", () => {
    process.env.ADMIN_EMAILS = "admin-one@bmhgroupkc.com";

    expect(isAdminEmail("ADMIN-ONE@BMHGROUPKC.COM")).toBe(true);
    expect(isAdminEmail("admin-two@bmhgroupkc.com")).toBe(false);
  });
});
