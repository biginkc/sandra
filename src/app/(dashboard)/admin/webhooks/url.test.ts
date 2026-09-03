import { afterEach, describe, expect, it, vi } from "vitest";

import { webhookBaseUrl } from "./url";

describe("webhookBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the prod Vercel alias when NEXT_PUBLIC_SITE_URL is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(webhookBaseUrl()).toBe("https://sandra-sooty.vercel.app");
  });

  it("uses the apex domain when NEXT_PUBLIC_SITE_URL is set — production must set this", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://sandra.bmhgroupkc.com");
    expect(webhookBaseUrl()).toBe("https://sandra.bmhgroupkc.com");
  });

  it("trims a trailing slash from a configured URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://sandra.bmhgroupkc.com/");
    expect(webhookBaseUrl()).toBe("https://sandra.bmhgroupkc.com");
  });
});
