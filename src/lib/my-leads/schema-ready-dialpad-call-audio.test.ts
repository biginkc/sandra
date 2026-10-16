import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { REQUIREMENTS } from "./schema-ready";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261008130000_dialpad_call_audio.sql"), "utf8");

// Argument types, in order, of every `create [or replace] function public.<name>(...)` in the SQL.
function declaredSignatures(name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(([^)]*)\\)`, "gi");
  for (const m of sql.matchAll(re)) {
    const types = m[1]!
      .split(",")
      .map((a) => a.trim().replace(/\s+default\s+.*$/i, ""))
      .filter(Boolean)
      .map((a) => a.split(/\s+/).slice(1).join(" ").toLowerCase().replace(/timestamp with time zone/, "timestamptz"));
    out.push(`public.${name}(${types.join(",")})`);
  }
  return out;
}

describe("dialpad_call_audio readiness requirements match the real migration", () => {
  it.each(REQUIREMENTS.dialpad_call_audio.functions.map((f) => [f]))("%s is declared with exactly this argument list", (fn) => {
    const name = fn.slice("public.".length, fn.indexOf("("));
    expect(declaredSignatures(name)).toContain(fn);
  });

  it("every worker RPC the route calls is on the list, so a half-applied migration keeps the route disabled", () => {
    const workerRpcs = ["fn_dpa_worker_take", "fn_dpa_worker_release", "fn_dpa_worker_block", "fn_dpa_queue", "fn_dpa_discovery_result",
      "fn_dpa_requeue_denied", "fn_dpa_attempt_begin", "fn_dpa_attempt_set", "fn_dpa_audio_fail", "fn_dpa_mark_uploading", "fn_dpa_register_stored"];
    const adapter = readFileSync(join(process.cwd(), "src/lib/dialpad-cti/recording-audio-db.ts"), "utf8");
    for (const rpc of workerRpcs) {
      expect(adapter).toContain(`'${rpc}'`);
      expect(REQUIREMENTS.dialpad_call_audio.functions.some((f) => f.startsWith(`public.${rpc}(`))).toBe(true);
    }
    for (const rpc of ["fn_dialpad_audio_authorize", "fn_dialpad_audio_for_service"]) {
      expect(REQUIREMENTS.dialpad_call_audio.functions.some((f) => f.startsWith(`public.${rpc}(`))).toBe(true);
    }
  });

  it("names every flag column, stays inside the probe's 50-item limit, and does not touch the artifact_fetch requirement", () => {
    for (const column of ["recording_download", "recording_download_canary_call_ids", "audio_consumers"]) {
      expect(REQUIREMENTS.dialpad_call_audio.columns).toContain(`my_leads_feature_flags.${column}`);
      expect(sql).toContain(`add column ${column}`);
    }
    expect(REQUIREMENTS.dialpad_call_audio.functions.length).toBeLessThanOrEqual(50);
    expect(REQUIREMENTS.dialpad_call_audio.columns.length).toBeLessThanOrEqual(50);
    expect(REQUIREMENTS.artifact_fetch).toEqual({
      functions: [
        "public.fn_claim_dialpad_artifact_fetches(integer,integer,text[])",
        "public.fn_record_dialpad_artifact_result(uuid,text,text,text,text,text)",
        "public.fn_resolve_dialpad_recording_links(integer)",
      ],
      columns: ["dialpad_call_artifact_fetches.state", "my_leads_feature_flags.artifact_fetch"],
    });
  });
});
