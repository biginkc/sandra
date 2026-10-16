import type { Rng } from "../prng";
import { DAY, HOUR, MIN, emptyLead, type Enrollment, type Lead, type Msg, type World } from "./model";

/**
 * Prod-shaped generator. It takes ONLY aggregate counts (how many leads sit in each automation / inbound state) and invents every
 * contact detail, message and timestamp from a seeded generator. It never reads a database, an export row, a name, an address or a
 * phone number; the production shape of 2026-10-14 (design section 7) is recorded here as plain numbers.
 */
export type ProdCounts = {
  leads: number;
  activeDrip: number;
  pausedByReply: number;
  providerFailed: number;
  /** Leads with no enrollment at all. */
  noEnrollment: number;
  /** Of those, how many have an inbound text in the last 30 days. */
  noEnrollmentWithInbound30d: number;
  scheduledCampaignTexts: number;
};

/** Jarrad's queue on 2026-10-14: 181 leads (design section 7). */
export const PROD_SHAPE_2026_10_14: ProdCounts = {
  leads: 181, activeDrip: 36, pausedByReply: 42, providerFailed: 2, noEnrollment: 97, noEnrollmentWithInbound30d: 19, scheduledCampaignTexts: 0,
};

/** Scale a shape to `leads` total, keeping every proportion (largest-remainder rounding so the parts sum exactly). */
export function scaleCounts(shape: ProdCounts, leads: number): ProdCounts {
  const parts = ["activeDrip", "pausedByReply", "providerFailed", "noEnrollment", "scheduledCampaignTexts"] as const;
  const sum = parts.reduce((a, k) => a + shape[k], 0) || 1;
  const raw = parts.map((k) => (shape[k] / sum) * leads);
  const floor = raw.map(Math.floor);
  let short = leads - floor.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (short > 0) { floor[i]! += 1; short -= 1; } });
  const out: Record<string, number> = {};
  parts.forEach((k, i) => { out[k] = floor[i]!; });
  const noEnrollment = out.noEnrollment!;
  return { leads, activeDrip: out.activeDrip!, pausedByReply: out.pausedByReply!, providerFailed: out.providerFailed!, noEnrollment,
    noEnrollmentWithInbound30d: Math.round(noEnrollment * (shape.noEnrollmentWithInbound30d / (shape.noEnrollment || 1))), scheduledCampaignTexts: out.scheduledCampaignTexts! };
}

/** Old two-way history (4-12 messages total with the state-defining ones), ledger receipts linked to human texts. */
function history(rng: Rng, now: number, key: string, count: number): Msg[] {
  const out: Msg[] = [];
  for (let n = 0; n < count; n += 1) {
    const at = now - (20 + (count - n) * 3 + rng.int(0, 2)) * DAY;
    if (n % 3 === 1) out.push({ ref: `h${n}`, dir: "inbound", at, body: "ok" });
    else {
      const human = rng.chance(0.6);
      out.push({ ref: `h${n}`, dir: "outbound", at, body: "text", source: human ? "human" : "campaign", outcome: rng.chance(0.9) ? "delivered" : "sent",
        ...(human && rng.chance(0.7) ? { ledger: { state: "delivered" as const, updatedAt: at + MIN } } : {}) });
    }
  }
  void key;
  return out;
}

/** Two messages of one lead at the same instant are ordered by random uuid in the database; the oracle cannot (and should not) predict that, so never generate one. */
export function separateTies(lead: Lead): Lead {
  const seen = new Set<number>();
  for (const m of [...lead.messages].sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref))) {
    while (seen.has(m.at)) m.at += 7_000;
    seen.add(m.at);
  }
  return lead;
}

export type ShapedLead = Lead & { shape: string };

