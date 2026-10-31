import { readFileSync } from "node:fs";
import path from "node:path";

import { FINAL } from "./env";

/**
 * In-process provider stubs (Jev / Haiku / DealMachine) behind a fault script. Every request to a
 * provider host is answered here; any other non-loopback host throws (no network at all).
 *
 * Jev answers come from the recorded Oct replay (data.json + probs.json + newq*.json), mapped to
 * the v2 question ids: 22 ids from probs.json; text_only <- newq2.sms_only, how_it_works <-
 * newq.process, own_other_property <- newq6.own, someone_else_property <- newq8.else (each the
 * exact v2 wording). Unknown reply text (11 rows missing from probs.json, synthetic texts) -> every
 * yes/no 0.02 and property_type didnt_say 0.96. Haiku answers come from haiku_cache_v3.json (by
 * run id); missing -> needs_person 0.5.
 */
export type ReplayRow = { run_id: string; property_id: string; created_at: string; our_last: string | null; reply: string; thread: string[] };
type Probs = Record<string, number>;

export function loadReplay(): { rows: ReplayRow[]; probsByReply: Map<string, { probs: Probs; ptype: Record<string, number> }>; haikuByReply: Map<string, { opt: string; conf: number }>; expectedRoad: Map<string, string> } {
  const rows = JSON.parse(readFileSync(path.join(FINAL, "data.json"), "utf8")) as ReplayRow[];
  const probs = JSON.parse(readFileSync(path.join(FINAL, "probs.json"), "utf8")) as Record<string, { probs: Probs; property_type: { probabilities: Record<string, number> } }>;
  const nq = JSON.parse(readFileSync(path.join(FINAL, "newq.json"), "utf8")) as Array<Record<string, number>>;
  const nq2 = JSON.parse(readFileSync(path.join(FINAL, "newq2.json"), "utf8")) as Array<Record<string, number>>;
  const nq6 = JSON.parse(readFileSync(path.join(FINAL, "newq6.json"), "utf8")) as Array<Record<string, number>>;
  const nq8 = JSON.parse(readFileSync(path.join(FINAL, "newq8.json"), "utf8")) as Array<Record<string, number>>;
  const haiku = JSON.parse(readFileSync(path.join(FINAL, "haiku_cache_v3.json"), "utf8")) as Record<string, { opt: string; conf: number }>;
  const results = JSON.parse(readFileSync(path.join(FINAL, "results_v7.json"), "utf8")) as Record<string, { road: string }>;
  const probsByReply = new Map<string, { probs: Probs; ptype: Record<string, number> }>();
  const haikuByReply = new Map<string, { opt: string; conf: number }>();
  const expectedRoad = new Map<string, string>();
  rows.forEach((r, i) => {
    const key = r.reply.trim();
    const p = probs[r.run_id];
    if (p) {
      probsByReply.set(key, {
        probs: {
          ...p.probs,
          text_only: nq2[i]?.sms_only ?? 0.02,
          how_it_works: nq[i]?.process ?? 0.02,
          own_other_property: nq6[i]?.own ?? 0.02,
          someone_else_property: nq8[i]?.else ?? 0.02,
        },
        ptype: p.property_type.probabilities,
      });
    }
    if (haiku[r.run_id]) haikuByReply.set(key, haiku[r.run_id]!);
    if (results[r.run_id]) expectedRoad.set(key, results[r.run_id]!.road);
  });
  return { rows, probsByReply, haikuByReply, expectedRoad };
}

export type Fault = { jev?: "429" | "5xx10" | "latency25s" | null; haiku?: "429" | "malformed5" | null; dm?: "creditout" | null };

export type CallLog = { provider: "jev" | "jev_eight" | "jev_nine" | "haiku" | "llm" | "dealmachine"; at: number; status: number; key: string; ms: number };

export class ProviderStubs {
  calls: CallLog[] = [];
  fault: Fault = {};
  inflight: Record<string, number> = { jev: 0, haiku: 0, dealmachine: 0 };
  maxInflight: Record<string, number> = { jev: 0, haiku: 0, dealmachine: 0 };
  /** DealMachine provider-side rate limit (60/min sliding window, as the real API). */
  dmWindow: number[] = [];
  /** Per-property DealMachine value; default 200k. */
  dmValue = new Map<string, number>();
  dmDefault = 200_000;
  dmLatencyMs = 50;
  /** Override: answer for any reply text (tests). */
  jevOverride: ((reply: string) => Partial<Probs> | null) | null = null;
  haikuOverride: ((thread: string) => { status: number; text?: string } | null) | null = null;
  haikuDelayMs = 0;
  haikuShapeOk = 0;
  haikuShapeBad = 0;
  /** DealMachine: force a status for every call (e.g. 429 storm) or an unmatched body. */
  dmForce: { status?: number; unmatched?: boolean } = {};
  latencyScale = 1; // compress the 25 s latency window
  killSwitch = false; // simulated worker kill: in-flight provider calls throw
  private real = globalThis.fetch;

  constructor(private data: ReturnType<typeof loadReplay>) {}

