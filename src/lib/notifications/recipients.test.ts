import { describe, expect, it } from "vitest";

import {
  resolveAssignmentRecipients,
  resolveJobRecipients,
  resolveOwnerMessageRecipients,
} from "./recipients";

describe("resolveOwnerMessageRecipients", () => {
  it("returns the assignee when set, ignoring admin fallback", () => {
    expect(
      resolveOwnerMessageRecipients({
        assignedUserId: "u1",
        adminUserIds: ["u3"],
      }),
    ).toEqual(["u1"]);
  });

  it("falls back to all admins when unassigned", () => {
    expect(
      resolveOwnerMessageRecipients({
        assignedUserId: null,
        adminUserIds: ["u3", "u4"],
      }),
    ).toEqual(["u3", "u4"]);
  });

  it("returns empty when unassigned and there are no admins (defensive)", () => {
    expect(
      resolveOwnerMessageRecipients({
        assignedUserId: null,
        adminUserIds: [],
      }),
    ).toEqual([]);
  });
});

describe("resolveAssignmentRecipients", () => {
  it("returns the new assignee when someone else assigned them", () => {
    expect(
      resolveAssignmentRecipients({ newAssigneeId: "u2", actorId: "u1" }),
    ).toEqual(["u2"]);
  });

  it("suppresses self-assign (decision #1) — zero recipients", () => {
    expect(
      resolveAssignmentRecipients({ newAssigneeId: "u1", actorId: "u1" }),
    ).toEqual([]);
  });

  it("treats unassign (null newAssigneeId) as a non-event — zero recipients", () => {
    expect(
      resolveAssignmentRecipients({ newAssigneeId: null, actorId: "u1" }),
    ).toEqual([]);
  });
});

describe("resolveJobRecipients", () => {
  it("returns the job creator when set", () => {
    expect(resolveJobRecipients({ createdBy: "u1" })).toEqual(["u1"]);
  });

  it("returns empty when the job has no creator (system-created jobs)", () => {
    expect(resolveJobRecipients({ createdBy: null })).toEqual([]);
  });
});
