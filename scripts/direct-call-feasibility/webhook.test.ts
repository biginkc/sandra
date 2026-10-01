 
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleWebhookBody } from "./webhook-server";
import { verifyTelnyxSignature } from "./webhook-verify";
import { EventLog } from "./event-log";
import { isLocalRequest } from "./webhook-server";
import { parseFrames, handleStreamMessage } from "./stream-server";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
const NOW = 1_800_000_000_000;

function signed(body: string, ts = String(Math.floor(NOW / 1000))) {
  const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
  return { "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts } as Record<string, string>;
}

describe("webhook signature", () => {
  const body = JSON.stringify({ data: { id: "evt1", event_type: "call.answered", payload: { call_control_id: "leg1" } } });

  it("accepts a valid signature", () => {
    const h = signed(body);
    expect(verifyTelnyxSignature({ publicKeyBase64: pub, signatureBase64: h["telnyx-signature-ed25519"], timestamp: h["telnyx-timestamp"], rawBody: body, nowMs: NOW }).ok).toBe(true);
  });
  it("rejects a tampered body, wrong key and missing headers", () => {
    const h = signed(body);
    const base = { signatureBase64: h["telnyx-signature-ed25519"], timestamp: h["telnyx-timestamp"], nowMs: NOW };
    expect(verifyTelnyxSignature({ ...base, publicKeyBase64: pub, rawBody: body + " " }).ok).toBe(false);
    const other = (generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
    expect(verifyTelnyxSignature({ ...base, publicKeyBase64: other, rawBody: body }).ok).toBe(false);
    expect(verifyTelnyxSignature({ publicKeyBase64: pub, signatureBase64: undefined, timestamp: undefined, rawBody: body, nowMs: NOW }).ok).toBe(false);
  });
  it("rejects an expired timestamp (beyond 5 minutes) even if correctly signed", () => {
    const old = String(Math.floor(NOW / 1000) - 301);
    const h = signed(body, old);
    const r = verifyTelnyxSignature({ publicKeyBase64: pub, signatureBase64: h["telnyx-signature-ed25519"], timestamp: old, rawBody: body, nowMs: NOW });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });
  it("dedupes on event id and logs once", () => {
    const log = new EventLog();
    const deps = { publicKeyBase64: pub, log, nowMs: () => NOW };
    const h = signed(body);
    const a = handleWebhookBody(deps, h, Buffer.from(body));
    const b = handleWebhookBody(deps, h, Buffer.from(body));
    expect(a).toEqual({ status: 200, reason: undefined });
    expect(b).toEqual({ status: 200, reason: "duplicate" });
    expect(log.all()).toHaveLength(1);
    expect(handleWebhookBody(deps, { ...h, "telnyx-timestamp": "1" }, Buffer.from(body)).status).toBe(400);
  });
});

describe("localhost-only serving", () => {
  it("rejects tunnelled requests", () => {
    expect(isLocalRequest({ headers: { host: "localhost:8787" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "abc.trycloudflare.com" } })).toBe(false);
    expect(isLocalRequest({ headers: { host: "localhost:8787", "x-forwarded-for": "1.2.3.4" } })).toBe(false);
  });
});

describe("stream parsing", () => {
  function frame(text: string): Buffer {
    const payload = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const hdr = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([hdr, mask, masked]);
  }
  it("parses masked frames and counts per-track bytes without storing audio", () => {
    const { frames } = parseFrames(Buffer.concat([
      frame(JSON.stringify({ event: "start", start: { media_format: { encoding: "PCMU" } } })),
      frame(JSON.stringify({ event: "media", media: { track: "inbound", payload: Buffer.alloc(160).toString("base64") } })),
      frame(JSON.stringify({ event: "media", media: { track: "outbound", payload: Buffer.alloc(80).toString("base64") } })),
    ]));
    const stats = { startFrames: [] as unknown[], bytesByTrack: {} as Record<string, number> };
    for (const f of frames) handleStreamMessage(f.payload.toString(), stats);
    expect(stats.bytesByTrack).toEqual({ inbound: 160, outbound: 80 });
    expect(stats.startFrames).toHaveLength(1);
  });
});
