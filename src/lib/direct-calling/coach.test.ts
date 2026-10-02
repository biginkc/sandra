import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { closrOutbound123Bundle, closrOutbound123Ref } from "@biginkc/coach/fixtures";
import { bindDirectCoachCall, createDirectCoachStarter, directCoachStreamUrl } from "./coach";
import { makeRow } from "./test-support";

const secret = "s".repeat(32);
const now = Date.parse("2026-10-02T01:00:00Z");
const settings = { apiKey: "private", connectionId: "connection", appId: "app", webhookPublicKey: "key", callerIdE164: "+15550000000" };
const env = { DIRECT_COACH_ENABLED: "true", DIRECT_COACH_STREAM_URL: "wss://coach.example.com", DIRECT_COACH_STREAM_SECRET: secret, DIRECT_COACH_SCRIPT_SLUG: "approved" };
const row = () => makeRow({ status: "connected", seller_leg_id: "seller-leg", connected_at: new Date(now).toISOString(), time_limit_secs: 180 });

describe("direct Coach stream admission", () => {
  it("binds a reviewed digest once and refuses another call owner", async () => {
    let binding: Record<string, unknown> | null = null;
    const upsert = vi.fn(async (value: Record<string, unknown>) => { binding ??= value; return { error: null }; });
    const admin = { from(table: string) {
      const query = { select: () => query, eq: () => query, upsert, maybeSingle: async () => ({ error: null, data: table === "coach_call_index" ? binding : { digest: closrOutbound123Ref.digest, coach_script_revisions: { slug: closrOutbound123Ref.slug, revision: closrOutbound123Ref.revision, bundle: closrOutbound123Bundle, import_status: "reviewed" } } }) };
      return query;
    } };
    await bindDirectCoachCall(row(), closrOutbound123Ref.slug, admin);
    await bindDirectCoachCall(row(), "a-new-default-must-not-rebind", admin);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ client_call_id: row().id, script_digest: closrOutbound123Ref.digest }), { onConflict: "client_call_id", ignoreDuplicates: true });
    await expect(bindDirectCoachCall({ ...row(), operator_user_id: "another-owner" }, closrOutbound123Ref.slug, admin)).rejects.toThrow("direct_coach_binding_invalid");
  });

  it("signs the exact owned call/leg/deadline and rejects insecure configuration", () => {
    const args = { baseUrl: env.DIRECT_COACH_STREAM_URL, secret, callId: "call", sellerLegId: "leg", expiresAtMs: now + 180000 };
    const url = new URL(directCoachStreamUrl(args));
    const [payload, signature] = url.searchParams.get("token")!.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ callId: "call", sellerLegId: "leg", expiresAtMs: now + 180000 });
    expect(signature).toBe(createHmac("sha256", secret).update(payload).digest("base64url"));
    expect(() => directCoachStreamUrl({ ...args, baseUrl: "ws://coach.example.com" })).toThrow();
    expect(() => directCoachStreamUrl({ ...args, secret: "short" })).toThrow();
  });
  it("binds before provider dispatch and uses the same command identity on retries", async () => {
    const order: string[] = [];
    const bind = vi.fn(async () => { order.push("bind"); });
    const fetchImpl = vi.fn(async () => { order.push("stream"); return new Response("{}", { status: 200 }); });
    const start = createDirectCoachStarter({ settings, env, bind, fetchImpl, now: () => now });
    await start(row()); await start(row());
    expect(order).toEqual(["bind", "stream", "bind", "stream"]);
    const body = JSON.parse((fetchImpl.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(body.stream_track).toBe("both_tracks");
    expect(body.command_id).toBe(JSON.parse((fetchImpl.mock.calls as unknown as [string, RequestInit][])[1][1].body as string).command_id);
  });
  it("does not dispatch disabled, terminal, expired, or unbound calls", async () => {
    const fetchImpl = vi.fn();
    const bind = vi.fn(async () => { throw new Error("binding unavailable"); });
    const start = createDirectCoachStarter({ settings, env, bind, fetchImpl, now: () => now });
    await start({ ...row(), status: "ended" });
    await start({ ...row(), connected_at: new Date(now - 181000).toISOString() });
    await createDirectCoachStarter({ settings, env: {}, bind, fetchImpl })(row());
    await expect(start(row())).rejects.toThrow("binding unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("redacts provider failures and caps long-call stream authorization to 180 seconds", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret provider body", { status: 503 }));
    const start = createDirectCoachStarter({ settings, env, bind: async () => {}, fetchImpl, now: () => now });
    await expect(start({ ...row(), time_limit_secs: 7200 })).rejects.toThrow("direct_coach_stream_http_503");
    const body = JSON.parse((fetchImpl.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    const payload = new URL(body.stream_url).searchParams.get("token")!.split(".")[0];
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).expiresAtMs).toBe(now + 180000);
  });
});
