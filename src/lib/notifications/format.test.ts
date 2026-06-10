import { describe, expect, it } from "vitest";

import { formatNotification, humanDueDate } from "./format";

describe("formatNotification", () => {
  it("owner_message_added → 'New SMS reply' + address in body", () => {
    const out = formatNotification("owner_message_added", {
      propertyAddress: "123 Main St, Kansas City MO",
    });
    expect(out.title).toBe("New SMS reply");
    expect(out.body).toContain("123 Main St, Kansas City MO");
  });

  it("owner_message_added triage path calls out missing property resolution", () => {
    const out = formatNotification("owner_message_added", {
      propertyAddress: null,
      needsPropertyTriage: true,
      messageBody: "Need to know which house this is for",
    });
    expect(out.title).toBe("New SMS reply needs property triage");
    expect(out.body).toContain("property");
    expect(out.body).toContain("Need to know which house this is for");
  });

  it("property_assigned → 'Lead assigned to you' + address + assigner in body", () => {
    const out = formatNotification("property_assigned", {
      propertyAddress: "456 Oak Ave",
      assignerName: "Jarrad",
    });
    expect(out.title).toBe("Lead assigned to you");
    expect(out.body).toContain("456 Oak Ave");
    expect(out.body).toContain("Jarrad");
  });

  it("bulk_action_completed → human-readable job label + counts in body", () => {
    const out = formatNotification("bulk_action_completed", {
      jobType: "cass_dsf2_ncoa",
      state: "completed",
      succeeded: 50,
      failed: 2,
    });
    // Human-readable label, not the raw enum.
    expect(out.title).not.toContain("cass_dsf2_ncoa");
    expect(out.title.toLowerCase()).toContain("address verification");
    expect(out.body).toContain("50");
    expect(out.body).toContain("2");
  });

  it("bulk_action_completed title reflects state (failed vs partial vs canceled)", () => {
    expect(
      formatNotification("bulk_action_completed", {
        jobType: "cass_dsf2_ncoa",
        state: "failed",
        succeeded: 0,
        failed: 10,
      }).title.toLowerCase(),
    ).toContain("failed");

    expect(
      formatNotification("bulk_action_completed", {
        jobType: "cass_dsf2_ncoa",
        state: "partial",
        succeeded: 8,
        failed: 2,
      }).title.toLowerCase(),
    ).toMatch(/error|partial/);

    expect(
      formatNotification("bulk_action_completed", {
        jobType: "cass_dsf2_ncoa",
        state: "canceled",
        succeeded: 0,
        failed: 0,
      }).title.toLowerCase(),
    ).toContain("cancel");
  });

  it("tolerates missing / null fields without crashing (defensive fallbacks)", () => {
    const m = formatNotification("owner_message_added", {
      propertyAddress: null,
    });
    expect(m.title).toBe("New SMS reply");
    expect(m.body).toMatch(/property|reply/i);

    const a = formatNotification("property_assigned", {
      propertyAddress: undefined,
      assignerName: null,
    });
    expect(a.title).toBe("Lead assigned to you");
    expect(a.body.length).toBeGreaterThan(0);

    const b = formatNotification("bulk_action_completed", {});
    // Falls back to generic "Job" label + "finished" state; counts default to 0.
    expect(b.title.length).toBeGreaterThan(0);
    expect(b.body).toContain("0");
  });

  it("falls back to the raw jobType when unknown (no map entry)", () => {
    const out = formatNotification("bulk_action_completed", {
      jobType: "made_up_job",
      state: "completed",
      succeeded: 1,
      failed: 0,
    });
    expect(out.title.toLowerCase()).toContain("made_up_job");
  });

  it("task_assigned → 'Task assigned: <title>' with type label + due in body", () => {
    // dueAt one day from a fixed "now" — the formatter uses real-time
    // now, so we feed dueAt = real-now + 1d to land in "tomorrow" reliably.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const out = formatNotification("task_assigned", {
      taskTitle: "Follow up on 123 Main St",
      taskType: "follow_up",
      dueAt: tomorrow,
    });
    expect(out.title).toBe("Task assigned: Follow up on 123 Main St");
    expect(out.body).toContain("Follow-up");
    expect(out.body).toContain("Due tomorrow");
  });

  it("task_assigned truncates long titles at 60 chars", () => {
    const long = "a".repeat(80);
    const out = formatNotification("task_assigned", {
      taskTitle: long,
      taskType: "callback",
      dueAt: new Date().toISOString(),
    });
    // 57 chars + "..." = 60 chars
    expect(out.title).toBe(`Task assigned: ${"a".repeat(57)}...`);
    expect(out.body).toContain("Callback");
  });

  it("task_assigned tolerates missing fields", () => {
    const out = formatNotification("task_assigned", {});
    expect(out.title).toContain("new task");
    expect(out.body).toContain("Due soon");
    expect(out.body).toContain("Task");
  });
});

describe("humanDueDate", () => {
  const NOW = new Date("2026-05-06T18:00:00Z");

  it("returns 'today' when dueAt is the same calendar day", () => {
    expect(humanDueDate("2026-05-06T22:00:00Z", NOW)).toBe("today");
  });

  it("returns 'tomorrow' when dueAt is the next calendar day", () => {
    expect(humanDueDate("2026-05-07T14:00:00Z", NOW)).toBe("tomorrow");
  });

  it("returns weekday + month + day for further dates", () => {
    const out = humanDueDate("2026-05-11T14:00:00Z", NOW);
    // exact format depends on locale, but it shouldn't be "today" or "tomorrow"
    expect(out).not.toBe("today");
    expect(out).not.toBe("tomorrow");
    expect(out).toMatch(/May/);
  });

  it("returns 'soon' for an unparseable ISO string", () => {
    expect(humanDueDate("not-a-date", NOW)).toBe("soon");
  });
});
