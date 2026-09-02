import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/esign/credentials", () => ({
  configuredDropboxSignEmbeddedDomain: vi.fn(),
  getEsignCredentials: vi.fn(),
}));
vi.mock("@/lib/esign/dropbox-sign", () => ({
  createDropboxSignProvider: vi.fn(),
}));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { GET } from "./route";

describe("eSign send reconciliation cron", () => {
  beforeEach(() => vi.stubEnv("CRON_SECRET", "cron-test-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed when the cron secret is missing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(new Request("https://sandra.test/api/cron/esign-send-reconciliation"));
    expect(response.status).toBe(500);
  });

  it("rejects requests without the exact cron authorization", async () => {
    const response = await GET(
      new Request("https://sandra.test/api/cron/esign-send-reconciliation", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
