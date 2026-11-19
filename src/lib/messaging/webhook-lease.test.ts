import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WEBHOOK_PROCESSING_LEASE_MS } from "./webhook-lease";

/**
 * Routing v2 A-2 treats a newer text that is saved but not yet stamped as still inside its webhook
 * for WEBHOOK_PROCESSING_LEASE_MS. That is only safe while no inbound SMS webhook can run longer
 * than the lease: raising a route's maxDuration past it would silently reopen A-2.
 */
const ROUTES = ["sendillo", "dialpad", "twilio"].map((p) => path.resolve(__dirname, `../../app/api/webhooks/${p}/sms/route.ts`));

describe("webhook lease vs the inbound SMS webhook routes' maxDuration", () => {
  it.each(ROUTES)("%s declares maxDuration and it fits inside the lease", (file) => {
    const m = /export const maxDuration = (\d+);/.exec(readFileSync(file, "utf8"));
    expect(m, `${file} must export a literal maxDuration`).not.toBeNull();
    expect(Number(m![1]) * 1000).toBeLessThanOrEqual(WEBHOOK_PROCESSING_LEASE_MS);
  });
});
