import { afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";

afterEach(() => {
  delete process.env.SMS_PROVIDER_STUB;
});

describe("GET /api/webhooks/replay/handshake", () => {
  it("does not exist (404) unless the replay stub is on", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
  });
  it("answers with the stub state when the stub is on", async () => {
    process.env.SMS_PROVIDER_STUB = "1";
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayStub: true });
  });
});
