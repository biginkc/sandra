import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSellerReminderJob: vi.fn(),
  reportError: vi.fn(),
  createAdminClient: vi.fn(() => ({ marker: "admin" })),
  sendSmsToContact: vi.fn(),
  getConsentState: vi.fn(),
  getMyLeadsFlag: vi.fn(),
  schemaReady: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/my-leads/seller-reminder", () => ({ runSellerReminderJob: mocks.runSellerReminderJob }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: mocks.sendSmsToContact }));
vi.mock("@/lib/messaging/consent", () => ({ getConsentState: mocks.getConsentState }));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: mocks.getMyLeadsFlag }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: mocks.schemaReady }));
vi.mock("@/lib/errors/cron-monitor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/errors/cron-monitor")>("@/lib/errors/cron-monitor");
  return { ...actual, runMonitoredCron: async (_slug: string, _cfg: unknown, run: () => Promise<Response>) => run() };
});

import { GET, POST } from "./handlers";
import * as route from "./route";

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const req = (auth?: string) =>
  new Request("http://localhost/api/cron/seller-appointment-reminders", {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  mocks.runSellerReminderJob.mockReset();
  mocks.reportError.mockReset();
});
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("seller-appointment-reminders cron route", () => {
  it("re-exports GET/POST and a 60 second budget like the rep sweep", () => {
    expect(route.GET).toBe(GET);
    expect(route.POST).toBe(POST);
    expect(route.maxDuration).toBe(60);
  });

  it("500s when CRON_SECRET is not configured, before touching anything", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(500);
    expect(mocks.runSellerReminderJob).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it.each([[undefined], ["Bearer wrong"], ["s3cret"], ["bearer s3cret"]])("401 for authorization %s", async (auth) => {
    const res = await POST(req(auth));
    expect(res.status).toBe(401);
    expect(mocks.runSellerReminderJob).not.toHaveBeenCalled();
  });

  it("runs the job for a correct bearer and returns its summary", async () => {
    mocks.runSellerReminderJob.mockResolvedValue({ ok: true, disabled: "flag_off" });
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, disabled: "flag_off" });
    expect(mocks.runSellerReminderJob).toHaveBeenCalledTimes(1);
  });

  it("wires the per-org flag, schema readiness and the transport into the job", async () => {
    mocks.runSellerReminderJob.mockResolvedValue({ ok: true, disabled: "copy_not_approved" });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(true);
    mocks.getConsentState.mockResolvedValue("opted_out");
    mocks.sendSmsToContact.mockResolvedValue({ status: "sent" });
    await GET(req("Bearer s3cret"));
    const deps = mocks.runSellerReminderJob.mock.calls[0][0];
    expect(await deps.getFlag("org-1")).toBe(true);
    expect(mocks.getMyLeadsFlag).toHaveBeenCalledWith("org-1", "seller_reminders");
    expect(await deps.schemaReady()).toBe(true);
    expect(mocks.schemaReady).toHaveBeenCalledWith("seller_reminders");
    expect(await deps.getConsent("k1")).toBe("opted_out");
    expect(mocks.getConsentState).toHaveBeenCalledWith({ marker: "admin" }, "k1", "sms");
    await deps.send({ origin: "manual" });
    expect(mocks.sendSmsToContact).toHaveBeenCalledWith({ marker: "admin" }, { origin: "manual" });
  });

  it("reports and 500s when the job throws", async () => {
    mocks.runSellerReminderJob.mockRejectedValue(new Error("db down"));
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db down" });
    expect(mocks.reportError).toHaveBeenCalled();
  });
});
