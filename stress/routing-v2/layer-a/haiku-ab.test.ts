/**
 * H4: Haiku request A/B (A2-ROOT-CAUSE-ANALYSIS.md Problem 3). Recorded Jev answers (no Jev calls),
 * live Haiku, the PRODUCTION classifyV2 + askHaiku. Arms differ ONLY in request parameters; the
 * system prompt, options block and user content are byte-identical (built by buildHaikuRequest).
 *   a = pre-9cafc10ad request (no output_config, max_tokens 100)
 *   b = current request (output_config json_schema, max_tokens 200)
 *   c = current + thinking adaptive (max_tokens raised so thinking fits)
 *   d = pre-9cafc10ad + stop_sequences ["}"], max_tokens 200 ("}" re-appended before parse)
 * Env: RUN_HAIKU_AB=1, ARMS=a,b,c,d, REPLAY_RAW=<recorded replay jsonl>, DATA=<data.json>,
 *      PACK_RAW=<recorded Layer A jsonl>, PACKS=<packs>, REPEATS_REPLAY=2, REPEATS_PACK=1, OUT=<jsonl>,
 *      ANTHROPIC_KEY_FILE, SPEND_STOP_USD=0.95, PROBE=1 (one call per arm, then stop).
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";

import { classifyV2 } from "@/lib/sms-classification/routing-v2/classify";
import { parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { askHaiku, parseHaikuText, type HaikuCallResult, type HaikuThreadMessage } from "@/lib/sms-classification/routing-v2/haiku";
import { extractDollarAmount } from "@/lib/sms-classification/routing-v2/price-amount";
import { v2ReplyText } from "@/lib/sms-classification/routing-v2/reply-texts";

const PID = "7a1c0b2e-3d4f-4a5b-8c6d-9e0f1a2b3c4d";
const FLAGS = parseRoutingV2Flags({
  questions_live: true, replies: true, drips: true, haiku: true, price_check: true,
  alert_on_time_only: true, wrong_number_all: true, model_stop_suppression: true, canary_property_ids: [PID],
});
const PRICE = { input: 0.1, output: 0.5 }; // claude-haiku-5-5 $/MTok (prompts <100K)

type Rec = { id: string; probs: Record<string, number>; pt: Record<string, number>; fu?: Record<string, number>; numberSource?: string | null; haikuElig?: string | null };
type In = { key: string; src: "replay" | "pack"; reply: string; thread: HaikuThreadMessage[]; dm: string | null; rec: Rec };

function answersFrom(rec: Rec) {
  const a: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(rec.probs)) a[k] = { choice: p >= 0.5 ? "yes" : "no", noul: p };
  for (const [k, p] of Object.entries(rec.fu ?? {})) a[k] = { choice: p >= 0.5 ? "yes" : "no", noul: p };
  const top = Object.entries(rec.pt).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "didnt_say";
  a.property_type = { choice: top, probabilities: rec.pt };
  if (rec.numberSource) a.asked_how_number_obtained = { choice: rec.numberSource, probabilities: {} };
  return a;
}
const lines = (t: string[]): HaikuThreadMessage[] => t.map((l) => (l.startsWith("SELLER:") ? { direction: "inbound", body: l.slice(7).trim() } : { direction: "outbound", body: l.replace(/^US:\s*/, "") }));

function loadInputs(): In[] {
  const out: In[] = [];
  if (process.env.REPLAY_RAW) {
    const data = new Map((JSON.parse(readFileSync(process.env.DATA!, "utf8")) as Array<{ run_id: string; reply: string; thread: string[] }>).map((r) => [r.run_id, r]));
    for (const l of readFileSync(process.env.REPLAY_RAW, "utf8").split("\n").slice(1)) {
      if (!l) continue;
      const rec = JSON.parse(l) as Rec & { kind: string };
      if (rec.kind !== "decided") continue;
      const d = data.get(rec.id)!;
      out.push({ key: `replay:${rec.id}`, src: "replay", reply: d.reply, thread: lines(d.thread.slice(0, -1)), dm: null, rec });
    }
  }
  if (process.env.PACK_RAW) {
    const items = new Map<string, { reply: string; thread: string[]; context: string | null; dm: string | null }>();
    for (const p of (process.env.PACKS ?? "").split(",").filter(Boolean)) for (const it of JSON.parse(readFileSync(p, "utf8"))) items.set(it.id, it);
    for (const l of readFileSync(process.env.PACK_RAW, "utf8").split("\n").slice(1)) {
      if (!l) continue;
      const rec = JSON.parse(l) as Rec & { kind: string; rep: number };
      if (rec.kind !== "decided" || rec.rep !== 0 || !rec.haikuElig) continue; // only rows that reach Haiku
      const it = items.get(rec.id)!;
      const t = lines(it.thread);
      if (it.context === "after_repairs") t.push({ direction: "outbound", body: v2ReplyText("price_too_high") });
      if (it.context === "after_not_interested") t.push({ direction: "outbound", body: v2ReplyText("not_interested") });
      out.push({ key: `pack:${rec.id}`, src: "pack", reply: it.reply, thread: t, dm: it.dm, rec });
    }
  }
  return out;
}

