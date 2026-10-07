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

const SEEN_DRAFT = { body: "text", editedAt: null };
const SEEN_HOLD = { through: "2026-10-07T12:00:00.123456+00:00", flagReason: "draft_held", flagAt: "2026-10-07T11:59:00+00:00" };

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
    const result = await sendHeldDraftAction({ draftId: "d1", seen: SEEN_DRAFT });
    expect(result).toEqual({ ok: true, data: null });
    expect(m.sendHeldDraft).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", userId: "u1" }),
      { draftId: "d1", seen: SEEN_DRAFT },
    );
    expect(m.revalidatePath).toHaveBeenCalledWith("/messages-v2");
  });

  it("run for an acquisitions member", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: "u2" } } });
    m.memberships.mockResolvedValue([acqMembership]);
    expect(await takeOverHoldAction({ propertyId: "p1", seen: SEEN_HOLD })).toMatchObject({ ok: true });
    expect(m.takeOverHold).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }), { propertyId: "p1", seen: SEEN_HOLD });
  });

  it("refuse a plain member, a signed-out caller, and a failed membership lookup", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: "u3" } } });
    m.memberships.mockResolvedValue([plainMembership]);
    for (const run of [
      () => sendHeldDraftAction({ draftId: "d1", seen: SEEN_DRAFT }),
      () => editAndSendHeldDraftAction({ draftId: "d1", body: "x", seen: SEEN_DRAFT }),
      () => takeOverHoldAction({ propertyId: "p1", seen: SEEN_HOLD }),
      () => assignHoldAction({ propertyId: "p1", assigneeId: "u9" }),
      () => dismissHoldAction({ propertyId: "p1", reason: "r", seen: SEEN_HOLD }),
      () => listHoldAssigneesAction({ propertyId: "p1" }),
    ]) {
      expect(await run()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    }
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect(await sendHeldDraftAction({ draftId: "d1", seen: SEEN_DRAFT })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    m.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    m.memberships.mockRejectedValue(new Error("db"));
    expect(await sendHeldDraftAction({ draftId: "d1", seen: SEEN_DRAFT })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    for (const fn of [m.sendHeldDraft, m.editAndSendHeldDraft, m.takeOverHold, m.dismissHold, m.assignHold]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("do not revalidate when the action failed", async () => {
    m.dismissHold.mockResolvedValue({ ok: false, error: { code: "REASON_REQUIRED", message: "x" } });
    expect(await dismissHoldAction({ propertyId: "p1", reason: "", seen: SEEN_HOLD })).toMatchObject({ ok: false });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidate (so the card reloads) when the server found the card out of date", async () => {
    for (const code of ["DRAFT_CHANGED", "HOLD_STALE"]) {
      m.revalidatePath.mockClear();
      m.dismissHold.mockResolvedValue({ ok: false, error: { code, message: "x" } });
      expect(await dismissHoldAction({ propertyId: "p1", reason: "r", seen: SEEN_HOLD })).toMatchObject({ ok: false });
      expect(m.revalidatePath).toHaveBeenCalledWith("/messages-v2");
    }
  });

  it("pass the exact seen state through to the action, normalising missing fields to null", async () => {
    await dismissHoldAction({ propertyId: "p1", reason: "r", seen: undefined as never });
    expect(m.dismissHold).toHaveBeenCalledWith(expect.anything(), {
      propertyId: "p1",
      reason: "r",
      seen: { through: null, flagReason: null, flagAt: null },
    });
    await takeOverHoldAction({ propertyId: "p1", seen: SEEN_HOLD });
    expect(m.takeOverHold).toHaveBeenCalledWith(expect.anything(), { propertyId: "p1", seen: SEEN_HOLD });
  });

  it("list assignees only for an authorized caller", async () => {
    m.listPropertyOrgUsers.mockResolvedValue({ ok: true, data: [{ id: "u9" }] });
    expect(await listHoldAssigneesAction({ propertyId: "p1" })).toEqual({ ok: true, data: [{ id: "u9" }] });
  });
});
