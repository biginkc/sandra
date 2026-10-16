import { createHash } from "node:crypto";

import { createRng, type Rng } from "./prng";

/**
 * The seeded scenario manifest. `CHAOS_SEED` -> one PRNG -> an ordered list of ticks. Scenario SET and
 * COUNTS are fixed (the plan's mandatory table); order, driver split, mutations and background noise
 * are randomized from the seed. The `expected` column is the terminal result the oracle will demand;
 * it is derived from the schedule alone, never from observed rows.
 */

export type ScenarioId =
  | "clean_call"
  | "duplicate_webhooks"
  | "out_of_order"
  | "late_hangup_after_expiry"
  | "double_click_dial"
  | "native_assign"
  | "lost_response"
  | "second_tab_retry"
  | "reminder_reschedule"
  | "contract"
  | "supersede"
  | "two_tabs_edits"
  | "offline_send";

export type Actor = "replay" | "browser" | "noise";
export type QuickPickName = "tomorrow" | "three_days" | "next_week";

export type Expected = {
  /** Exact dials the provider stub must have received for the scheduled lead's number. */
  dials: number;
  /** Exact dialpad-sourced attempts on the lead. */
  attempts: number;
  attemptOutcome?: "reached" | "no_answer" | "voicemail" | "wrong_number";
  /** Marker string: exactly one lead_notes row on the lead whose body contains it. */
  noteMarker?: string;
  /** Exactly one open appointment on the lead at quickPickDueAt(pick, actionTime) (after all reschedules). */
  appointment?: { pick: QuickPickName; reschedulePick?: QuickPickName };
  /** Intent for the call carries the failed marker (late hangup scenario). */
  intentFailedMarker?: boolean;
  /** Logical contracts (distinct send intents with a provider request) for the lead. */
  contracts?: number;
  /** Offers logged for the lead (all projections state=logged). */
  offers?: number;
  /** Contract send whose result is unknown: exactly one provider request, never resent, no offer logged. */
  contractSendUnknown?: boolean;
  /** Stale pending offers superseded (supersede recovery). */
  supersededStale?: number;
  /** Seller reminder texts sent for the lead (mock provider). */
  reminderSent?: number;
  /** Open (non-cancelled) appointments at end for reminder races. */
  quarantineResolved?: boolean;
  /** Second request in a conflict scenario must be rejected with this documented code. */
  conflictCode?: string;
};

export type Tick = {
  tick: number;
  actor: Actor;
  scenario: ScenarioId | "noise_sweep";
  /** Index into the world's lead list (0-based). Noise ticks use -1. */
  leadSlot: number;
  args: Record<string, unknown>;
  expected: Expected;
};

export const MANDATORY: ReadonlyArray<{ scenario: ScenarioId; count: number; variants: readonly string[] }> = [
  { scenario: "clean_call", count: 18, variants: [] },
  { scenario: "duplicate_webhooks", count: 6, variants: [] },
  { scenario: "out_of_order", count: 5, variants: [] },
  { scenario: "late_hangup_after_expiry", count: 4, variants: [] },
  { scenario: "double_click_dial", count: 4, variants: [] },
  { scenario: "native_assign", count: 4, variants: [] },
  { scenario: "lost_response", count: 4, variants: ["dial", "dial", "contract", "sms"] },
  { scenario: "second_tab_retry", count: 3, variants: ["prompt_save", "prompt_save", "contract_send"] },
  { scenario: "reminder_reschedule", count: 3, variants: ["plain", "reschedule", "reschedule_race"] },
  { scenario: "contract", count: 3, variants: ["clean", "double_click", "send_unknown"] },
  { scenario: "supersede", count: 1, variants: [] },
  { scenario: "two_tabs_edits", count: 2, variants: [] },
  { scenario: "offline_send", count: 2, variants: ["contract", "contract"] },
];

export const MANDATORY_TOTAL = MANDATORY.reduce((n, s) => n + s.count, 0);

