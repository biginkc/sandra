import { describe, expect, it } from "vitest";

import { readConfig } from "./config";
import { assertStressLane, LaneRefusal, isLoopbackUrl } from "./guards";

const good = {
  STRESS_HARNESS: "1",
  E2E_DISPOSABLE_DATABASE: "1",
  E2E_CI_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55430/postgres",
  STRESS_SUPABASE_URL: "http://127.0.0.1:55431",
  STRESS_APP_URL: "http://127.0.0.1:3456",
  E2E_CRON_SECRET: "cron-secret-0123456789",
  DIALPAD_CTI_WEBHOOK_SECRET_E2E: "hook-secret-0123456789",
} as Record<string, string>;

function refusal(env: Record<string, string | undefined>): string | null {
  try {
    assertStressLane(readConfig(env), env);
    return null;
  } catch (e) {
    return e instanceof LaneRefusal ? e.code : `OTHER:${(e as Error).message}`;
  }
}

describe("stress lane guards", () => {
  it("accepts a fully loopback, opted-in, disposable environment", () => {
    expect(refusal(good)).toBeNull();
  });
  it("refuses without the opt-in", () => {
    expect(refusal({ ...good, STRESS_HARNESS: undefined })).toBe("NOT_OPTED_IN");
  });
  it("refuses without the disposable marker (#804 lane guard)", () => {
    expect(refusal({ ...good, E2E_DISPOSABLE_DATABASE: undefined })).toBe("LANE_UNSAFE");
  });
  it("refuses a non-loopback database", () => {
    expect(refusal({ ...good, E2E_CI_SUPABASE_DB_URL: "postgresql://u:p@db.example.com:5432/postgres" })).toMatch(/NON_LOOPBACK_ENV|LANE_UNSAFE/);
  });
  it("refuses a database URL that smuggles a host via query", () => {
    expect(refusal({ ...good, E2E_CI_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55430/postgres?host=evil.example.com" })).toMatch(/LANE_UNSAFE|DB_NOT_LOOPBACK/);
  });
  it("refuses any hosted Supabase reference anywhere in the environment", () => {
    expect(refusal({ ...good, SOME_OTHER_VAR: "https://abc.supabase.co" })).toBe("HOSTED_REF_IN_ENV");
    expect(refusal({ ...good, X: "ncsngxlcyxylaeskiteu" })).toBe("HOSTED_REF_IN_ENV");
  });
  it("refuses a non-loopback app, supabase or cron binding", () => {
    expect(refusal({ ...good, STRESS_APP_URL: "https://sandra.example.com" })).toBe("NON_LOOPBACK_ENV");
    expect(refusal({ ...good, STRESS_SUPABASE_URL: "http://10.0.0.5:55431" })).toBe("NON_LOOPBACK_ENV");
  });
  it("refuses a cron target that is not the app under test", () => {
    expect(refusal({ ...good, STRESS_CRON_BASE: "http://127.0.0.1:9999" })).toBe("CRON_TARGET_MISMATCH");
  });
  it("refuses hosted runtimes, the prod canary flag and a live leg in the stubbed run", () => {
    expect(refusal({ ...good, VERCEL_ENV: "preview" })).toBe("HOSTED_RUNTIME");
    expect(refusal({ ...good, RUN_PROD_CANARIES: "1" })).toBe("PROD_CANARY_FLAG");
    expect(refusal({ ...good, STRESS_LIVE_LEG: "1" })).toBe("LIVE_LEG_IN_STUB_RUN");
  });
  it("requires both secrets", () => {
    expect(refusal({ ...good, E2E_CRON_SECRET: undefined })).toBe("NO_CRON_SECRET");
    expect(refusal({ ...good, DIALPAD_CTI_WEBHOOK_SECRET_E2E: undefined })).toBe("NO_WEBHOOK_SECRET");
  });
  it("isLoopbackUrl", () => {
    expect(isLoopbackUrl("http://127.0.0.1:1")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1.evil.com:1")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
