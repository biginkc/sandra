import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLeadTaskAction, listOrgUsers, refreshMock } = vi.hoisted(() => ({
  createLeadTaskAction: vi.fn(),
  listOrgUsers: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock,
  }),
}));

vi.mock("@/lib/errors/call-action", () => ({
  callAction: vi.fn(async (promise: Promise<unknown>) => promise),
}));

vi.mock("../actions", () => ({
  createLeadTaskAction,
  listOrgUsers,
}));

import { LeadTaskWidget } from "./lead-task-widget";

describe("<LeadTaskWidget />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOrgUsers.mockResolvedValue({
      ok: true,
      data: [
        { id: "user-1", email: "me@example.com" },
        { id: "user-2", email: "teammate@example.com" },
      ],
    });
    createLeadTaskAction.mockResolvedValue({
      ok: true,
      data: { id: "task-1" },
    });
  });

  it("creates a follow-up task with due date and assignee", async () => {
    const user = userEvent.setup();
    render(
      <LeadTaskWidget
        propertyId="prop-1"
        address="123 Main"
        currentUserId="user-1"
        initialAssigneeId={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("lead-task-assignee")).not.toBeDisabled();
    });

    await user.type(screen.getByTestId("lead-task-due-at"), "2026-06-20T09:30");
    await user.selectOptions(screen.getByTestId("lead-task-assignee"), "user-2");
    await user.click(screen.getByTestId("lead-task-submit"));

    expect(createLeadTaskAction).toHaveBeenCalledWith("prop-1", {
      type: "follow_up",
      dueAt: new Date("2026-06-20T09:30").toISOString(),
      assigneeId: "user-2",
    });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("creates callback tasks from the lead page", async () => {
    const user = userEvent.setup();
    render(
      <LeadTaskWidget
        propertyId="prop-1"
        address="123 Main"
        currentUserId="user-1"
        initialAssigneeId="user-1"
      />,
    );

    await user.click(screen.getByTestId("lead-task-type-callback"));
    await user.type(screen.getByTestId("lead-task-due-at"), "2026-06-20T10:00");
    await user.click(screen.getByTestId("lead-task-submit"));

    expect(createLeadTaskAction).toHaveBeenCalledWith("prop-1", {
      type: "callback",
      dueAt: new Date("2026-06-20T10:00").toISOString(),
      assigneeId: "user-1",
    });
  });
});
