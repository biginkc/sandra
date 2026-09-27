import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { computeScriptDigest, type ScriptBundle } from "@biginkc/coach";
import { closrOutbound123Bundle } from "@biginkc/coach/fixtures";
import { syncCoachScriptCache } from "./script-cache";

const bundle = closrOutbound123Bundle as ScriptBundle;
const token = "shared-test-token";
const baseUrl = "https://closer.example.test";

function admin() {
  const revisionUpsert = vi.fn().mockResolvedValue({ error: null });
  const defaultUpsert = vi.fn().mockResolvedValue({ error: null });
  return {
    revisionUpsert, defaultUpsert,
    client: {
      from(table: string) {
        if (table === "coach_script_revisions") return { upsert: revisionUpsert };
        if (table === "coach_script_defaults") return { upsert: defaultUpsert };
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
}

describe("syncCoachScriptCache", () => {
  it("rejects a tampered remote digest before writing any cache row", async () => {
    const cache = admin();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ scripts: [{
      slug: "closr-outbound", revision: 1, digest: "0".repeat(64),
      schema_version: bundle.schema_version, import_status: "reviewed", bundle,
    }] })));

    await expect(syncCoachScriptCache({ fetch: fetchMock, admin: cache.client as never, baseUrl, token }))
      .rejects.toThrow(/digest mismatch/);
    expect(cache.revisionUpsert).not.toHaveBeenCalled();
    expect(cache.defaultUpsert).not.toHaveBeenCalled();
  });

  it("re-syncs idempotently and signs the exact Closer Lab path", async () => {
    const digest = await computeScriptDigest(bundle);
    const cache = admin();
    const body = JSON.stringify({ scripts: [{
      slug: "closr-outbound", revision: 1, digest,
      schema_version: bundle.schema_version, import_status: "reviewed", bundle,
    }] });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(body)));
    const now = new Date("2026-09-26T12:00:00Z").getTime();
    await syncCoachScriptCache({ fetch: fetchMock, admin: cache.client as never, baseUrl, token, now: () => now });
    await syncCoachScriptCache({ fetch: fetchMock, admin: cache.client as never, baseUrl, token, now: () => now });

    const timestamp = String(now / 1_000);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/internal/sandra/coach-scripts", baseUrl),
      expect.objectContaining({ headers: expect.objectContaining({
        authorization: `Bearer ${token}`,
        "x-sandra-timestamp": timestamp,
        "x-sandra-signature": `sha256=${createHmac("sha256", token).update(`${timestamp}./api/internal/sandra/coach-scripts`).digest("hex")}`,
      }) }),
    );
    expect(cache.revisionUpsert).toHaveBeenCalledTimes(2);
    expect(cache.revisionUpsert).toHaveBeenLastCalledWith(expect.objectContaining({ digest, bundle }), { onConflict: "digest", ignoreDuplicates: true });
    expect(cache.defaultUpsert).toHaveBeenCalledTimes(2);
  });

  it("no-ops clearly when Closer Lab configuration is absent", async () => {
    const cache = admin();
    const fetchMock = vi.fn();
    await expect(syncCoachScriptCache({ fetch: fetchMock, admin: cache.client as never, baseUrl: "", token: "" }))
      .resolves.toEqual({ ok: true, skipped: "missing_configuration" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
