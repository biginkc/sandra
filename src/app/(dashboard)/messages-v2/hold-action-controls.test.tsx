import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HoldsRail } from "./holds-rail";
import type { HoldActionsApi } from "./hold-action-types";
import type { OpenHold, RunWithSteps } from "./types";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const SEEN_HOLD = { through: "2026-10-08T11:55:00.123456+00:00", flagReason: "draft_held", flagAt: "2026-10-08T11:55:00+00:00" };

function hold(over: Partial<OpenHold<RunWithSteps>> = {}): OpenHold<RunWithSteps> {
  return {
    id: "p1",
    property_id: "p1",
    conversation_id: "c1",
    sources: ["needs_attention", "pending_draft"],
    since: iso(5),
    reason: "Needs attention",
    draft_held: true,
    draft: { id: "d1", inbound_message_id: "m1", body: "Draft text for the seller", edited_at: null },
    seen: SEEN_HOLD,
    run: null,
    ...over,
  };
}

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message: string, details?: Record<string, unknown>) => ({
  ok: false as const,
  error: { code, message, ...(details ? { details } : {}) },
});

function api(over: Partial<HoldActionsApi> = {}): HoldActionsApi {
  return {
    send: vi.fn().mockResolvedValue(ok({ messageId: "out-1" })),
    editAndSend: vi.fn().mockResolvedValue(ok({ messageId: "out-1" })),
    takeOver: vi.fn().mockResolvedValue(ok({ leadHref: "/leads/p1" })),
    assign: vi.fn().mockResolvedValue(ok(null)),
    dismiss: vi.fn().mockResolvedValue(ok(null)),
    listAssignees: vi.fn().mockResolvedValue(
      ok([
        { id: "u1", email: "ana@example.com", displayName: "Ana", isActive: true },
        { id: "u2", email: "bo@example.com", displayName: "Bo", isActive: true },
      ]),
    ),
    ...over,
  };
}

const renderRail = (h = hold(), actions = api(), onReload?: () => void) => {
  render(<HoldsRail holds={[h]} labels={new Map()} nowMs={NOW} actions={actions} onReload={onReload} />);
  return actions;
};
const button = (name: RegExp | string) => screen.getByRole("button", { name });

