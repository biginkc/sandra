import { beforeEach, describe, expect, it, vi } from "vitest";

const { runRecordingTick, schemaReady, reportError } = vi.hoisted(() => ({ runRecordingTick: vi.fn(), schemaReady: vi.fn(), reportError: vi.fn() }));
vi.mock("@/lib/dialpad-cti/recording-audio", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dialpad-cti/recording-audio")>()), runRecordingTick }));
vi.mock("@/lib/dialpad-cti/recording-audio-decode", () => ({ decodeMp3: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady }));
const createAdminClient = vi.fn(() => ({
  rpc: vi.fn(async () => ({ data: null, error: null })),
  storage: { getBucket: vi.fn(async () => ({ data: { public: false, file_size_limit: 33554432, allowed_mime_types: ["audio/mpeg"] }, error: null })), from: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminClient() }));

import { GET, POST, maxDuration } from "./route";

const request = (secret = "s") => new Request("https://sandra.example.test/api/cron/dialpad-recording-download", { headers: { authorization: `Bearer ${secret}` } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s";
  runRecordingTick.mockResolvedValue({ status: "idle", requests: 0, hosts: [] });
});

describe("/api/cron/dialpad-recording-download", () => {
  it("is a 60 s cron route for GET and POST", () => {
    expect(maxDuration).toBe(60);
    expect(POST).toBe(GET);
  });

  it("refuses a missing CRON_SECRET, a wrong secret and no secret, before anything else", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
    process.env.CRON_SECRET = "s";
    expect((await GET(request("nope"))).status).toBe(401);
    expect((await GET(new Request("https://x.test"))).status).toBe(401);
    expect(runRecordingTick).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("runs one tick anchored at the handler start and returns its summary", async () => {
    const before = Date.now();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "idle", requests: 0 });
    const [deps, t0] = runRecordingTick.mock.calls[0]!;
    expect(t0).toBeGreaterThanOrEqual(before);
    expect(t0).toBeLessThanOrEqual(Date.now());
    expect(typeof deps.fetchImpl).toBe("function");
  });

  it("asks the dialpad_call_audio readiness key (never artifact_fetch) and creates no Supabase client until something needs one", async () => {
    schemaReady.mockResolvedValue(false);
    runRecordingTick.mockImplementation(async (deps: { schemaReady: () => Promise<boolean> }) => {
      expect(await deps.schemaReady()).toBe(false);
      return { status: "disabled", reason: "schema", requests: 0, hosts: [] };
    });
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ status: "disabled", reason: "schema" });
    expect(schemaReady).toHaveBeenCalledTimes(1);
    expect(schemaReady).toHaveBeenCalledWith("dialpad_call_audio");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("the bucket check goes through Storage getBucket on the admin client", async () => {
    let ready = false;
    runRecordingTick.mockImplementation(async (deps: { bucketReady: () => Promise<boolean> }) => {
      ready = await deps.bucketReady();
      return { status: "idle", requests: 0, hosts: [] };
    });
    await GET(request());
    expect(ready).toBe(true);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });

  it("an unexpected failure is reported and answered as a 500 without detail", async () => {
    runRecordingTick.mockRejectedValue(new Error("boom with details"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("boom");
    expect(reportError).toHaveBeenCalledOnce();
  });
});