export type Profile = "full" | "short";
/** `short` is for the harness self-test and local proofs only: it can never produce a PASS verdict. One of every scenario variant, fewer repeats. */
const SHORT_COUNTS: Partial<Record<ScenarioId, number>> = {
  clean_call: 2, duplicate_webhooks: 1, out_of_order: 1, late_hangup_after_expiry: 1, double_click_dial: 1, native_assign: 1,
  lost_response: 3, second_tab_retry: 3, reminder_reschedule: 3, contract: 3, supersede: 1, two_tabs_edits: 1, offline_send: 2,
};

/** Which instances only a real browser can realize (UI gestures). The rest run in the replay engine. */
const BROWSER_QUOTA: Partial<Record<ScenarioId, number>> = {
  clean_call: 6,
  double_click_dial: 2,
  lost_response: 1, // the "sms" variant (mock provider cannot be gated server-side)
  second_tab_retry: 1,
  two_tabs_edits: 1,
  offline_send: 1,
};

const PICKS: readonly QuickPickName[] = ["tomorrow", "three_days", "next_week"];

function expectedFor(scenario: ScenarioId, variant: string | undefined, tick: number, runTag: string, rng: Rng): Expected {
  const marker = `${runTag} note t${tick}`;
  switch (scenario) {
    case "clean_call":
    case "duplicate_webhooks":
    case "out_of_order":
      return { dials: 1, attempts: 1, attemptOutcome: "reached", noteMarker: marker, appointment: { pick: scenario === "clean_call" ? "next_week" : rng.pick(PICKS) } };
    case "late_hangup_after_expiry":
      return { dials: 1, attempts: 1, attemptOutcome: "reached", intentFailedMarker: true, noteMarker: marker };
    case "double_click_dial":
      // One key double-clicked: one dial. A fresh-key retry while in flight is refused by the app's guards. After expiry, the retry dials once.
      return { dials: 2, attempts: 1, attemptOutcome: "reached", noteMarker: marker, conflictCode: "call_in_flight|prior_call_unresolved|already_dispatched|rate_limited" };
    case "native_assign":
      return { dials: 0, attempts: 1, attemptOutcome: "reached", quarantineResolved: true, noteMarker: marker };
    case "lost_response":
      if (variant === "contract") return { dials: 0, attempts: 0, contracts: 1, offers: 1 };
      // The browser realizes "sms" as a real call from the UI with a gated, reloaded prompt save: one dial, one attempt, recovered after the reload.
      if (variant === "sms") return { dials: 1, attempts: 1, attemptOutcome: "reached" };
      return { dials: 1, attempts: 1, attemptOutcome: "reached", noteMarker: marker, conflictCode: "call_in_flight|prior_call_unresolved|already_dispatched|rate_limited" };
    case "second_tab_retry":
      if (variant === "contract_send") return { dials: 0, attempts: 0, contracts: 1, offers: 1, conflictCode: "OPEN_CONTRACT_EXISTS" };
      return { dials: 1, attempts: 1, attemptOutcome: "reached", noteMarker: marker, conflictCode: "STALE_STATE" };
    case "reminder_reschedule":
      // The race variant may legitimately send once or not at all; the invariants (<=1 per chain/day) bound it.
      return { dials: 0, attempts: 0, appointment: { pick: "tomorrow", reschedulePick: variant === "plain" ? undefined : "three_days" }, reminderSent: variant === "plain" ? 1 : variant === "reschedule" ? 0 : undefined };
    case "contract":
      if (variant === "send_unknown") return { dials: 0, attempts: 0, contracts: 1, offers: 0, contractSendUnknown: true };
      return { dials: 0, attempts: 0, contracts: 1, offers: 1 };
    case "supersede":
      return { dials: 0, attempts: 0, contracts: 1, offers: 1, supersededStale: 1 };
    case "two_tabs_edits":
      // The stale tab's edit is refused (the appointment row was replaced: P0001 "not open"); after a refresh the later edit lands.
      return { dials: 0, attempts: 0, noteMarker: marker, appointment: { pick: "three_days" }, conflictCode: "P0001" };
    case "offline_send":
      return { dials: 0, attempts: 0, contracts: 1, offers: 1 };
  }
}