describe("hold action controls", () => {
  it("shows the pending draft and enables all five actions", () => {
    renderRail();
    expect(screen.getByTestId("draft-text")).toHaveTextContent("Draft text for the seller");
    for (const name of ["Send", "Edit", "Take over", "Assign", "Dismiss"]) {
      expect(button(new RegExp(`^${name}`))).toBeEnabled();
    }
  });

  it("shows an edited draft's edited text, not the original", () => {
    renderRail(hold({ draft: { id: "d1", inbound_message_id: "m1", body: "orig", edited_body: "edited text", edited_at: "2026-10-08T11:58:00+00:00" } }));
    expect(screen.getByTestId("draft-text")).toHaveTextContent("edited text");
  });

  it("disables Send and Edit when the hold has no reply draft; the rest still work", () => {
    renderRail(hold({ draft: undefined, draft_held: false, sources: ["needs_attention"] }));
    expect(button(/^Send/)).toBeDisabled();
    expect(button(/^Edit/)).toBeDisabled();
    expect(button(/^Take over/)).toBeEnabled();
    expect(button(/^Assign/)).toBeEnabled();
    expect(button(/^Dismiss/)).toBeEnabled();
  });

  it("offers no actions on an informational (already delivered) hold", () => {
    renderRail(hold({ flag_reason: "send_timeout_then_sent", sources: ["needs_attention"], draft: undefined, draft_held: false }));
    expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();
  });

  describe("Send", () => {
    it("flips to a sending state at once, then to sent", async () => {
      let release!: (v: unknown) => void;
      const send = vi.fn().mockReturnValue(new Promise((r) => (release = r)));
      renderRail(hold(), api({ send }));
      await userEvent.click(button(/^Send/));
      expect(send).toHaveBeenCalledWith({ draftId: "d1", seen: { body: "Draft text for the seller", editedAt: null } });
      expect(screen.getByTestId("hold-status")).toHaveTextContent(/sending/i);
      expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();
      release(ok({ messageId: "out-1" }));
      await waitFor(() => expect(screen.getByTestId("hold-status")).toHaveTextContent(/sent/i));
    });

    it("rolls back and says why when the send is refused", async () => {
      const send = vi.fn().mockResolvedValue(
        fail("SEND_REFUSED", "Not sent: superseded before send. The draft is still on the rail.", {
          reason: "superseded_before_send",
          retryable: false,
        }),
      );
      renderRail(hold(), api({ send }));
      await userEvent.click(button(/^Send/));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/superseded before send/);
      expect(button(/^Send/)).toBeEnabled();
      expect(screen.queryByTestId("hold-status")).toBeNull();
    });

    it("rolls back on a thrown error too", async () => {
      renderRail(hold(), api({ send: vi.fn().mockRejectedValue(new Error("network")) }));
      await userEvent.click(button(/^Send/));
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not confirm/i);
      expect(button(/^Send/)).toBeEnabled();
    });
  });

  describe("review round 1", () => {
    it("Send passes the edited text and its edit version when the card shows an edit", async () => {
      const actions = renderRail(
        hold({ draft: { id: "d1", inbound_message_id: "m1", body: "orig", edited_body: "edited text", edited_at: "2026-10-08T11:58:00+00:00" } }),
      );
      await userEvent.click(button(/^Send/));
      expect(actions.send).toHaveBeenCalledWith({
        draftId: "d1",
        seen: { body: "edited text", editedAt: "2026-10-08T11:58:00+00:00" },
      });
    });

    it("a draft that changed under the clicker shows the message and reloads the card", async () => {
      const onReload = vi.fn();
      const send = vi.fn().mockResolvedValue(fail("DRAFT_CHANGED", "This draft changed after you opened it, so nothing was sent."));
      renderRail(hold(), api({ send }), onReload);
      await userEvent.click(button(/^Send/));
      expect(await screen.findByRole("alert")).toHaveTextContent(/draft changed/i);
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("Dismiss from a stale view shows 'This thread changed — reload' and reloads", async () => {
      const onReload = vi.fn();
      const dismiss = vi.fn().mockResolvedValue(fail("HOLD_STALE", "This thread changed — reload"));
      renderRail(hold(), api({ dismiss }), onReload);
      await userEvent.click(button(/^Dismiss/));
      await userEvent.type(screen.getByRole("textbox", { name: /reason/i }), "done");
      await userEvent.click(button(/confirm dismiss/i));
      expect(await screen.findByRole("alert")).toHaveTextContent("This thread changed — reload");
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("after a send timeout the text may have gone out: Send and Edit stay off, other actions still work", async () => {
      const message = "Send timed out at the provider — the text may have gone out; do not re-send until the thread updates.";
      renderRail(hold(), api({ send: vi.fn().mockResolvedValue(fail("SEND_TIMEOUT", message)) }));
      await userEvent.click(button(/^Send/));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(button(/^Send/)).toBeDisabled();
      expect(button(/^Edit/)).toBeDisabled();
      expect(button(/^Take over/)).toBeEnabled();
    });
  });

  describe("Edit", () => {
    it("edits the text, then sends the edit", async () => {
      const actions = renderRail();
      await userEvent.click(button(/^Edit/));
      const box = screen.getByRole("textbox", { name: /edit reply/i });
      expect(box).toHaveValue("Draft text for the seller");
      await userEvent.clear(box);
      await userEvent.type(box, "A shorter reply");
      await userEvent.click(button(/send edit/i));
      expect(actions.editAndSend).toHaveBeenCalledWith({
        draftId: "d1",
        body: "A shorter reply",
        seen: { body: "Draft text for the seller", editedAt: null },
      });
      await waitFor(() => expect(screen.getByTestId("hold-status")).toHaveTextContent(/sent/i));
    });

    it("will not send an empty edit and can be cancelled", async () => {
      const actions = renderRail();
      await userEvent.click(button(/^Edit/));
      await userEvent.clear(screen.getByRole("textbox", { name: /edit reply/i }));
      expect(button(/send edit/i)).toBeDisabled();
      await userEvent.click(button(/cancel/i));
      expect(screen.queryByRole("textbox", { name: /edit reply/i })).toBeNull();
      expect(actions.editAndSend).not.toHaveBeenCalled();
    });

    it("keeps the edit open with the error when the send is refused", async () => {
      const editAndSend = vi.fn().mockResolvedValue(fail("SEND_REFUSED", "Not sent: already answered."));
      renderRail(hold(), api({ editAndSend }));
      await userEvent.click(button(/^Edit/));
      await userEvent.click(button(/send edit/i));
      expect(await screen.findByRole("alert")).toHaveTextContent(/already answered/);
      expect(screen.getByRole("textbox", { name: /edit reply/i })).toBeInTheDocument();
    });
  });

  describe("Take over", () => {
    it("marks the lead human-owned and offers the lead link", async () => {
      const actions = renderRail();
      await userEvent.click(button(/^Take over/));
      expect(actions.takeOver).toHaveBeenCalledWith({ propertyId: "p1", seen: SEEN_HOLD });
      const link = await screen.findByRole("link", { name: /open lead/i });
      expect(link).toHaveAttribute("href", "/leads/p1");
      expect(screen.getByTestId("hold-status")).toHaveTextContent(/taken over/i);
    });

    it("rolls back on failure", async () => {
      renderRail(hold(), api({ takeOver: vi.fn().mockResolvedValue(fail("HOLD_RESOLVE_FAILED", "Could not update that hold.")) }));
      await userEvent.click(button(/^Take over/));
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not update/i);
      expect(button(/^Take over/)).toBeEnabled();
    });
  });

  describe("Dismiss", () => {
    it("needs a reason, warns that automation is re-armed, then dismisses", async () => {
      const actions = renderRail();
      await userEvent.click(button(/^Dismiss/));
      expect(screen.getByTestId("dismiss-warning")).toHaveTextContent(/won't pick this thread up again until you dismiss/i);
      const confirm = button(/confirm dismiss/i);
      expect(confirm).toBeDisabled();
      await userEvent.type(screen.getByRole("textbox", { name: /reason/i }), "handled by phone");
      await userEvent.click(confirm);
      expect(actions.dismiss).toHaveBeenCalledWith({ propertyId: "p1", reason: "handled by phone", seen: SEEN_HOLD });
      await waitFor(() => expect(screen.getByTestId("hold-status")).toHaveTextContent(/dismissed/i));
    });

    it("rolls back and keeps the reason on failure", async () => {
      renderRail(hold(), api({ dismiss: vi.fn().mockResolvedValue(fail("HOLD_RESOLVE_FAILED", "Could not update that hold.")) }));
      await userEvent.click(button(/^Dismiss/));
      await userEvent.type(screen.getByRole("textbox", { name: /reason/i }), "done");
      await userEvent.click(button(/confirm dismiss/i));
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not update/i);
      expect(screen.getByRole("textbox", { name: /reason/i })).toHaveValue("done");
    });
  });

  describe("Assign", () => {
    it("lists teammates and assigns the chosen one optimistically", async () => {
      const actions = renderRail();
      await userEvent.click(button(/^Assign/));
      const select = await screen.findByRole("combobox", { name: /assign to/i });
      await within(select).findByRole("option", { name: /Ana/ });
      await userEvent.selectOptions(select, "u2");
      expect(actions.assign).toHaveBeenCalledWith({ propertyId: "p1", assigneeId: "u2" });
      await waitFor(() => expect(screen.getByTestId("hold-assignee")).toHaveTextContent(/Bo/));
    });

    it("reverts the assignee and shows the error when assignment fails", async () => {
      renderRail(hold(), api({ assign: vi.fn().mockResolvedValue(fail("INVALID_ASSIGNEE", "That teammate cannot be assigned.")) }));
      await userEvent.click(button(/^Assign/));
      await userEvent.selectOptions(await screen.findByRole("combobox", { name: /assign to/i }), "u1");
      expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be assigned/i);
      expect(screen.queryByTestId("hold-assignee")).toBeNull();
    });

    it("says so when the teammate list cannot be loaded", async () => {
      renderRail(hold(), api({ listAssignees: vi.fn().mockResolvedValue(fail("TEAM_SCOPE_INVALID", "x")) }));
      await userEvent.click(button(/^Assign/));
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
    });
  });
});

describe("suppression incomplete hold", () => {
  it("shows the warning and retries suppression", async () => {
    const retrySuppression = vi.fn().mockResolvedValue(ok({ cleared: true, remaining: 0 }));
    const onReload = vi.fn();
    renderRail(hold({ flag_reason: "suppression_incomplete:rev-1" }), api({ retrySuppression }), onReload);
    expect(screen.getByTestId("suppression-incomplete-warning")).toHaveTextContent(/Suppression is incomplete/);
    await userEvent.click(button("Retry suppression"));
    await waitFor(() => expect(retrySuppression).toHaveBeenCalledWith({ propertyId: "p1" }));
    expect(await screen.findByTestId("hold-status")).toHaveTextContent(/hold is cleared/);
    expect(onReload).toHaveBeenCalled();
  });

  it("shows nothing for other hold reasons", () => {
    renderRail(hold({ flag_reason: "draft_held" }), api({ retrySuppression: vi.fn() }));
    expect(screen.queryByTestId("suppression-incomplete-warning")).toBeNull();
  });
});
