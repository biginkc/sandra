import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { holder, admin, copy } = vi.hoisted(() => ({
  holder: { store: null as unknown },
  admin: vi.fn(),
  copy: vi.fn(async () => "stored"),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: admin }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));
vi.mock("@/lib/voicemail-drop/proof-copy", () => ({
  supabaseProofCopyStore: () => ({ proofStore: true }),
  copyDropProof: copy,
}));
vi.mock("@/lib/voicemail-drop/status-updates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voicemail-drop/status-updates")>()),
  supabaseDropStatusStore: () => holder.store,
}));

import { reportError } from "@/lib/errors/report";
import { createFakeDropStore } from "@/lib/voicemail-drop/status-updates.fake";

import { POST } from "./route";

const SECRET = "wh-secret";
const RECEIPT_SECRET = "wh-receipt-secret";
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
  vi.stubEnv("DROPCOWBOY_RECEIPT_WEBHOOK_SECRET", RECEIPT_SECRET);
  copy.mockClear();
  vi.mocked(reportError).mockClear();
  fake = createFakeDropStore([
    { id: "11111111-1111-4111-8111-111111111111", enrollment_id: "enr-1", step_run_id: "run-1", status: "queued", attempt_outcome: "queued", drop_id: "dc-1", to_phone: "+18165550101", queued_at: new Date().toISOString() },
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

  it("acknowledges 200 and ignores an unsupported event type", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await POST(signed(JSON.stringify({ event: "contact.sms.status", event_id: "e-x", data: { status: "success" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "ignored" });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("contact.sms.status"));
    expect(fake.paused).toEqual([]);
    info.mockRestore();
  });

  it("acknowledges an unsupported event without a secret for it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const b = JSON.stringify({ event: "campaign.started", event_id: "e-y", data: {} });
    const res = await POST(signed(b, { secret: "wrong" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "ignored" });
    info.mockRestore();
  });

  it("400s a body that is not JSON", async () => {
    expect((await POST(signed("not json"))).status).toBe(400);
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

  it("401s and reports a status event when its secret is not configured", async () => {
    vi.stubEnv("DROPCOWBOY_WEBHOOK_SECRET", "");
    expect((await POST(signed(body()))).status).toBe(401);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("DROPCOWBOY_WEBHOOK_SECRET") }), expect.anything());
    expect(fake.paused).toEqual([]);
  });

  it("never accepts a status event signed with the receipt secret", async () => {
    expect((await POST(signed(body(), { secret: RECEIPT_SECRET }))).status).toBe(401);
    expect(fake.paused).toEqual([]);
  });

  describe("contact.rvm.receipt", () => {
    const receipt = (eventId = "evt-r1") =>
      JSON.stringify({
        event: "contact.rvm.receipt",
        event_id: eventId,
        data: { drop_id: "dc-1", status: "success", reason_code: 0, proof_of_delivery_url: "https://proof.example/r/abc", receipt_ready_at: "2026-10-21T00:00:00Z" },
      });

    it("verifies with the receipt secret, saves proof_url and copies the recording", async () => {
      const res = await POST(signed(receipt(), { secret: RECEIPT_SECRET }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, outcome: "applied" });
      expect(fake.drops[0].proof_url).toBe("https://proof.example/r/abc");
      expect(copy).toHaveBeenCalledWith({ proofStore: true }, "11111111-1111-4111-8111-111111111111", { receivedAt: expect.any(Date) });
    });

    it("never accepts a receipt signed with the status secret", async () => {
      expect((await POST(signed(receipt()))).status).toBe(401);
      expect(copy).not.toHaveBeenCalled();
    });

    it("401s and reports a receipt when DROPCOWBOY_RECEIPT_WEBHOOK_SECRET is unset", async () => {
      vi.stubEnv("DROPCOWBOY_RECEIPT_WEBHOOK_SECRET", "");
      expect((await POST(signed(receipt(), { secret: RECEIPT_SECRET }))).status).toBe(401);
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("DROPCOWBOY_RECEIPT_WEBHOOK_SECRET") }), expect.anything());
    });

    it("keeps the event when the copy throws", async () => {
      copy.mockRejectedValueOnce(new Error("db down"));
      const res = await POST(signed(receipt(), { secret: RECEIPT_SECRET }));
      expect(await res.json()).toEqual({ ok: true, outcome: "applied" });
      expect(fake.drops[0].proof_url).toBe("https://proof.example/r/abc");
    });
  });
});