export type Manifest = {
  profile: Profile;
  seed: number;
  runTag: string;
  ticks: Tick[];
  total: number;
  hash: string;
};

/** Build the full schedule. Pure function of (seed, runTag, leadSlots); the same inputs give a byte-identical schedule. */
export function buildManifest(seed: number, runTag: string, opts: { noiseTicks?: number; profile?: Profile } = {}): Manifest {
  const rng = createRng(seed);
  const profile = opts.profile ?? "full";
  type Pending = { scenario: ScenarioId; variant?: string; actor: Actor };
  const pending: Pending[] = [];
  for (const row of MANDATORY) {
    const count = profile === "short" ? SHORT_COUNTS[row.scenario] ?? row.count : row.count;
    let browserLeft = profile === "short" ? Math.min(BROWSER_QUOTA[row.scenario] ?? 0, 1) : BROWSER_QUOTA[row.scenario] ?? 0;
    for (let i = 0; i < count; i += 1) {
      const variant = row.variants[i];
      // lost_response "sms" is the single browser instance of its scenario; others follow the quota order.
      let actor: Actor = "replay";
      if (row.scenario === "lost_response") actor = variant === "sms" ? "browser" : "replay";
      else if (row.scenario === "offline_send") actor = i === 0 ? "browser" : "replay";
      else if (browserLeft > 0) {
        actor = "browser";
        browserLeft -= 1;
      }
      pending.push({ scenario: row.scenario, variant, actor });
    }
  }
  const order = rng.shuffle(pending);
  const ticks: Tick[] = [];
  const noise = opts.noiseTicks ?? (profile === "short" ? 3 : 12);
  const noisePositions = new Set<number>();
  while (noisePositions.size < noise) noisePositions.add(rng.int(0, order.length));
  let tick = 0;
  let slot = 0;
  for (let i = 0; i <= order.length; i += 1) {
    if (noisePositions.has(i)) {
      ticks.push({ tick: (tick += 1), actor: "noise", scenario: "noise_sweep", leadSlot: -1, args: { crons: rng.shuffle(["dialpad-call-events-sweep", "dialpad-artifact-sweep", "offer-projection-sweep", "appointment-reminder-sweep"]).slice(0, rng.int(1, 3)) }, expected: { dials: 0, attempts: 0 } });
    }
    const p = order[i];
    if (!p) continue;
    tick += 1;
    const args: Record<string, unknown> = { variant: p.variant ?? null };
    if (p.scenario === "duplicate_webhooks") args.duplicates = rng.int(2, 3);
    if (p.scenario === "clean_call" || p.scenario === "duplicate_webhooks" || p.scenario === "out_of_order") {
      args.delayMs = rng.int(0, 400);
      args.durationMs = rng.int(2000, 6000);
    }
    if (p.scenario === "out_of_order") args.order = rng.shuffle(["calling", "connected", "hangup"]).sort((a, b) => (a === "hangup" ? -1 : b === "hangup" ? 1 : 0));
    ticks.push({ tick, actor: p.actor, scenario: p.scenario, leadSlot: slot, args, expected: expectedFor(p.scenario, p.variant, tick, runTag, rng) });
    slot += 1;
  }
  const hash = createHash("sha256").update(ticks.map((t) => JSON.stringify(t)).join("\n")).digest("hex");
  return { profile, seed, runTag, ticks, total: ticks.filter((t) => t.actor !== "noise").length, hash };
}

export function toNdjson(m: Manifest): string {
  return m.ticks.map((t) => JSON.stringify(t)).join("\n") + "\n";
}

export function parseNdjson(text: string): Tick[] {
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Tick);
}

/** Scenario -> instance count in a schedule (used by the "every mandatory row executed" check). */
export function countByScenario(ticks: readonly Tick[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ticks) if (t.actor !== "noise") out[t.scenario] = (out[t.scenario] ?? 0) + 1;
  return out;
}
