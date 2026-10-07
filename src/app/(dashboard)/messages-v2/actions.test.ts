import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  memberships: vi.fn(),
  revalidatePath: vi.fn(),
  sendHeldDraft: vi.fn(),
  editAndSendHeldDraft: vi.fn(),
  takeOverHold: vi.fn(),
  dismissHold: vi.fn(),
  assignHold: vi.fn(),
  listPropertyOrgUsers: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: m.getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: m.memberships }));
vi.mock("@/lib/events", () => ({ recordLeadEvent: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pipeline-runs", () => ({ recordStep: vi.fn(), resumeRun: vi.fn() }));
vi.mock("@/lib/ai-responder/dispatch", () => ({ sendHumanDraft: vi.fn() }));
vi.mock("../leads/actions", () => ({
  updateLeadAssignee: vi.fn(),
  listPropertyOrgUsers: m.listPropertyOrgUsers,
}));
vi.mock("./hold-actions", () => ({
  sendHeldDraft: m.sendHeldDraft,
  editAndSendHeldDraft: m.editAndSendHeldDraft,
  takeOverHold: m.takeOverHold,
  dismissHold: m.dismissHold,
  assignHold: m.assignHold,
}));

import {
  assignHoldAction,
  dismissHoldAction,
  editAndSendHeldDraftAction,
  listHoldAssigneesAction,
  sendHeldDraftAction,
  takeOverHoldAction,
} from "./actions";

const ownerMembership = { user_id: "u1", org_id: "org-1", role: "owner", acquisitions_enabled: false, access_status: "active" };
const acqMembership = { user_id: "u2", org_id: "org-1", role: "member", acquisitions_enabled: true, access_status: "active" };
const plainMembership = { user_id: "u3", org_id: "org-1", role: "member", acquisitions_enabled: false, access_status: "active" };

beforeEach(() => {
  vi.clearAllMocks();
  m.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  m.memberships.mockResolvedValue([ownerMembership]);
  for (const fn of [m.sendHeldDraft, m.editAndSendHeldDraft, m.takeOverHold, m.dismissHold, m.assignHold]) {
    fn.mockResolvedValue({ ok: true, data: null });
  }
});

describe("messages-v2 hold server actions", () => {
  it("run for an owner, with the user and org the server resolved (never client-supplied)", async () => {
    const result = await sendHeldDraftAction({ draftId: "d1" });
    expect(result).toEqual({ ok: true, data: null });
    expect(m.sendHeldDraft).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", userId: "u1" }),
      { draftId: "d1" },
    );
    expect(m.revalidatePath).toHaveBeenCalledWith("/messages-v2");
  });

  it("run for an acquisitions member", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: "u2" } } });
    m.memberships.mockResolvedValue([acqMembership]);
    expect(await takeOverHoldAction({ propertyId: "p1" })).toMatchObject({ ok: true });
    expect(m.takeOverHold).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }), { propertyId: "p1" });
  });

  it("refuse a plain member, a signed-out caller, and a failed membership lookup", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: "u3" } } });
    m.memberships.mockResolvedValue([plainMembership]);
    for (const run of [
      () => sendHeldDraftAction({ draftId: "d1" }),
      () => editAndSendHeldDraftAction({ draftId: "d1", body: "x" }),
      () => takeOverHoldAction({ propertyId: "p1" }),
      () => assignHoldAction({ propertyId: "p1", assigneeId: "u9" }),
      () => dismissHoldAction({ propertyId: "p1", reason: "r" }),
      () => listHoldAssigneesAction({ propertyId: "p1" }),
    ]) {
      expect(await run()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    }
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect(await sendHeldDraftAction({ draftId: "d1" })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    m.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    m.memberships.mockRejectedValue(new Error("db"));
    expect(await sendHeldDraftAction({ draftId: "d1" })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    for (const fn of [m.sendHeldDraft, m.editAndSendHeldDraft, m.takeOverHold, m.dismissHold, m.assignHold]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("do not revalidate when the action failed", async () => {
    m.dismissHold.mockResolvedValue({ ok: false, error: { code: "REASON_REQUIRED", message: "x" } });
    expect(await dismissHoldAction({ propertyId: "p1", reason: "" })).toMatchObject({ ok: false });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("list assignees only for an authorized caller", async () => {
    m.listPropertyOrgUsers.mockResolvedValue({ ok: true, data: [{ id: "u9" }] });
    expect(await listHoldAssigneesAction({ propertyId: "p1" })).toEqual({ ok: true, data: [{ id: "u9" }] });
  });
});
