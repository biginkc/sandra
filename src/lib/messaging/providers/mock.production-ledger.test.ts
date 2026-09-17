import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockMessagingProvider } from "./mock";

const LOOPBACK_SUPABASE_URL = "http://127.0.0.1:54321";
const LOOPBACK_LEDGER_URL = "http://127.0.0.1:3558/ledger";
const RUN_SLUG = "local-123-0123456789ab";

function validProductionBrowserEnv(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SEQUENCE_READINESS_PRODUCTION_BROWSER", "1");
  vi.stubEnv("SEQUENCE_READINESS_MOCK_PROVIDER_LEDGER", "1");
  vi.stubEnv("E2E_DISPOSABLE_DATABASE", "1");
  vi.stubEnv("MESSAGING_PROVIDER", "mock");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOOPBACK_SUPABASE_URL);
  vi.stubEnv("TEST_SUPABASE_URL", LOOPBACK_SUPABASE_URL);
  vi.stubEnv("E2E_RUN_SLUG", RUN_SLUG);
  vi.stubEnv(
    "E2E_TEST_USER_EMAIL",
    `e2e-ci+${RUN_SLUG}@bmhgroupkc.com`,
  );
  vi.stubEnv("E2E_TEST_USER_PASSWORD", "x".repeat(32));
  vi.stubEnv("SEQUENCE_READINESS_LEDGER_URL", LOOPBACK_LEDGER_URL);
  vi.stubEnv("SEQUENCE_READINESS_LEDGER_TOKEN", "test-ledger-token-1234");
}

describe("MockMessagingProvider production browser ledger gate", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("records a redacted receipt in the explicitly enabled loopback production lane", async () => {
    validProductionBrowserEnv();
    const provider = new MockMessagingProvider();

    await provider.sendSms({ to: "+15550001001", body: "hello" });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3558/ledger/events",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-ledger-token-1234",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      kind: "mock-provider-send",
      provider: "mock",
      externalId: expect.stringMatching(/^mock_/),
      to: "+15550001001",
    });
  });

  it.each([
    ["missing production browser flag", { SEQUENCE_READINESS_PRODUCTION_BROWSER: "0" }],
    ["hosted public Supabase URL", { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }],
    ["inconsistent test Supabase URL", { TEST_SUPABASE_URL: "http://localhost:54321" }],
    ["non-mock provider", { MESSAGING_PROVIDER: "sendillo" }],
    ["non-loopback ledger", { SEQUENCE_READINESS_LEDGER_URL: "http://localhost:3558/ledger" }],
    ["unvalidated run identity", { E2E_RUN_SLUG: "run-unknown" }],
  ])("does not fetch the ledger for %s", async (_reason, override) => {
    validProductionBrowserEnv();
    for (const [name, value] of Object.entries(override)) {
      vi.stubEnv(name, value);
    }
    const provider = new MockMessagingProvider();

    await provider.sendSms({ to: "+15550001002", body: "hello" });

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("keeps the production side effect disabled without disposable mode", async () => {
    validProductionBrowserEnv();
    vi.stubEnv("E2E_DISPOSABLE_DATABASE", "0");
    const provider = new MockMessagingProvider();

    await provider.sendSms({ to: "+15550001003", body: "hello" });

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
