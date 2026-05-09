import { describe, expect, it } from "vitest";

import { isPublicPath } from "./middleware";

describe("isPublicPath", () => {
  it("allows OAuth and webhook routes to handle their own auth", () => {
    expect(isPublicPath("/api/oauth/slack/start")).toBe(true);
    expect(isPublicPath("/api/oauth/slack/callback")).toBe(true);
    expect(isPublicPath("/api/webhooks/slack/actions")).toBe(true);
  });

  it("allows signed Jitter internal API routes to handle their own auth", () => {
    expect(
      isPublicPath(
        "/api/internal/jitter/call-activities/by-jitter-attempt/attempt-1",
      ),
    ).toBe(true);
    expect(
      isPublicPath(
        "/api/internal/jitter/call-activities/call-activity-1/transcript",
      ),
    ).toBe(true);
  });

  it("keeps dashboard routes protected", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/leads/property-1")).toBe(false);
  });
});
