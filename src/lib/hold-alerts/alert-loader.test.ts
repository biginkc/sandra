import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fakePostgrest } from "@/app/(dashboard)/messages-v2/fake-postgrest.test-util";
import { loadMessagesV2Data as pageLoader } from "@/app/(dashboard)/messages-v2/queries";

import { loadMessagesV2Data as alertLoader } from "./alert-loader";
import { runHoldAlertsForOrg } from "./core";
import { createHoldAlertDeps } from "./index";
import { makeDeps } from "./test-support";

/** sha256 of src/app/(dashboard)/messages-v2/queries.ts at 84ddabdd6 (the parent of PR #874). */
const PARENT_QUERIES_SHA256 = "020352518e8be736faebd8de7c719e1afa061bbf3c78fb9eacec2e339c924375";

type Row = Record<string, unknown>;
const u = (n: number, ns = 0) => `${String(ns).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

/**
 * Hold A (flagged) has its own run (model:unclear). A pending draft on A points at a NEWER run on property B in the
 * same conversation (model:hot_lead). 200 later runs push B's run out of the recent-runs window, so only a draft-run
 * lookup (added to the page loader in #874) can bring it into the pool.
 */
function fixture(): Record<string, Row[]> {
  const run = (id: string, property: string | null, reason: string, startedMinsAgo: number, conv: string | null = u(1, 2)): Row => ({
    id, org_id: "org", inbound_message_id: `${id}-in`, property_id: property, contact_id: null, conversation_id: conv, status: "held",
    mode: "automatic", final_outcome: null, reason, classification_run_id: null, claim_id: null, outbound_message_id: null,
    inbound_preview: "x", started_at: at(startedMinsAgo), completed_at: null,
  });
  const filler = Array.from({ length: 200 }, (_, i) => run(u(100 + i, 5), null, "filler", 5 + i * 0.01, u(900 + i, 2)));
  return {
    properties: [
      { id: u(1), org_id: "org", needs_human_attention: true, is_dnc_locked: false, last_ai_escalation_at: at(60), last_ai_escalation_reason: null, updated_at: at(60), needs_human_attention_since: at(60) },
      { id: u(2), org_id: "org", needs_human_attention: false, is_dnc_locked: false },
    ],
    pipeline_runs: [run(u(1, 5), u(1), "model:unclear", 120), run(u(2, 5), u(2), "model:hot_lead", 30), ...filler],
    pipeline_run_steps: [],
    ai_reply_drafts: [
      { id: u(1, 4), org_id: "org", status: "pending", property_id: u(1), conversation_id: u(1, 2), inbound_message_id: null, run_id: u(2, 5), created_at: at(25) },
    ],
    jev_lead_decisions: [],
    ai_disposition_reviews: [],
    messages: [],
  };
}

const db = (tables: Record<string, Row[]>) =>
  fakePostgrest(tables, {
    rpc: {
      pipeline_runs_latest_for_properties: (args) => {
        const ids = args.p_property_ids as string[];
        const best = new Map<string, Row>();
        for (const r of tables.pipeline_runs) {
          const p = r.property_id as string | null;
          if (p && ids.includes(p) && (!best.get(p) || String(r.started_at) > String(best.get(p)!.started_at))) best.set(p, r);
        }
        return { data: [...best.values()], error: null };
      },
      hold_alert_latest_status: () => ({ data: [], error: null }),
    },
  }).client;

describe("hold-alert cron reads holds with the exact pre-#874 loader", () => {
  it("alert-loader.ts is the parent's queries.ts byte for byte (apart from its header and the ./types import path)", () => {
    const src = readFileSync(join(__dirname, "alert-loader.ts"), "utf8");
    const body = src.slice(src.indexOf("*/\n") + 3).replace('from "@/app/(dashboard)/messages-v2/types";', 'from "./types";');
    expect(createHash("sha256").update(body).digest("hex")).toBe(PARENT_QUERIES_SHA256);
  });

  it("index.ts loads alert holds from alert-loader, never from the page's queries.ts", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(src).toMatch(/import \{ loadHeldPropertyIds, loadMessagesV2Data \} from "\.\/alert-loader";/);
    expect(src).not.toMatch(/import \{[^}]*loadMessagesV2Data[^}]*\} from "@\/app\/\(dashboard\)\/messages-v2\/queries"/);
  });

  it("a draft linked to another property's run: the cron keeps the parent's reason (model:unclear), whatever the page loader does", async () => {
    const alert = await alertLoader(db(fixture()), "org", NOW, { alertsSince: at(7 * 24 * 60) });
    // Parent (84ddabdd6) output for this fixture, captured from the frozen loader:
    expect(alert.holds.map((h) => ({ id: h.id, run: h.run?.id ?? null, reason: h.run?.reason ?? null }))).toEqual([
      { id: u(1), run: u(1, 5), reason: "model:unclear" },
    ]);
    const page = await pageLoader(db(fixture()), "org", NOW, { alertsSince: at(7 * 24 * 60) });
    // The page's own loader resolves the draft's run; it no longer feeds the cron, so this cannot change an alert.
    expect(page.holds.find((h) => h.id === u(1))?.run?.reason).toBe("model:hot_lead");
  });

  it("end to end through the cron's own deps (createHoldAlertDeps -> toAlertHolds -> isHotHold): the hold is NOT hot", async () => {
    const env = { HOLD_ALERT_HOT_REASONS: "model:hot_lead" };
    const deps = createHoldAlertDeps(db(fixture()) as never, env);
    const res = await deps.loadHolds("org", at(7 * 24 * 60));
    expect(res.complete).toBe(true);
    expect(res.holds.map((h) => ({ id: h.propertyId, hot: h.hot }))).toEqual([{ id: u(1), hot: false }]);
    // Positive control: the same path DOES mark the hold hot when its actual reason is listed.
    const control = await createHoldAlertDeps(db(fixture()) as never, { HOLD_ALERT_HOT_REASONS: "model:unclear" }).loadHolds("org", at(7 * 24 * 60));
    expect(control.holds.map((h) => ({ id: h.propertyId, hot: h.hot }))).toEqual([{ id: u(1), hot: true }]);
  });

  /**
   * The FULL alert pass (runHoldAlertsForOrg) with fake channels/store/recipients and the cron's real hold loading
   * (createHoldAlertDeps -> alert-loader.ts). FROZEN_PARENT_DECISIONS was produced by running this pass with
   * alert-loader.ts, which the first test pins to the sha256 of queries.ts at 84ddabdd6 (pre-#874): i.e. it IS the
   * parent's decision output for this fixture. The page loader (#874 semantics) is run too, to show the fixture
   * actually distinguishes them (it would add an SMS).
   */
  const decisions = async (loader: "cron" | "page") => {
    const real = createHoldAlertDeps(db(fixture()) as never, { HOLD_ALERT_HOT_REASONS: "model:hot_lead" });
    const { deps, store, sent } = makeDeps({ nowIso: new Date(NOW).toISOString() });
    store.watermarks.set("org", at(7 * 24 * 60));
    deps.loadHolds = loader === "cron" ? real.loadHolds : async (orgId, since) => {
      const { toAlertHolds } = await import("./holds");
      const data = await pageLoader(db(fixture()), orgId, NOW, { alertsSince: since });
      return { holds: toAlertHolds(data.holds, new Map(), ["model:hot_lead"]), complete: true };
    };
    deps.loadHeldPropertyIds = real.loadHeldPropertyIds;
    await runHoldAlertsForOrg(deps, "org");
    return {
      deliveries: store.rows.map((r) => ({ property: r.propertyId, recipient: r.recipientUserId, channel: r.channel, stage: r.stage, status: r.status })),
      sent: sent.map((x) => ({ channel: x.channel, userId: x.userId })),
    };
  };

  it("the full alert pass makes exactly the parent loader's holds, under the PR 2 delivery rules (not hot: no alerts)", async () => {
    expect(await decisions("cron")).toEqual(FROZEN_PARENT_DECISIONS);
    expect(await decisions("page")).not.toEqual(FROZEN_PARENT_DECISIONS);
  });
});

// FROZEN_PARENT_* below: the frozen parent loader (84ddabdd6) still returns the same holds for this fixture (hold
// reason model:unclear); the DELIVERY rules were intentionally changed in PR 2 (only hot holds alert, to the hot owner).
// Under the new rules the parent's hold (not hot) sends nothing, whereas the page loader (#874) resolves the draft's
// newer run (model:hot_lead -> hot) and would alert the owner. That difference is the fixture's point.
const P1 = "00000000-0000-4000-8000-000000000001";
const FROZEN_PARENT_DECISIONS = {
  deliveries: [] as Array<{ property: string; recipient: string; channel: string; stage: string; status: string }>,
  sent: [] as Array<{ channel: string; userId: string }>,
};
void P1;
