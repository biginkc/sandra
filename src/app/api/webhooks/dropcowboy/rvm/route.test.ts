import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { holder, admin, copy, pauses } = vi.hoisted(() => ({
  holder: { store: null as unknown },
  pauses: {
    orgs: [] as string[],
    calls: [] as Array<{ orgId: string; phone: string }>,
  },
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

vi.mock("@/lib/voicemail-drop/inbound-call", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voicemail-drop/inbound-call")>()),
  supabaseInboundCallPauseStore: () => ({
    orgIdsForDropRecipient: async () => pauses.orgs,
    pauseForCaller: async (orgId: string, phone: string) => {
      pauses.calls.push({ orgId, phone });
      return { matchedContactIds: ["c-1"], paused: 1 };
    },
  }),
}));

import { reportError } from "@/lib/errors/report";
import { createFakeDropStore } from "@/lib/voicemail-drop/status-updates.fake";

import { POST } from "./route";

const SECRET = "wh-secret";
const RECEIPT_SECRET = "wh-receipt-secret";
const CALL_SECRET = "wh-call-secret";
const LINE = "ae93c88d-4ebd-40c5-ae82-13e352848b9f";
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
  vi.stubEnv("DROPCOWBOY_CALL_WEBHOOK_SECRET", CALL_SECRET);
  vi.stubEnv("DROPCOWBOY_PHONE_LINE_ID", LINE);
  pauses.orgs = ["org-1"];
  pauses.calls = [];
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
      expect(copy).toHaveBeenCalledWith({ proofStore: true }, "11111111-1111-4111-8111-111111111111");
      expect(fake.drops[0]).toMatchObject({ proof_copy_status: "pending", proof_url_at: expect.any(String) });
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

    it("500s without marking the event processed when the receipt write fails, then the retry applies", async () => {
      fake.faults.receiptFailures = 1;
      const res = await POST(signed(receipt(), { secret: RECEIPT_SECRET }));
      expect(res.status).toBe(500);
      expect(copy).not.toHaveBeenCalled();
      expect(fake.events.get("contact.rvm.receipt:evt-r1")?.status).toBe("error");
      const retry = await POST(signed(receipt(), { secret: RECEIPT_SECRET }));
      expect(await retry.json()).toEqual({ ok: true, outcome: "applied" });
      expect(fake.drops[0]).toMatchObject({ proof_url: "https://proof.example/r/abc", proof_copy_status: "pending" });
    });

    it("keeps the event when the copy throws", async () => {
      copy.mockRejectedValueOnce(new Error("db down"));
      const res = await POST(signed(receipt(), { secret: RECEIPT_SECRET }));
      expect(await res.json()).toEqual({ ok: true, outcome: "applied" });
      expect(fake.drops[0].proof_url).toBe("https://proof.example/r/abc");
    });
  });

  describe("contact.call.ringing (call-back to the drop line)", () => {
    const ringing = (o: { eventId?: string; ivr?: string | null; from?: string | null; direction?: string } = {}) =>
      JSON.stringify({
        event: "contact.call.ringing",
        event_id: o.eventId ?? "evt-c1",
        event_at: Date.now(),
        data: {
          call_id: "call-1",
          team_id: "team-1",
          ivr_id: o.ivr === undefined ? LINE : o.ivr,
          call: { call_id: "call-1", from: o.from === undefined ? "(816) 555-0142" : o.from, to: "+18162032828", call_direction: o.direction ?? "inbound" },
        },
      });

    it("verifies with the call secret and pauses the real caller's drips", async () => {
      const res = await POST(signed(ringing(), { secret: CALL_SECRET }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, outcome: "paused" });
      expect(pauses.calls).toEqual([{ orgId: "org-1", phone: "+18165550142" }]);
      expect(fake.events.get("contact.call.ringing:evt-c1")?.status).toBe("processed");
    });

    it("never accepts a call event signed with the status or receipt secret", async () => {
      expect((await POST(signed(ringing()))).status).toBe(401);
      expect((await POST(signed(ringing(), { secret: RECEIPT_SECRET }))).status).toBe(401);
      expect(pauses.calls).toEqual([]);
    });

    it("401s and reports when DROPCOWBOY_CALL_WEBHOOK_SECRET is unset", async () => {
      vi.stubEnv("DROPCOWBOY_CALL_WEBHOOK_SECRET", "");
      expect((await POST(signed(ringing(), { secret: CALL_SECRET }))).status).toBe(401);
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("DROPCOWBOY_CALL_WEBHOOK_SECRET") }), expect.anything());
    });

    it("ignores calls to another line, dialer calls and outbound legs without recording them", async () => {
      for (const b of [ringing({ ivr: "other-line" }), ringing({ ivr: null }), ringing({ direction: "outbound" })]) {
        const res = await POST(signed(b, { secret: CALL_SECRET }));
        expect(res.status).toBe(200);
        expect((await res.json()).outcome).toMatch(/^ignored_/);
      }
      expect(pauses.calls).toEqual([]);
      expect(fake.events.size).toBe(0);
    });

    it("pauses nothing for an unmatched or missing caller", async () => {
      pauses.orgs = [];
      expect(await (await POST(signed(ringing({ eventId: "e-u1" }), { secret: CALL_SECRET }))).json()).toEqual({ ok: true, outcome: "unmatched" });
      pauses.orgs = ["org-1"];
      expect(await (await POST(signed(ringing({ eventId: "e-u2", from: null }), { secret: CALL_SECRET }))).json()).toEqual({ ok: true, outcome: "unmatched" });
      expect(pauses.calls).toEqual([]);
    });

    it("dedupes a replayed event_id", async () => {
      await POST(signed(ringing(), { secret: CALL_SECRET }));
      const res = await POST(signed(ringing(), { secret: CALL_SECRET }));
      expect(await res.json()).toEqual({ ok: true, outcome: "duplicate" });
      expect(pauses.calls).toHaveLength(1);
    });

    it("500s when DROPCOWBOY_PHONE_LINE_ID is unset", async () => {
      vi.stubEnv("DROPCOWBOY_PHONE_LINE_ID", "");
      expect((await POST(signed(ringing(), { secret: CALL_SECRET }))).status).toBe(500);
      expect(pauses.calls).toEqual([]);
    });
  });
});
