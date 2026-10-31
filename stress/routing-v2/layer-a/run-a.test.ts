/**
 * Stress Layer A runner (STRESS-TEST-DESIGN §1): REAL Jev + REAL Haiku through the PRODUCTION
 * classifyV2 (live config: every slice on, numberSourceQuestion=true, Jev maxRetries 0 / 8 s as
 * dispatch.ts runs it). DealMachine is a stub (no credits). Skipped unless RUN_LAYER_A=1.
 *
 * Env: PACKS=<comma list of pack json> | REPLAY=<data.json>, REPEATS=5, CONC=8, OUT=<jsonl>,
 *      JEV_KEY_FILE, ANTHROPIC_KEY_FILE (read, never logged).
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";

import { classifyV2 } from "@/lib/sms-classification/routing-v2/classify";
import { parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { askHaiku, type HaikuCallResult, type HaikuThreadMessage } from "@/lib/sms-classification/routing-v2/haiku";
import { extractDollarAmount } from "@/lib/sms-classification/routing-v2/price-amount";
import { v2ReplyText } from "@/lib/sms-classification/routing-v2/reply-texts";
import { askJev, type JevAskResult } from "@/lib/sms-classification/providers/jev-gateway";

type Item = {
  id: string; family: number | string; source: string; reply: string; thread: string[];
  context: null | "after_repairs" | "after_not_interested"; dm: null | "below80" | "above80" | "none";
};

const PID = "7a1c0b2e-3d4f-4a5b-8c6d-9e0f1a2b3c4d";
const FLAGS = parseRoutingV2Flags({
  questions_live: true, replies: true, drips: true, haiku: true, price_check: true,
  alert_on_time_only: true, wrong_number_all: true, model_stop_suppression: true, canary_property_ids: [PID],
});

function toThread(item: Item): HaikuThreadMessage[] {
  const t: HaikuThreadMessage[] = item.thread.map((line) =>
    line.startsWith("SELLER:") ? { direction: "inbound", body: line.slice(7).trim() } : { direction: "outbound", body: line.replace(/^US:\s*/, "") },
  );
  if (item.context === "after_repairs") t.push({ direction: "outbound", body: v2ReplyText("price_too_high") });
  if (item.context === "after_not_interested") t.push({ direction: "outbound", body: v2ReplyText("not_interested") });
  return t;
}

function loadItems(): Item[] {
  if (process.env.REPLAY) {
    const rows = JSON.parse(readFileSync(process.env.REPLAY, "utf8")) as Array<{ run_id: string; reply: string; thread: string[] }>;
    return rows.map((r) => ({ id: r.run_id, family: "replay", source: "replay", reply: r.reply, thread: r.thread.slice(0, -1), context: null, dm: null }));
  }
  return (process.env.PACKS ?? "").split(",").filter(Boolean).flatMap((p) => JSON.parse(readFileSync(p, "utf8")) as Item[]);
}

async function pool<T>(jobs: T[], n: number, fn: (j: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const j = jobs[i++]; await fn(j); } }));
}

describe.skipIf(process.env.RUN_LAYER_A !== "1")("layer A live run", () => {
  it("runs the pack against live Jev + Haiku", async () => {
    const jevKey = readFileSync(process.env.JEV_KEY_FILE!, "utf8").trim();
    const anthKey = readFileSync(process.env.ANTHROPIC_KEY_FILE!, "utf8").trim();
    const out = process.env.OUT!;
    const repeats = Number(process.env.REPEATS ?? 5);
    const conc = Number(process.env.CONC ?? 8);
    const items = loadItems();
    const done = new Set<string>();
    if (existsSync(out)) {
      for (const line of readFileSync(out, "utf8").split("\n").slice(1)) {
        if (!line) continue;
        const r = JSON.parse(line); done.add(`${r.id}#${r.rep}`);
      }
    } else writeFileSync(out, execSync("git rev-parse HEAD").toString().trim() + "\n");
    const jobs = items.flatMap((it) => Array.from({ length: repeats }, (_, rep) => ({ it, rep }))).filter((j) => !done.has(`${j.it.id}#${j.rep}`));
    let n = 0;
    await pool(jobs, conc, async ({ it, rep }) => {
      let raw: JevAskResult | null = null;
      let jevErr: string | null = null;
      let haikuRes: HaikuCallResult | null = null;
      let dmCalls = 0;
      const started = Date.now();
      const res = await classifyV2(
        { flags: FLAGS, propertyId: PID, reply: it.reply, thread: toThread(it), numberSourceQuestion: true },
        {
          jev: async (req) => {
            try { raw = await askJev(req, { fetch, apiKey: jevKey, maxRetries: 0, timeoutMs: 8000 }); return raw; }
            catch (e) { jevErr = e instanceof Error ? `${e.name}:${(e as { kind?: string }).kind ?? ""}:${e.message.slice(0, 120)}` : String(e); throw e; }
          },
          haiku: async (thread) => { haikuRes = await askHaiku(thread, { fetch, apiKey: anthKey }); return haikuRes; },
          lookupValue: async () => {
            dmCalls++;
            const x = extractDollarAmount(it.reply);
            const amt = x.kind === "single" ? x.amount : 200000;
            if (it.dm === "below80") return { kind: "value", value: amt / 0.5, source: "provider" };
            if (it.dm === "above80") return { kind: "value", value: amt, source: "provider" };
            if (it.dm === "none") return { kind: "no_value", reason: "no_match" };
            return { kind: "value", value: amt / 0.7, source: "provider" };
          },
        },
      );
      const rec: Record<string, unknown> = { id: it.id, family: it.family, source: it.source, rep, ms: Date.now() - started, dmCalls, jevErr };
      if (res.kind === "decided") {
        const a = (raw as JevAskResult | null)?.answers ?? {};
        rec.kind = "decided";
        rec.outcome = res.action.road === "price_check" ? `price_check:${res.priceOutcome}` : res.action.road;
        rec.steps = res.action.steps;
        rec.jevRoad = res.decision.road;
        rec.prov = res.decision.provenance;
        rec.haikuElig = res.decision.haiku;
        rec.finalBy = res.final?.by ?? null;
        rec.opp = res.decision.opportunityAlert;
        rec.probs = res.probabilities;
        rec.pt = res.propertyType;
        rec.fu = Object.fromEntries(["needs_repairs", "flexible_price", "original_portion", "no_repairs"].filter((k) => a[k]).map((k) => [k, a[k].noul]));
        rec.numberSource = a.asked_how_number_obtained?.choice ?? null;
        rec.jevMs = res.latencyMs;
        rec.jevUsage = (raw as JevAskResult | null)?.usage ?? null;
        const h = haikuRes as HaikuCallResult | null;
        rec.haiku = h ? { ok: h.ok, option: h.ok ? h.option : null, conf: h.ok ? h.confidence : null, reason: h.ok ? null : h.reason, ms: h.latencyMs, attempts: h.attempts, in: h.inputTokens, out: h.outputTokens, cost: h.costUsd } : null;
      } else {
        rec.kind = res.kind;
        rec.outcome = res.kind === "failed" ? `failed:${res.reason}` : "off";
      }
      appendFileSync(out, JSON.stringify(rec) + "\n");
      if (++n % 200 === 0) console.log(`${n}/${jobs.length}`);
    });
  }, 6 * 3600_000);
});
