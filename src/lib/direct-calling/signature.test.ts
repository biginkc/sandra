import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyTelnyxSignature } from "./signature";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const NOW = 1_790_000_000_000;
const ts = String(Math.floor(NOW / 1000));
const body = '{"data":{"id":"evt"}}';
const sig = (t: string, b: string) => sign(null, Buffer.from(`${t}|${b}`), privateKey).toString("base64");

describe("verifyTelnyxSignature", () => {
  const base = { rawBody: body, signature: sig(ts, body), timestamp: ts, publicKeyBase64: rawKey, nowMs: NOW };
  it("accepts a valid signature", () => expect(verifyTelnyxSignature(base)).toEqual({ ok: true }));
  it("rejects a tampered body", () => expect(verifyTelnyxSignature({ ...base, rawBody: body + " " })).toMatchObject({ ok: false, reason: "bad_signature" }));
  it("rejects a signature over a different timestamp", () =>
    expect(verifyTelnyxSignature({ ...base, signature: sig(String(Number(ts) - 1), body) })).toMatchObject({ ok: false }));
  it("rejects expired and future timestamps", () => {
    const old = String(Number(ts) - 301);
    expect(verifyTelnyxSignature({ ...base, timestamp: old, signature: sig(old, body) })).toMatchObject({ reason: "expired" });
    const future = String(Number(ts) + 301);
    expect(verifyTelnyxSignature({ ...base, timestamp: future, signature: sig(future, body) })).toMatchObject({ reason: "expired" });
  });
  it("rejects missing headers and malformed input", () => {
    expect(verifyTelnyxSignature({ ...base, signature: null })).toMatchObject({ reason: "missing_headers" });
    expect(verifyTelnyxSignature({ ...base, timestamp: null })).toMatchObject({ reason: "missing_headers" });
    expect(verifyTelnyxSignature({ ...base, timestamp: "abc" })).toMatchObject({ reason: "bad_timestamp" });
    expect(verifyTelnyxSignature({ ...base, signature: "not base64!" })).toMatchObject({ ok: false });
    expect(verifyTelnyxSignature({ ...base, publicKeyBase64: "AAAA" })).toMatchObject({ reason: "bad_key" });
  });
  it("rejects a signature from another key", () => {
    const other = generateKeyPairSync("ed25519");
    const forged = sign(null, Buffer.from(`${ts}|${body}`), other.privateKey).toString("base64");
    expect(verifyTelnyxSignature({ ...base, signature: forged })).toMatchObject({ reason: "bad_signature" });
  });
});
