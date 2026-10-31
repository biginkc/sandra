import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { V2_ROAD_ACTIONS } from "./actions";
import { applyHaikuPolicy, type FinalDecision } from "./haiku-policy";
import type { HaikuAnswer, HaikuFailure } from "./haiku";
import type { PropertyTypeOption, V2QuestionId } from "./questions";
import { routeV2, type V2Decision } from "./route";

/**
 * Routing v2 regression expectations (A-014). Each row's expected road comes from APPROVED policy
 * with a rule citation (stress runner table); nothing here snapshots the current answers.
 * - LABELED rows must match.
 * - KNOWN_FAIL rows run with it.fails: when one starts passing the suite breaks, so the table is
 *   updated on purpose.
 * - UNLABELED rows are excluded.
 * The road is replayed deterministically from the recorded Jev / Haiku answers through the pure
 * router (routeV2 + applyHaikuPolicy) with the row's own text, so the code checks and D-1 run.
 *
 * Real seller replies are NEVER committed (Jarrad 2026-10-31). The committed fixture holds only
 * synthetic pack wordings (regression-synthetic.json). The real-reply rows run locally from the
 * file named by ROUTING_V2_EXPECTATIONS; without it (CI) they are skipped, never passed.
 */
type Probs = Record<V2QuestionId, number>;
type PT = Record<PropertyTypeOption, number>;
type Assertion = { type: "not_prov" | "not_road"; value: string };
type ExpectationRow = {
  row_id: string;
  status: "LABELED" | "KNOWN_FAIL" | "UNLABELED";
  rule: string | null;
  text: string | null;
  expected_roads: string[] | null;
  assertions: Assertion[];
};
type SyntheticRow = ExpectationRow & { recorded_probs: Probs; recorded_property_type: PT; recorded_haiku: [string, number] | null };

const ok = (option: string, confidence: number): HaikuAnswer => ({ ok: true, option, confidence });

/** The road a person sees: an invalid Haiku answer is a hold; a Haiku-decided stop is a possible stop. */
function roadOf(f: FinalDecision): string {
  if (f.road === null) return "HOLD_haiku_error";
  if (f.hold && f.road === "stop" && f.by !== "jev") return "possible_stop";
  return f.road;
}

function evaluate(text: string, probabilities: Probs, propertyType: PT, haiku: HaikuAnswer | HaikuFailure | null) {
  const d: V2Decision = routeV2({ reply: text, probabilities, propertyType });
  const f = applyHaikuPolicy(d, d.haiku ? haiku : null, probabilities);
  return { road: roadOf(f), check: d.provenance.by === "code" ? d.provenance.check : null };
}

function assertRow(row: ExpectationRow, got: { road: string; check: string | null }) {
  if (row.expected_roads) expect(row.expected_roads).toContain(got.road);
  for (const a of row.assertions) {
    if (a.type === "not_road") expect(got.road).not.toBe(a.value);
    else expect(got.check).not.toBe(a.value);
  }
}

const runRow = (row: ExpectationRow, body: () => void) => {
  const name = `${row.row_id} [${row.rule ?? "-"}]`;
  if (row.status === "KNOWN_FAIL") it.fails(`KNOWN_FAIL ${name}`, body);
  else it(name, body);
};

const SYNTHETIC = JSON.parse(readFileSync(join(__dirname, "__fixtures__/regression-synthetic.json"), "utf8")) as { rows: SyntheticRow[] };
/** Every road a person can see: the approved roads, the Haiku-unsure alert and the two holds. */
const VALID_ROADS = new Set<string>([...Object.keys(V2_ROAD_ACTIONS), "ALERT_haiku_unsure", "possible_stop", "HOLD_haiku_error"]);

describe("label-free invariants over the synthetic rows (CI; replace the dropped per-road count pin)", () => {
  it("every synthetic row resolves to a known road", () => {
    for (const row of SYNTHETIC.rows) {
      const haiku = row.recorded_haiku ? ok(row.recorded_haiku[0], row.recorded_haiku[1]) : null;
      const { road } = evaluate(row.text!, row.recorded_probs, row.recorded_property_type, haiku);
      expect(VALID_ROADS.has(road), `${row.row_id}: ${road}`).toBe(true);
    }
  });
  it("a Haiku parser failure on any Haiku-band row never routes to a send: it is a hold", () => {
    let banded = 0;
    for (const row of SYNTHETIC.rows) {
      const d = routeV2({ reply: row.text!, probabilities: row.recorded_probs, propertyType: row.recorded_property_type });
      if (!d.haiku) continue;
      banded++;
      const f = applyHaikuPolicy(d, { ok: false, reason: "haiku_invalid:parser" }, row.recorded_probs);
      expect(roadOf(f), row.row_id).toBe("HOLD_haiku_error");
      expect(f.hold, row.row_id).toBe(true);
    }
    expect(banded).toBeGreaterThan(0);
  });
});

