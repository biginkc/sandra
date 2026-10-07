import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    const res = await GET();
    expect(res.status).toBe(500);
  });
  it("answers with the stub state when the stub is on", async () => {
    process.env.SMS_PROVIDER_STUB = "1";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayStub: true });
  });
});
