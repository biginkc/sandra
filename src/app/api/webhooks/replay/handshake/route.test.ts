import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54331";
});
afterEach(() => {
  delete process.env.SMS_PROVIDER_STUB;
  delete process.env.VERCEL_ENV;
});

describe("GET /api/webhooks/replay/handshake", () => {
  it("does not exist (404) unless the replay stub is on", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
  });
  it("answers 500 when the stub flag is set on a hosted deployment", async () => {
    process.env.SMS_PROVIDER_STUB = "1";
    process.env.VERCEL_ENV = "production";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(500);
    // reason is logged server-side via the reporter
    expect(JSON.stringify(spy.mock.calls)).toContain("VERCEL_ENV is set");
    spy.mockRestore();
    // fixed string only: the refusal reason (env details) must not leak
    expect(await res.json()).toEqual({ error: "replay stub misconfigured" });
  });
  it("answers with the stub state when the stub is on", async () => {
    process.env.SMS_PROVIDER_STUB = "1";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayStub: true });
  });
});
