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
import { getEsignCredentials } from "@/lib/esign/credentials";
import { createDropboxSignProvider } from "@/lib/esign/dropbox-sign";
import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";

describe("eSign send reconciliation cron", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron-test-secret");
    vi.mocked(getEsignCredentials).mockReset();
    vi.mocked(createDropboxSignProvider).mockReset();
    vi.mocked(reportError).mockReset();
    vi.mocked(createAdminClient).mockReset();
  });
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

  it("surfaces lookup exceptions separately from index deferrals", async () => {
    vi.mocked(getEsignCredentials).mockResolvedValue(null);
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn().mockReturnValue(candidateQuery([{
        id: "request-lookup-error",
        org_id: "org-1",
        test_mode: true,
      }])),
    } as never);

    const response = await GET(
      new Request("https://sandra.test/api/cron/esign-send-reconciliation", {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checked: 1,
      deferred: 0,
      lookupErrors: 1,
      errors: 0,
    });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: "cron_esign_send_reconciliation_lookup" },
      extra: { requestId: "request-lookup-error", orgId: "org-1" },
    });
  });
});

function candidateQuery(data: readonly unknown[]) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data, error: null }),
  };
}
