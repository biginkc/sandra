import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { holder, admin } = vi.hoisted(() => ({ holder: { store: null as unknown }, admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: admin }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));
vi.mock("@/lib/voicemail-drop/status-updates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voicemail-drop/status-updates")>()),
  supabaseDropStatusStore: () => holder.store,
}));

import { createFakeDropStore } from "@/lib/voicemail-drop/status-updates.fake";

import { POST } from "./route";

const SECRET = "wh-secret";
let fake: ReturnType<typeof createFakeDropStore>;

function signed(body: string, opts: { ts?: number; secret?: string } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${body}`).digest("hex");
  return new Request("https://synthetic.invalid/rvm", {
    method: "POST",
    body,
    headers: { "x-timestamp": ts, "x-signature": `sha256=${sig}` },
  });
}

const body = (eventId = "evt-1") =>
  JSON.stringify({ event: "contact.rvm.status", event_id: eventId, data: { drop_id: "dc-1", status: "failure", reason_code: 4016 } });

beforeEach(() => {
  vi.stubEnv("DROPCOWBOY_WEBHOOK_SECRET", SECRET);
  fake = createFakeDropStore([
    { id: "11111111-1111-4111-8111-111111111111", enrollment_id: "enr-1", status: "queued", drop_id: "dc-1", to_phone: "+18165550101", queued_at: new Date().toISOString() },
  ]);
  holder.store = fake.store;
});
afterEach(() => vi.unstubAllEnvs());

describe("dropcowboy rvm webhook route", () => {
  it("accepts a valid signature and applies the event", async () => {
    const res = await POST(signed(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "applied" });
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: "voicemail_drop_consent_blocked" }]);
  });

  it("rejects an invalid signature", async () => {
    expect((await POST(signed(body(), { secret: "wrong" }))).status).toBe(401);
    expect(fake.paused).toEqual([]);
  });

  it("rejects a stale timestamp", async () => {
    expect((await POST(signed(body(), { ts: Math.floor(Date.now() / 1000) - 301 }))).status).toBe(401);
  });

  it("rejects missing signature headers", async () => {
    expect((await POST(new Request("https://synthetic.invalid/rvm", { method: "POST", body: body() }))).status).toBe(401);
  });

  it("dedupes a replayed event_id", async () => {
    await POST(signed(body()));
    const res = await POST(signed(body()));
    expect(await res.json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(fake.paused).toHaveLength(1);
  });

  it("503 when the signing secret is not configured", async () => {
    vi.stubEnv("DROPCOWBOY_WEBHOOK_SECRET", "");
    expect((await POST(signed(body()))).status).toBe(503);
  });
});
