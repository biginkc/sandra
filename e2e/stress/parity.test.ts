import { describe, expect, it } from "vitest";

import { ALL_SECTIONS, expectedFromQueueRows, expectedSectionCounts, QUEUE_ROWS_SQL, sectionParityProblems, type RenderedSection } from "./parity";
import { MY_LEAD_STAGE_ORDER } from "../../src/app/(dashboard)/my-leads/_components/types";

const full = (counts: Record<string, number>): RenderedSection[] => ALL_SECTIONS.map((stage) => ({ stage, badge: `${counts[stage] ?? 0} ${(counts[stage] ?? 0) === 1 ? "lead" : "leads"}` }));
const expected = (stages: Record<string, number> = {}, inDrip = 0) => ({ stages: { not_contacted: 0, contacted: 0, needs_offer: 0, offer_sent: 0, under_contract: 0, ...stages }, inDrip });

describe("(b) section parity compares the COMPLETE expected set", () => {
  it("b1 Astra: only not_contacted:5 rendered while the database also has contacted:7", () => {
    const p = sectionParityProblems([{ stage: "not_contacted", badge: "5 leads" }], expected({ not_contacted: 5, contacted: 7 }));
    expect(p).toContain("section contacted missing (database has 7)");
    expect(p).toEqual(expect.arrayContaining(["section needs_offer missing (database has 0)", "section offer_sent missing (database has 0)", "section under_contract missing (database has 0)", "section in_drip missing (database has 0)"]));
  });
  it("b2 all six sections with exact counts pass", () => {
    expect(sectionParityProblems(full({ not_contacted: 5, contacted: 7, in_drip: 2 }), expected({ not_contacted: 5, contacted: 7 }, 2))).toEqual([]);
  });
  it("b3 an extra section fails", () => {
    expect(sectionParityProblems([...full({}), { stage: "dead", badge: "0 leads" }], expected())).toContain("extra section dead");
  });
  it("b4 a duplicated section fails", () => {
    expect(sectionParityProblems([...full({ contacted: 1 }), { stage: "contacted", badge: "1 lead" }], expected({ contacted: 1 }))).toContain("section contacted rendered twice");
  });
  it("b5 an empty section rendered as 0 leads passes", () => {
    expect(sectionParityProblems(full({ contacted: 3 }), expected({ contacted: 3 }))).toEqual([]);
  });
  it("b6 an omitted section fails by default even when the database has none (the page always renders all six)", () => {
    const rendered = full({}).filter((s) => s.stage !== "under_contract");
    expect(sectionParityProblems(rendered, expected())).toContain("section under_contract missing (database has 0)");
  });
  it("b7 the drip section is compared: shows 3, database has 2", () => {
    expect(sectionParityProblems(full({ in_drip: 3 }), expected({}, 2))).toContain("section in_drip shows 3, database has 2");
  });
  it("wrong badge and unreadable badge still fail", () => {
    expect(sectionParityProblems(full({ contacted: 4 }), expected({ contacted: 5 }))).toContain("section contacted shows 4, database has 5");
    const r = full({}); r[1] = { stage: "contacted", badge: "" };
    expect(sectionParityProblems(r, expected()).join()).toMatch(/no readable count badge/);
    expect(sectionParityProblems([], expected())).toContain("no section rendered");
  });
  it("b8 the builder puts active-drip leads under in_drip, not under their stage", () => {
    const { expected: e } = expectedSectionCounts([{ stage: "contacted", in_drip: false, n: 4 }, { stage: "contacted", in_drip: true, n: 2 }]);
    expect(e.stages.contacted).toBe(4);
    expect(e.inDrip).toBe(2);
    expect(sectionParityProblems(full({ contacted: 4, in_drip: 2 }), e)).toEqual([]);
  });
  it("b9 the expected counts come from the rep's queue rows (the page's own owned-lead definition) and refuse non-run leads", () => {
    const rows = [
      { stage: "contacted", in_drip: false, is_run_lead: true }, { stage: "contacted", in_drip: false, is_run_lead: true }, { stage: "contacted", in_drip: true, is_run_lead: true },
      { stage: "not_contacted", in_drip: false, is_run_lead: true },
    ];
    const ok = expectedFromQueueRows(rows);
    expect(ok.problems).toEqual([]);
    expect(ok.expected.stages.contacted).toBe(2);
    expect(ok.expected.inDrip).toBe(1);
    const foreign = expectedFromQueueRows([...rows, { stage: "contacted", in_drip: false, is_run_lead: false }]);
    expect(foreign.problems.join()).toMatch(/1 queue lead\(s\) that are not run leads/);
    expect(QUEUE_ROWS_SQL).toMatch(/my_leads_queue_rows\(\$1, \$2/); // the rep is the member argument ($2)
  });
  it("b10 render-only-when-non-empty mode: an empty stage may be absent, a populated one may not, and present-with-0 is extra", () => {
    const opts = { alwaysRendered: false };
    expect(sectionParityProblems(full({ contacted: 2 }).filter((s) => s.stage === "contacted"), expected({ contacted: 2 }), opts)).toEqual([]);
    expect(sectionParityProblems([], expected({ contacted: 2 }), opts).join()).toMatch(/contacted missing/);
    expect(sectionParityProblems(full({ contacted: 2 }), expected({ contacted: 2 }), opts).join()).toMatch(/rendered although the database has none/);
  });
  it("b11 the always-render default: an omitted empty section fails unless the mode is switched consciously", () => {
    expect(ALL_SECTIONS).toEqual([...MY_LEAD_STAGE_ORDER, "in_drip"]);
    const onlyPopulated = full({ contacted: 2 }).filter((s) => s.stage === "contacted");
    expect(sectionParityProblems(onlyPopulated, expected({ contacted: 2 })).join()).toMatch(/needs_offer missing/);
    expect(sectionParityProblems(onlyPopulated, expected({ contacted: 2 }), { alwaysRendered: false })).toEqual([]);
  });
  it("the badge regex is plural-correct: `1 lead` and `N leads` only", () => {
    expect(sectionParityProblems(full({ contacted: 1 }), expected({ contacted: 1 }))).toEqual([]);
    const wrong = full({ contacted: 1 }).map((s) => (s.stage === "contacted" ? { ...s, badge: "1 leads" } : s));
    expect(sectionParityProblems(wrong, expected({ contacted: 1 })).join()).toMatch(/no readable count badge/);
    const wrong2 = full({ contacted: 2 }).map((s) => (s.stage === "contacted" ? { ...s, badge: "2 lead" } : s));
    expect(sectionParityProblems(wrong2, expected({ contacted: 2 })).join()).toMatch(/no readable count badge/);
  });
  it("b12 a stage in the database that the app does not know is reported, never dropped", () => {
    const { problems } = expectedSectionCounts([{ stage: "mystery", in_drip: false, n: 3 }]);
    expect(problems).toEqual(["unknown stage mystery in database (3 lead(s))"]);
  });
});