/** Arm = a request/response rewrite around the production askHaiku fetch. */
function armFetch(arm: string, raw: { text?: string; stop?: string; thinkingTokens?: number }): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (arm === "a" || arm === "d") delete body.output_config;
    if (arm === "a") body.max_tokens = 100;
    if (arm === "d") { body.max_tokens = 200; body.stop_sequences = ["}"]; }
    if (arm === "c") { body.thinking = { type: "adaptive" }; body.max_tokens = 4000; }
    const res = await fetch(url, { ...init, body: JSON.stringify(body) });
    if (!res.ok) return res;
    const j = (await res.json()) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string; usage?: unknown };
    raw.stop = j.stop_reason;
    raw.text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (arm === "d" && j.stop_reason === "stop_sequence") {
      const last = [...(j.content ?? [])].reverse().find((b) => b.type === "text");
      if (last) last.text = (last.text ?? "") + "}";
    }
    return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe.skipIf(process.env.RUN_HAIKU_AB !== "1")("Haiku A/B", () => {
  it("runs the arms", async () => {
    const key = readFileSync(process.env.ANTHROPIC_KEY_FILE!, "utf8").trim();
    const arms = (process.env.ARMS ?? "a,b,c,d").split(",");
    const out = process.env.OUT!;
    const stopAt = Number(process.env.SPEND_STOP_USD ?? 0.95);
    const inputs = loadInputs();
    const done = new Set<string>();
    let spend = 0;
    if (existsSync(out)) {
      for (const l of readFileSync(out, "utf8").split("\n").slice(1)) {
        if (!l) continue;
        const r = JSON.parse(l); done.add(`${r.arm}|${r.key}|${r.rep}`); spend += r.haiku?.cost ?? 0;
      }
    } else writeFileSync(out, execSync("git rev-parse HEAD").toString().trim() + "\n");
    const probe = process.env.PROBE === "1";
    const jobs: Array<{ arm: string; inp: In; rep: number }> = [];
    for (const arm of arms) for (const inp of inputs) {
      const reps = inp.src === "replay" ? Number(process.env.REPEATS_REPLAY ?? 2) : Number(process.env.REPEATS_PACK ?? 1);
      for (let rep = 0; rep < reps; rep++) if (!done.has(`${arm}|${inp.key}|${rep}`)) jobs.push({ arm, inp, rep });
    }
    const probeJobs = probe ? arms.map((arm) => jobs.find((j) => j.arm === arm && j.inp.rec.haikuElig)!).filter(Boolean) : jobs;
    let i = 0;
    let stopped = false;
    await Promise.all(Array.from({ length: probe ? 1 : 6 }, async () => {
      while (i < probeJobs.length && !stopped) {
        const { arm, inp, rep } = probeJobs[i++];
        if (spend >= stopAt) { stopped = true; break; }
        const raw: { text?: string; stop?: string } = {};
        let h: HaikuCallResult | null = null;
        const res = await classifyV2(
          { flags: FLAGS, propertyId: PID, reply: inp.reply, thread: inp.thread, numberSourceQuestion: true },
          {
            jev: async () => ({ answers: answersFrom(inp.rec) as never, model: "recorded", latencyMs: 0 }),
            haiku: async (thread) => { h = await askHaiku(thread, { fetch: armFetch(arm, raw), apiKey: key }); return h; },
            lookupValue: async () => {
              const x = extractDollarAmount(inp.reply);
              const amt = x.kind === "single" ? x.amount : 200000;
              if (inp.dm === "above80") return { kind: "value", value: amt, source: "provider" };
              if (inp.dm === "none") return { kind: "no_value", reason: "no_match" };
              return { kind: "value", value: amt / (inp.dm === "below80" ? 0.5 : 0.7), source: "provider" };
            },
          },
        );
        const hh = h as HaikuCallResult | null;
        const cost = hh && hh.inputTokens !== null && hh.outputTokens !== null ? (hh.inputTokens * PRICE.input + hh.outputTokens * PRICE.output) / 1e6 : 0;
        spend += cost;
        const rec: Record<string, unknown> = { arm, key: inp.key, src: inp.src, rep };
        if (res.kind === "decided") {
          rec.outcome = res.action.road === "price_check" ? `price_check:${res.priceOutcome}` : res.action.road;
          rec.steps = res.action.steps; rec.finalBy = res.final?.by ?? null; rec.haikuElig = res.decision.haiku; rec.jevRoad = res.decision.road; rec.opp = res.decision.opportunityAlert;
          rec.haiku = hh ? { ok: hh.ok, option: hh.ok ? hh.option : null, conf: hh.ok ? hh.confidence : null, reason: hh.ok ? null : hh.reason, ms: hh.latencyMs, in: hh.inputTokens, out: hh.outputTokens, cost, stop: raw.stop, strictOk: raw.text !== undefined ? parseStrict(raw.text, arm) : null, text: hh.ok ? undefined : (raw.text ?? "").slice(0, 200) } : null;
        } else rec.outcome = res.kind === "failed" ? `failed:${res.reason}` : res.kind;
        appendFileSync(out, JSON.stringify(rec) + "\n");
      }
    }));
    console.log(`spend $${spend.toFixed(4)}${stopped ? " (STOPPED at cap)" : ""}`);
  }, 4 * 3600_000);
});

/** Would the PRE-A-3 strict parser (whole text must be one JSON object) have accepted it? */
function parseStrict(text: string, arm: string): boolean {
  const t = (arm === "d" ? text + "}" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { const v = JSON.parse(t); return !!v && typeof v === "object" && !Array.isArray(v) && parseHaikuText(t).ok; } catch { return false; }
}
