import { beforeEach, describe, expect, it, vi } from "vitest";

const enrollLead = vi.hoisted(() => vi.fn());
vi.mock("./enrollment", () => ({ enrollLead }));

import { previewFirstSend, startFollowUpDrip } from "./start-drip";

beforeEach(() => enrollLead.mockReset());

describe("startFollowUpDrip", () => {
  it("reports mixed results and continues after a throw", async () => {
    enrollLead.mockResolvedValueOnce({ status: "enrolled", enrollmentId: "e1", sequenceLabel: "Drip" })
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ status: "duplicate_active" });
    const result = await startFollowUpDrip({} as never, {
      propertyIds: ["p1", "p2", "p3"], sequenceId: "s1", userId: "u1",
    });
    expect(result.results).toEqual([
      { propertyId: "p1", status: "enrolled", reason: "Enrolled" },
      { propertyId: "p2", status: "failed", reason: "Could not enroll this lead." },
      { propertyId: "p3", status: "skipped", reason: "Already in this drip" },
    ]);
    expect(enrollLead).toHaveBeenCalledTimes(3);
  });

  it("previews step zero in the requested timezone", () => {
    expect(previewFirstSend(60, "America/Chicago", new Date("2026-09-28T12:00:00Z")))
      .toContain("Monday, Sep 28");
  });

  it("reports suppression as a skip with the plain reason", async () => {
    enrollLead.mockResolvedValueOnce({ status: "suppressed", message: "This contact is marked do not contact." });
    expect((await startFollowUpDrip({} as never, { propertyIds: ["p1"], sequenceId: "s1", userId: "u1" })).results)
      .toEqual([{ propertyId: "p1", status: "skipped", reason: "This contact is marked do not contact." }]);
  });

  it("reports a different active drip as a skip with its name and step", async () => {
    const message = "Already in Quiet check-in, text 2 of 4. Stop it or switch.";
    enrollLead.mockResolvedValueOnce({ status: "already_in_drip", message });
    expect((await startFollowUpDrip({} as never, { propertyIds: ["p1"], sequenceId: "s1", userId: "u1" })).results)
      .toEqual([{ propertyId: "p1", status: "skipped", reason: message }]);
  });
});
