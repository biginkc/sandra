import { describe, expect, it } from "vitest";

import { isHoldAlertRecipient, resolveAppBaseUrl } from "./index";

const m = (over = {}) => ({
  user_id: "u",
  role: "member" as const,
  acquisitions_enabled: false,
  access_status: "active",
  access_expires_at: null,
  deletion_prepared_at: null,
  ...over,
});

describe("isHoldAlertRecipient", () => {
  it("accepts an active owner or an active acquisitions member", () => {
    expect(isHoldAlertRecipient(m({ role: "owner" }))).toBe(true);
    expect(isHoldAlertRecipient(m({ acquisitions_enabled: true }))).toBe(true);
  });
  it("rejects a plain member and any inactive access", () => {
    expect(isHoldAlertRecipient(m())).toBe(false);
    expect(isHoldAlertRecipient(m({ role: "owner", access_status: "suspended" }))).toBe(false);
    expect(isHoldAlertRecipient(m({ acquisitions_enabled: true, deletion_prepared_at: "2026-10-01T00:00:00Z" }))).toBe(false);
    expect(isHoldAlertRecipient(m({ role: "owner", access_expires_at: "2020-01-01T00:00:00Z" }))).toBe(false);
  });
});

describe("resolveAppBaseUrl", () => {
  it("normalizes scheme and trailing slashes", () => {
    expect(resolveAppBaseUrl({ NEXT_PUBLIC_APP_URL: "app.example.com/" })).toBe("https://app.example.com");
    expect(resolveAppBaseUrl({})).toBe("https://sandra-sooty.vercel.app");
  });
});