describe("regression expectations: synthetic rows (committed, run in CI)", () => {
  const fixture = SYNTHETIC;
  it("covers the labeled synthetic table (no UNLABELED rows committed)", () => {
    expect(fixture.rows.length).toBeGreaterThan(50);
    expect(fixture.rows.every((r) => r.status === "LABELED" || r.status === "KNOWN_FAIL")).toBe(true);
  });
  for (const row of fixture.rows) {
    runRow(row, () => {
      const haiku = row.recorded_haiku ? ok(row.recorded_haiku[0], row.recorded_haiku[1]) : null;
      assertRow(row, evaluate(row.text!, row.recorded_probs, row.recorded_property_type, haiku));
    });
  }
});

const LOCAL = process.env.ROUTING_V2_EXPECTATIONS;
describe("regression expectations: real-reply rows (local only, ROUTING_V2_EXPECTATIONS)", () => {
  if (!LOCAL) {
    it.skip("SKIPPED: ROUTING_V2_EXPECTATIONS is not set. Real seller replies are never committed; set it to the local regression-expectations.jsonl to run these rows.", () => {});
    return;
  }
  if (!existsSync(LOCAL)) {
    it(`ROUTING_V2_EXPECTATIONS points at a missing file: ${LOCAL}`, () => { throw new Error("expectations file not found"); });
    return;
  }
  type Fix = { questionOrder: V2QuestionId[]; propertyTypeOrder: PropertyTypeOption[]; rows: Array<[string | null, number[] | null, number[] | null, unknown, string, string, number]> };
  const FIX = JSON.parse(readFileSync(join(__dirname, "__fixtures__/replay-v7.json"), "utf8")) as Fix;
  const V8 = new Map(
    (JSON.parse(readFileSync(join(__dirname, "__fixtures__/replay-v8-haiku.json"), "utf8")) as { rows: Array<[number, string | null, number | string]> }).rows.map(
      ([i, opt, c]) => [i, opt === null ? ({ ok: false, reason: String(c) } as HaikuFailure) : ok(opt, Number(c))] as const,
    ),
  );
  const rows = readFileSync(LOCAL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ExpectationRow & { _header?: boolean })
    .filter((r) => !r._header && r.row_id.startsWith("replay:") && (r.status === "LABELED" || r.status === "KNOWN_FAIL"));
  // Pinned to the exact table (regression-expectations.jsonl, built at 30d35369b): 1,814 rows,
  // 84 of them real-reply LABELED / KNOWN_FAIL. A different file fails here instead of silently
  // checking fewer rows.
  it("is the expected table: 1,814 rows, 84 real-reply LABELED / KNOWN_FAIL", () => {
    const all = readFileSync(LOCAL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { _header?: boolean });
    expect(all.filter((r) => !r._header)).toHaveLength(1814);
    expect(rows).toHaveLength(84);
  });
  for (const row of rows) {
    runRow(row, () => {
      const i = Number(row.row_id.slice("replay:".length));
      const [, p, pt] = FIX.rows[i]!;
      const probabilities = Object.fromEntries(FIX.questionOrder.map((q, k) => [q, p?.[k] ?? 0])) as Probs;
      const propertyType = Object.fromEntries(FIX.propertyTypeOrder.map((o, k) => [o, pt?.[k] ?? 0])) as PT;
      expect(row.text, `${row.row_id}: a LABELED / KNOWN_FAIL row needs its text`).toBeTypeOf("string");
      assertRow(row, evaluate(row.text!, probabilities, propertyType, V8.get(i) ?? null));
    });
  }
});

const REAL = process.env.ROUTING_V2_REAL_REPLIES;
describe("privacy: no committed synthetic text equals a real seller reply (local only, ROUTING_V2_REAL_REPLIES)", () => {
  if (!REAL) {
    it.skip("SKIPPED: ROUTING_V2_REAL_REPLIES is not set (the real replies are local only).", () => {});
    return;
  }
  // Case, whitespace and punctuation are ignored (review B1 of 72229239848d).
  const norm = (t: string | null | undefined) => (t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  it("no committed synthetic text matches a real reply after normalization", () => {
    const real = new Set((JSON.parse(readFileSync(REAL, "utf8")) as Array<{ reply?: string }>).map((r) => norm(r.reply)).filter(Boolean));
    expect(real.size).toBeGreaterThan(100);
    expect(SYNTHETIC.rows.filter((r) => real.has(norm(r.text))).map((r) => r.row_id)).toEqual([]);
  });
});
