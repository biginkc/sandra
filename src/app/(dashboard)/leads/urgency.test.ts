import { describe, expect, it } from "vitest";

import {
  compareLeadUrgency,
  formatNextAction,
  matchesUrgencyFilter,
  type UrgencyLead,
} from "./urgency";

const DAY_START = "2026-08-15T05:00:00.000Z";
const DAY_END = "2026-08-16T05:00:00.000Z";

function lead(id: string, dueAt: string | null): UrgencyLead {
  return { id, next_task_due_at: dueAt };
}

describe("Leads urgency contract", () => {
  it("orders overdue, today, scheduled later, then no next action deterministically", () => {
    const rows = [
      lead("z-none", null),
      lead("b-today", "2026-08-15T15:00:00.000Z"),
      lead("a-later", "2026-08-18T15:00:00.000Z"),
      lead("b-overdue", "2026-08-14T15:00:00.000Z"),
      lead("a-overdue", "2026-08-13T15:00:00.000Z"),
      lead("a-today", "2026-08-15T15:00:00.000Z"),
      lead("a-none", null),
    ];

    expect(
      rows.sort((a, b) => compareLeadUrgency(a, b, DAY_START, DAY_END)).map((r) => r.id),
    ).toEqual([
      "a-overdue",
      "b-overdue",
      "a-today",
      "b-today",
      "a-later",
      "a-none",
      "z-none",
    ]);
  });

  it("classifies each visit-only urgency filter against Chicago day bounds", () => {
    const rows = [
      lead("overdue", "2026-08-15T04:59:59.999Z"),
      lead("today", "2026-08-15T05:00:00.000Z"),
      lead("later", "2026-08-16T05:00:00.000Z"),
      lead("none", null),
    ];

    expect(rows.filter((r) => matchesUrgencyFilter(r, "overdue", DAY_START, DAY_END)).map((r) => r.id)).toEqual(["overdue"]);
    expect(rows.filter((r) => matchesUrgencyFilter(r, "today", DAY_START, DAY_END)).map((r) => r.id)).toEqual(["today"]);
    expect(rows.filter((r) => matchesUrgencyFilter(r, "scheduled", DAY_START, DAY_END)).map((r) => r.id)).toEqual(["later"]);
    expect(rows.filter((r) => matchesUrgencyFilter(r, "none", DAY_START, DAY_END)).map((r) => r.id)).toEqual(["none"]);
  });

  it("formats overdue, today, scheduled and missing rows without calling them suppressed", () => {
    expect(formatNextAction("2026-08-13T15:00:00.000Z", DAY_START, DAY_END)).toMatchObject({ tone: "overdue", label: "Overdue 2d" });
    expect(formatNextAction("2026-08-15T15:30:00.000Z", DAY_START, DAY_END, "America/Chicago")).toMatchObject({ tone: "today", label: "Today 10:30 AM" });
    expect(formatNextAction("2026-08-18T15:00:00.000Z", DAY_START, DAY_END, "America/Chicago")).toMatchObject({ tone: "scheduled", label: "Tue, Aug 18" });
    expect(formatNextAction(null, DAY_START, DAY_END)).toMatchObject({ tone: "none", label: "No next action" });
  });
});