export function prodShapedWorld(counts: ProdCounts, rng: Rng, now: number, opts: { messages?: [number, number] } = {}): World {
  const [lo, hi] = opts.messages ?? [4, 12];
  const leads: Lead[] = [];
  let n = 0;
  const mk = (shape: string, over: Partial<Lead>, msgs: Msg[] = []) => {
    n += 1;
    const base = history(rng, now, `${shape}${n}`, Math.max(0, rng.int(lo, hi) - msgs.length));
    leads.push(emptyLead(`${shape}_${n}`, now, { messages: [...base, ...msgs], stage: rng.chance(0.08) ? "needs_offer" : rng.chance(0.06) ? "offer_sent" : "contacted", tags: [`shape:${shape}`], ...over }));
  };
  const drip = (over: Partial<Enrollment> = {}): Enrollment => ({ status: "active", nextRunAt: now + rng.int(1, 60) * DAY, updatedAt: now - rng.int(1, 600) * MIN, enrolledAt: now - rng.int(2, 40) * DAY, enrolledBy: "none", steps: 4, step: rng.int(1, 3), ...over });
  const dripText = (ref: string, ago: number): Msg => ({ ref, dir: "outbound", at: now - ago, body: "drip", source: "drip", outcome: "sent" });
  for (let i = 0; i < counts.activeDrip; i += 1) mk("active_drip", { enrollment: drip(), stage: "contacted" }, [dripText("d", rng.int(1, 9) * DAY)]);
  for (let i = 0; i < counts.pausedByReply; i += 1) {
    const replied = rng.chance(0.55);
    mk("paused_by_reply", { enrollment: drip({ status: "paused", pause: "inbound_reply", nextRunAt: null }), stage: "contacted", ...(rng.chance(0.2) ? { appointments: [{ ref: "a", due: now + rng.int(-3, 6) * DAY, status: "open" as const }] } : {}) },
      [dripText("d", 4 * DAY), { ref: "in", dir: "inbound", at: now - rng.int(1, 30) * HOUR, body: "reply" }, ...(replied ? [{ ref: "rep", dir: "outbound" as const, at: now - rng.int(0, 1) * HOUR - MIN, body: "back", source: "human" as const, outcome: "sent" as const }] : [])]);
  }
  for (let i = 0; i < counts.providerFailed; i += 1) mk("provider_failed", { enrollment: drip({ status: "paused", pause: "provider_failed", nextRunAt: null }) });
  for (let i = 0; i < counts.scheduledCampaignTexts; i += 1) mk("campaign", {}, [{ ref: "c", dir: "outbound", at: now - DAY, body: "c", source: "campaign", outcome: "queued", scheduledFor: now + rng.int(1, 48) * HOUR }]);
  for (let i = 0; i < counts.noEnrollment; i += 1) {
    const withInbound = i < counts.noEnrollmentWithInbound30d;
    if (withInbound) mk("inbound_no_drip", {}, [{ ref: "in", dir: "inbound", at: now - rng.int(1, 29) * DAY, body: "hi" }]);
    else {
      const r = rng.next();
      if (r < 0.2) mk("texted_recent", {}, [{ ref: "o", dir: "outbound", at: now - rng.int(1, 60) * HOUR, body: "t", source: "human", outcome: "delivered" }]);
      else if (r < 0.35) mk("texted_quiet", {}, [{ ref: "o", dir: "outbound", at: now - rng.int(6, 40) * DAY, body: "t", source: "human", outcome: "delivered" }]);
      else if (r < 0.5) mk("callback", { appointments: [{ ref: "a", due: now + rng.int(-4, 9) * DAY + rng.int(0, 600) * MIN, status: "open" }] });
      else if (r < 0.55) mk("new_lead", { stage: "not_contacted", attempts: [] });
      else mk("nothing_planned", {});
    }
  }
  // leads in states the counts do not name (the 2026-10-14 shape sums to 177 of 181) are plain worked leads
  while (leads.length < counts.leads) mk("other", {});
  while (leads.length > counts.leads) leads.pop();
  // Homeowners who own more than one house (approved rule 2): ~4% of leads in groups of 2-3 sharing one homeowner contact; the group's
  // first lead carries a recent contact-only text, answered on a sibling (by a ledger-backed human text) about half the time. Keeps
  // the scale lane measuring the cross-lead handled check. Assumed share; the 2026-10-14 counts do not record it.
  const pool = leads.filter((l) => !l.contactGroup && l.stage !== "not_contacted");
  let g = 0;
  for (let i = 0; i + 1 < pool.length && i < Math.round(leads.length * 0.04); g += 1) {
    const size = Math.min(rng.chance(0.5) ? 2 : 3, pool.length - i);
    const group = pool.slice(i, i + size);
    i += size;
    const name = `house${g}`;
    const at = now - rng.int(1, 72) * HOUR - 37_000;
    for (const l of group) { l.contactGroup = name; l.contactShared = true; l.tags = [...(l.tags ?? []), "shape:multi_house"]; }
    group[0]!.messages.push({ ref: "co", dir: "inbound", at, body: "which house?", contactOnly: true });
    if (rng.chance(0.5)) {
      const sent = at + rng.int(5, 90) * MIN + 11_000;
      if (sent < now) group[1]!.messages.push({ ref: "coreply", dir: "outbound", at: sent, body: "back", source: "human", outcome: "delivered",
        stamp: { kind: "inbound", ref: "co", lead: group[0]!.key }, ledger: { state: "delivered", updatedAt: sent + MIN } });
    }
  }
  return { now, leads: leads.map(separateTies) };
}