  install(): void {
    const self = this;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const host = new URL(url).hostname;
      if (host === "127.0.0.1" || host === "localhost") return self.real(input, init);
      if (host === "api.typesafe.ai") return self.withAbort(self.jev(String(init?.body ?? "")), init?.signal);
      if (host === "api.anthropic.com") return self.withAbort(self.anthropic(String(init?.body ?? "")), init?.signal);
      if (host.endsWith("dealmachine.com")) return self.withAbort(self.dealmachine(String(init?.body ?? "")), init?.signal);
      throw new Error(`stress: unexpected outbound HTTP to ${host}`);
    }) as typeof fetch;
  }
  /** Real fetch rejects with AbortError when the caller's signal fires; so does the stub. */
  private withAbort(p: Promise<Response>, signal?: AbortSignal | null): Promise<Response> {
    if (!signal) return p;
    return new Promise((resolve, reject) => {
      const abort = () => { const e = new Error("aborted"); e.name = "AbortError"; this.aborted++; reject(e); };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      p.then(resolve, reject);
    });
  }
  aborted = 0;
  uninstall(): void { globalThis.fetch = this.real; }

  private track(p: string, d: number) {
    this.inflight[p] = (this.inflight[p] ?? 0) + d;
    this.maxInflight[p] = Math.max(this.maxInflight[p] ?? 0, this.inflight[p]!);
  }
  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }
  private sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  private async jev(raw: string): Promise<Response> {
    const t0 = Date.now();
    const body = JSON.parse(raw) as { state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
    const st = body.state ?? {};
    const reply = String(st.homeowner_reply ?? st.inbound_message ?? st.latest_inbound ?? st.message ?? "").trim();
    const v2 = "own_other_property" in body.questions && "just_ok" in body.questions;
    const nineQ = !v2 && Object.values(body.questions).some((q) => q.type === "noul");
    const provider = v2 ? "jev" : nineQ ? "jev_nine" : "jev_eight";
    this.track("jev", 1);
    try {
      if (this.killSwitch) throw new Error("worker killed");
      let status = 200;
      if (this.fault.jev === "429") status = 429;
      else if (this.fault.jev === "5xx10" && Math.random() < 0.1) status = 503;
      else if (this.fault.jev === "latency25s") await this.sleep(25_000 * this.latencyScale);
      else await this.sleep(5 + Math.random() * 20);
      if (status !== 200) {
        this.calls.push({ provider, at: t0, status, key: reply, ms: Date.now() - t0 });
        return this.json(status, { error: "stub fault" }, status === 429 ? { "retry-after": "1" } : {});
      }
      if (nineQ) {
        const rec = this.data.probsByReply.get(reply)?.probs ?? {};
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(body.questions)) answers[id] = q.type === "noul" ? { choice: "noul", noul: rec[id] ?? 0.02 } : { type: "choice", choice: Object.keys(q.criteria ?? { a: 1 })[0], confidence: 0.9, probabilities: {} };
        this.calls.push({ provider, at: t0, status: 200, key: reply, ms: Date.now() - t0 });
        return this.json(200, { answers, model: "jev-stub", usage: { input_tokens: 1, output_tokens: 1 } });
      }
      if (!v2) {
        // Eight-answer request (only asked by v2 for the "how did you get my number" detector).
        const thread = JSON.stringify(st);
        const asked = /how (did|do) (you|u) get (my|this) (number|#)|where did you get my (number|info)/i.test(thread);
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(body.questions)) {
          const opts = Object.keys(q.criteria ?? { yes: 1, no: 1 });
          const choice = id === "asked_how_number_obtained" ? (asked ? "yes" : "no") : opts[0]!;
          answers[id] = { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(opts.map((o) => [o, o === choice ? 0.9 : 0.1 / Math.max(1, opts.length - 1)])) };
        }
        this.calls.push({ provider, at: t0, status: 200, key: reply, ms: Date.now() - t0 });
        return this.json(200, { answers, model: "jev-stub", usage: { input_tokens: 1, output_tokens: 1 } });
      }
      const rec = (this.jevOverride?.(reply) as Probs | null | undefined) ?? this.data.probsByReply.get(reply)?.probs ?? null;
      const ptype = this.data.probsByReply.get(reply)?.ptype ?? { residential: 0.02, lot: 0, commercial: 0, rental: 0, didnt_say: 0.96 };
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === "choice" && id === "asked_how_number_obtained") {
          const yes = /how (did|do) (you|u) get (my|this) (number|#)|where did you get my (number|info)/i.test(reply);
          answers[id] = { type: "choice", choice: yes ? "yes" : "no", confidence: 0.95, probabilities: { yes: yes ? 0.95 : 0.05, no: yes ? 0.05 : 0.95 } };
        } else if (q.type === "choice") {
          const best = Object.entries(ptype).sort((a, b) => b[1] - a[1])[0]![0];
          answers[id] = { type: "choice", choice: best, confidence: ptype[best], probabilities: ptype };
        } else answers[id] = { choice: "noul", noul: rec?.[id] ?? 0.02 };
      }
      this.calls.push({ provider, at: t0, status: 200, key: reply, ms: Date.now() - t0 });
      return this.json(200, { answers, model: "jev-stub", usage: { input_tokens: 1, output_tokens: 1 } });
    } finally { this.track("jev", -1); }
  }

  private async anthropic(raw: string): Promise<Response> {
    const t0 = Date.now();
    const body = JSON.parse(raw) as { model?: string; max_tokens?: number; output_config?: { format?: { type?: string } }; messages?: Array<{ content: string }> };
    if (body.model === "claude-haiku-5-5") { if (body.max_tokens === 200 && body.output_config?.format?.type === "json_schema") this.haikuShapeOk++; else this.haikuShapeBad++; }
    if (body.model !== "claude-haiku-5-5") {
      this.calls.push({ provider: "llm", at: t0, status: 500, key: String(body.model), ms: 0 });
      return this.json(500, { error: "stress: LLM not stubbed" });
    }
    this.track("haiku", 1);
    try {
      const content = body.messages?.[0]?.content ?? "";
      const lastSeller = content.split("\n").filter((l) => l.startsWith("SELLER: ")).pop()?.slice(8).trim() ?? "";
      const over = this.haikuOverride?.(content);
      let status = over?.status ?? 200;
      if (!over && this.fault.haiku === "429") status = 429;
      await this.sleep(this.haikuDelayMs || 5 + Math.random() * 20);
      if (status !== 200) {
        this.calls.push({ provider: "haiku", at: t0, status, key: lastSeller, ms: Date.now() - t0 });
        return this.json(status, { error: "stub" }, status === 429 ? { "retry-after": "1" } : {});
      }
      let text = over?.text;
      if (text === undefined) {
        const h = this.data.haikuByReply.get(lastSeller) ?? { opt: "needs_person", conf: 0.5 };
        text = this.fault.haiku === "malformed5" && Math.random() < 0.05 ? "{road: not json" : JSON.stringify({ road: h.opt, confidence: h.conf });
      }
      this.calls.push({ provider: "haiku", at: t0, status: 200, key: lastSeller, ms: Date.now() - t0 });
      return this.json(200, { content: [{ type: "text", text }], usage: { input_tokens: Math.ceil(content.length / 4), output_tokens: 12 } });
    } finally { this.track("haiku", -1); }
  }

  private async dealmachine(raw: string): Promise<Response> {
    const t0 = Date.now();
    const body = JSON.parse(raw) as { data: Array<{ street: string }> };
    const street = body.data?.[0]?.street ?? "";
    this.track("dealmachine", 1);
    try {
      this.dmWindow = this.dmWindow.filter((t) => t > t0 - 60_000);
      let status = 200;
      if (this.dmForce.status) status = this.dmForce.status;
      else if (this.fault.dm === "creditout") status = 402;
      else if (this.dmWindow.length >= 60) status = 429;
      this.dmWindow.push(t0);
      await this.sleep(this.dmLatencyMs);
      this.calls.push({ provider: "dealmachine", at: t0, status, key: street, ms: Date.now() - t0 });
      if (status === 429) return this.json(429, { error: "rate" }, this.dmForce.status ? {} : { "retry-after": "2" });
      if (this.dmForce.unmatched) return this.json(200, { data: [{ matched: false, match_failure: { code: "no_match" } }], credits: { used: 0 } });
      if (status === 402) return this.json(402, { error: "out of credits" });
      const v = this.dmValue.get(street) ?? this.dmDefault;
      return this.json(200, { data: [{ matched: true, estimated_value: v }], credits: { used: 1 } });
    } finally { this.track("dealmachine", -1); }
  }

  count(p: CallLog["provider"], pred: (c: CallLog) => boolean = () => true): number {
    return this.calls.filter((c) => c.provider === p && pred(c)).length;
  }
  /** Max calls in any rolling 60 s window. */
  maxPerMinute(p: CallLog["provider"]): number {
    const ts = this.calls.filter((c) => c.provider === p).map((c) => c.at).sort((a, b) => a - b);
    let best = 0, j = 0;
    for (let i = 0; i < ts.length; i++) { while (ts[i]! - ts[j]! >= 60_000) j++; best = Math.max(best, i - j + 1); }
    return best;
  }
}

/** Wall clock shift for quiet-hours phases: Date.now()/new Date() = real + offset (DB time stays real). */
const RealDate = Date;
let offsetMs = 0;
export function setClockOffset(ms: number): void {
  offsetMs = ms;
  if ((globalThis.Date as unknown) === RealDate && ms !== 0) {
    class ShiftedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(RealDate.now() + offsetMs);
        else super(...(args as [string]));
      }
      static now() { return RealDate.now() + offsetMs; }
    }
    globalThis.Date = ShiftedDate as unknown as DateConstructor;
  }
  if (ms === 0) globalThis.Date = RealDate;
}
/** Offset that makes the JS clock read `hh:mm` America/Chicago today. */
export function offsetToChicago(hh: number, mm: number): number {
  const now = new RealDate();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")!.value), m = Number(parts.find((p) => p.type === "minute")!.value);
  return ((hh * 60 + mm) - (h * 60 + m)) * 60_000;
}
