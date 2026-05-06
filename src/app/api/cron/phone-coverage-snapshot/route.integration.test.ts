import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the lib so route tests focus on HTTP handler behaviour (auth,
// response shape) rather than DB logic.  The lib itself is exercised
// separately in phone-coverage.integration.test.ts.
vi.mock("@/lib/metrics/phone-coverage", () => ({
  capturePhoneCoverageSnapshot: vi.fn(),
}));

import { capturePhoneCoverageSnapshot } from "@/lib/metrics/phone-coverage";
import { GET, POST } from "./route";

const CRON_SECRET = "test-cron-secret-for-phone-coverage";

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const k of keys) SAVED_ENV[k] = process.env[k];
}
function restoreEnv(...keys: string[]) {
  for (const k of keys) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

const ENV_KEYS = [
  "CRON_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

beforeEach(() => {
  saveEnv(...ENV_KEYS);
  process.env.CRON_SECRET = CRON_SECRET;
  // Dummy values — capturePhoneCoverageSnapshot is mocked so no real DB
  // call happens; buildServiceRoleClient() still validates their presence.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";
  vi.mocked(capturePhoneCoverageSnapshot).mockReset();
});

afterEach(() => {
  restoreEnv(...ENV_KEYS);
});

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  return new Request(
    "http://localhost/api/cron/phone-coverage-snapshot",
    { headers },
  );
}

describe("phone-coverage-snapshot cron route", () => {
  it("returns 401 with no auth header", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const res = await GET(makeRequest("Bearer wrong-token"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with { ok, numerator, denominator } on correct token", async () => {
    vi.mocked(capturePhoneCoverageSnapshot).mockResolvedValue({
      numerator: 1324,
      denominator: 1383,
    });

    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, numerator: 1324, denominator: 1383 });
  });

  it("returns 200 via POST as well as GET", async () => {
    vi.mocked(capturePhoneCoverageSnapshot).mockResolvedValue({
      numerator: 0,
      denominator: 0,
    });

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
  });

  it("returns 500 with error message on DB failure", async () => {
    vi.mocked(capturePhoneCoverageSnapshot).mockRejectedValue(
      new Error("connection refused"),
    );

    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: "connection refused" });
  });
});
