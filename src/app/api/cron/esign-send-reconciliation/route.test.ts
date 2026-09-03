import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/esign/credentials", () => ({
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
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

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
        property_id: "property-1",
        test_mode: true,
        delivery_state: "sending",
        updated_at: "2026-09-02T00:00:00.000Z",
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

  it("bounds provider lookup with a local race when the SDK ignores abort", async () => {
    vi.useFakeTimers();
    vi.mocked(getEsignCredentials).mockResolvedValue({
      apiKey: { reveal: () => "secret" },
      clientId: "client-1",
      sendingEnabled: true,
    } as never);
    const findSignatureRequestIdsByLocalRequestId = vi.fn(
      (_localRequestId: string, _testMode: boolean, signal: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return new Promise<never>(() => undefined);
      },
    );
    vi.mocked(createDropboxSignProvider).mockReturnValue({
      findSignatureRequestIdsByLocalRequestId,
    } as never);
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "esign_requests") {
          return esignRequestsQuery({
            candidates: [{
              id: "request-hangs",
              org_id: "org-1",
              property_id: "property-1",
              test_mode: true,
              delivery_state: "sending",
              updated_at: "2026-09-02T00:00:00.000Z",
            }],
            reference: {
              id: "known-local-request",
              sign_request_id: "known-provider-request",
            },
          });
        }
        return leadEventsQuery([]);
      }),
      rpc: vi.fn().mockResolvedValue({ error: null }),
    } as never);

    const responsePromise = GET(
      new Request("https://sandra.test/api/cron/esign-send-reconciliation", {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await responsePromise;

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checked: 1,
      lookupErrors: 1,
    });
    expect(findSignatureRequestIdsByLocalRequestId).toHaveBeenCalledTimes(1);
  });

  it("automatically fails a lost unknown send with positive-control evidence after the documented window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T02:00:00.000Z"));
    vi.mocked(getEsignCredentials).mockResolvedValue({
      apiKey: { reveal: () => "secret" },
      clientId: "client-1",
      sendingEnabled: true,
    } as never);
    vi.mocked(createDropboxSignProvider).mockReturnValue({
      findSignatureRequestIdsByLocalRequestId: vi.fn()
        .mockResolvedValueOnce({
          complete: true,
          providerRequestIds: ["known-provider-request"],
        })
        .mockResolvedValueOnce({ complete: true, providerRequestIds: [] }),
    } as never);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "esign_requests") {
          return esignRequestsQuery({
            candidates: [{
              id: "lost-request",
              org_id: "org-1",
              property_id: "property-1",
              test_mode: true,
              delivery_state: "send_unknown",
              updated_at: "2026-09-02T00:00:00.000Z",
            }],
            reference: {
              id: "known-local-request",
              sign_request_id: "known-provider-request",
            },
          });
        }
        return leadEventsQuery([
          { created_at: "2026-09-02T00:30:00.000Z" },
          { created_at: "2026-09-02T01:00:00.000Z" },
          { created_at: "2026-09-02T02:00:00.000Z" },
        ]);
      }),
      rpc,
    } as never);

    const response = await GET(
      new Request("https://sandra.test/api/cron/esign-send-reconciliation", {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checked: 1,
      failed: 1,
      unknown: 0,
    });
    expect(rpc).toHaveBeenCalledWith("resolve_esign_send_unknown_not_sent", {
      p_org_id: "org-1",
      p_request_id: "lost-request",
      p_actor_id: null,
      p_resolution_source: "automatic",
      p_error_message: "PROVIDER_SEND_NOT_FOUND",
      p_evidence: expect.objectContaining({
        positiveControl: "passed",
        consecutiveCompleteZeroCount: 3,
        minimumUnknownAgeMs: 3_600_000,
      }),
    });
  });

  it("repairs a provider-accepted timeout by attaching the found provider request id", async () => {
    vi.stubEnv("DROPBOX_SIGN_EMBEDDED_DOMAIN", "");
    vi.mocked(getEsignCredentials).mockResolvedValue({
      apiKey: { reveal: () => "secret" },
      clientId: "client-1",
      sendingEnabled: true,
    } as never);
    vi.mocked(createDropboxSignProvider).mockReturnValue({
      findSignatureRequestIdsByLocalRequestId: vi.fn()
        .mockResolvedValueOnce({
          complete: true,
          providerRequestIds: ["known-provider-request"],
        })
        .mockResolvedValueOnce({
          complete: true,
          providerRequestIds: ["provider-after-timeout"],
        }),
    } as never);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "esign_requests") {
          return esignRequestsQuery({
            candidates: [{
              id: "timeout-request",
              org_id: "org-1",
              property_id: "property-1",
              test_mode: true,
              delivery_state: "send_unknown",
              updated_at: "2026-09-02T00:00:00.000Z",
            }],
            reference: {
              id: "known-local-request",
              sign_request_id: "known-provider-request",
            },
          });
        }
        return leadEventsQuery([]);
      }),
      rpc,
    } as never);

    const response = await GET(
      new Request("https://sandra.test/api/cron/esign-send-reconciliation", {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checked: 1,
      failed: 0,
      sent: 1,
      unknown: 0,
    });
    expect(rpc).toHaveBeenCalledWith("attach_esign_request_provider_delivery", {
      p_org_id: "org-1",
      p_request_id: "timeout-request",
      p_provider_request_id: "provider-after-timeout",
      p_resolution_source: "automatic",
      p_evidence: expect.objectContaining({
        localRequestId: "timeout-request",
        providerRequestId: "provider-after-timeout",
        positiveControl: "passed",
      }),
    });
    expect(createDropboxSignProvider).toHaveBeenCalledWith({
      apiKey: expect.anything(),
      clientId: "client-1",
    });
  });
});

function candidateQuery(data: readonly unknown[]) {
  return esignRequestsQuery({ candidates: data, reference: null });
}

function esignRequestsQuery(input: {
  candidates: readonly unknown[];
  reference: unknown;
}) {
  let selectedReference = false;
  const query = {
    select: vi.fn((columns: string) => {
      selectedReference = columns === "id,sign_request_id";
      return query;
    }),
    in: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({
      data: selectedReference ? input.reference : null,
      error: null,
    })),
    limit: vi.fn(() => {
      return selectedReference
        ? query
        : Promise.resolve({ data: input.candidates, error: null });
    }),
  };
  return query;
}

function leadEventsQuery(data: readonly unknown[]) {
  return {
    insert: vi.fn().mockResolvedValue({ error: null }),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    contains: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data, error: null }),
  };
}
