import { describe, expect, it } from "vitest";

import { canActOnLeadAppointment, isLeadOrgOwner } from "./lead-appointments";

describe("canActOnLeadAppointment", () => {
  const live = { status: "open" as const, assignee_id: "rep-1" };
  it("allows the assignee and an owner on open and snoozed work", () => {
    expect(canActOnLeadAppointment(live, "rep-1", false)).toBe(true);
    expect(canActOnLeadAppointment({ ...live, status: "snoozed" }, "boss", true)).toBe(true);
  });
  it("denies other reps, anonymous viewers and finished work", () => {
    expect(canActOnLeadAppointment(live, "rep-2", false)).toBe(false);
    expect(canActOnLeadAppointment(live, null, true)).toBe(false);
    expect(canActOnLeadAppointment({ ...live, status: "completed" }, "rep-1", true)).toBe(false);
    expect(canActOnLeadAppointment({ ...live, status: "cancelled" }, "rep-1", true)).toBe(false);
  });
});

describe("isLeadOrgOwner", () => {
  const memberships = [
    { user_id: "u1", org_id: "org-a", role: "owner" },
    { user_id: "u1", org_id: "org-b", role: "member" },
  ];
  it("is true only for the lead's own org", () => {
    expect(isLeadOrgOwner(memberships, "u1", "org-a")).toBe(true);
    expect(isLeadOrgOwner(memberships, "u1", "org-b")).toBe(false);
  });
  it("owner in org A + member in org B gets no controls on B's lead", () => {
    const owner = isLeadOrgOwner(memberships, "u1", "org-b");
    expect(canActOnLeadAppointment({ status: "open", assignee_id: "rep-9" }, "u1", owner)).toBe(false);
  });
  it("ignores other users' owner rows", () => {
    expect(isLeadOrgOwner(memberships, "u2", "org-a")).toBe(false);
    expect(isLeadOrgOwner(memberships, null, "org-a")).toBe(false);
  });
});
