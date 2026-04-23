import { describe, expect, it } from "vitest";

import { formatNotification } from "./format";

describe("formatNotification", () => {
  it("owner_message_added → 'New SMS reply' + address in body", () => {
    const out = formatNotification("owner_message_added", {
      propertyAddress: "123 Main St, Kansas City MO",
    });
    expect(out.title).toBe("New SMS reply");
    expect(out.body).toContain("123 Main St, Kansas City MO");
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
});
