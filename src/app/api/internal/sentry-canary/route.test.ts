import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), capture: vi.fn(), checkIn: vi.fn(), flush: vi.fn(), start: vi.fn(), tag: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  getClient: mocks.client,
  captureException: mocks.capture,
  captureCheckIn: mocks.checkIn,
  flush: mocks.flush,
  withScope: (callback: (scope: { setTag: typeof mocks.tag }) => void) => callback({ setTag: mocks.tag }),
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
import { POST } from "./route";

function request(mode: string, secret?: string) {
  return new Request("https://preview.example/api/internal/sentry-canary", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-sandra-canary-secret": secret } : {}) },
    body: JSON.stringify({ mode }),
  });
}

describe("preview-only Sentry canary", () => {
  const priorEnv = process.env.VERCEL_ENV;
  const priorSecret = process.env.SENTRY_CANARY_SECRET;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_ENV = "preview";
    process.env.SENTRY_CANARY_SECRET = "owned-canary-secret";
    mocks.client.mockReturnValue({});
    mocks.capture.mockReturnValue("safe-event-id");
    mocks.checkIn.mockReturnValue("check-in-id");
    mocks.flush.mockResolvedValue(true);
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = priorEnv;
    if (priorSecret === undefined) delete process.env.SENTRY_CANARY_SECRET; else process.env.SENTRY_CANARY_SECRET = priorSecret;
  });

  it("never starts a Workflow or captures an event without preview and the exact secret", async () => {
    expect((await POST(request("workflow"))).status).toBe(404);
    process.env.VERCEL_ENV = "production";
    expect((await POST(request("server", "owned-canary-secret"))).status).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("captures a controlled server event and reports transport outcome", async () => {
    const response = await POST(request("server", "owned-canary-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ eventId: "safe-event-id", delivered: true });
    expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({ message: "Controlled Sentry preview server failure" }));
    expect(mocks.flush).toHaveBeenCalledWith(2_000);
  });

  it("starts the real Workflow entry point only for an authorized preview request", async () => {
    mocks.start.mockResolvedValue({ runId: "canary-run" });
    const response = await POST(request("workflow", "owned-canary-secret"));
    expect(await response.json()).toEqual({ runId: "canary-run" });
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("sends a controlled failed Cron check-in from the preview runtime", async () => {
    const response = await POST(request("cron_error", "owned-canary-secret"));
    expect(response.status).toBe(200);
    expect(mocks.checkIn).toHaveBeenCalledWith(
      expect.objectContaining({ monitorSlug: "sandra-sentry-preview-canary", status: "error" }),
    );
    expect(mocks.flush).toHaveBeenCalledWith(2_000);
  });
  it("issues a short-lived HttpOnly browser canary cookie after authorization", async () => {
    const response = await POST(request("session", "owned-canary-secret"));
    expect(await response.json()).toEqual({ ready: true });
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly.*Max-Age=300|Max-Age=300.*HttpOnly/i);
    expect(response.headers.get("set-cookie")).not.toContain("owned-canary-secret");
  });
});
