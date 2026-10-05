import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLeadTaskAction, listPropertyOrgUsers, refreshMock } = vi.hoisted(
  () => ({
    createLeadTaskAction: vi.fn(),
    listPropertyOrgUsers: vi.fn(),
    refreshMock: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock,
  }),
}));

vi.mock("@/lib/errors/call-action", () => ({
  callAction: vi.fn(async (promise: Promise<unknown>) => promise),
}));

vi.mock("../actions", () => ({
  listPropertyOrgUsers,
}));

vi.mock("../lead-task-actions", () => ({
  createLeadTaskAction,
}));

import { LeadTaskWidget } from "./lead-task-widget";

describe("<LeadTaskWidget />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPropertyOrgUsers.mockResolvedValue({
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

  it("creates a phone appointment with due date and assignee", async () => {
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
    expect(screen.getByTestId("lead-task-due-at")).toHaveClass(
      "w-full",
      "min-w-0",
    );
    expect(screen.getByTestId("lead-task-assignee")).toHaveClass(
      "w-full",
      "min-w-0",
    );

    await user.type(screen.getByTestId("lead-task-due-at"), "2026-06-20T09:30");
    await user.selectOptions(
      screen.getByTestId("lead-task-assignee"),
      "user-2",
    );
    await user.click(screen.getByTestId("lead-task-submit"));

    expect(createLeadTaskAction).toHaveBeenCalledWith("prop-1", {
      kind: "appointment",
      mode: "phone",
      dueAt: new Date("2026-06-20T09:30").toISOString(),
      assigneeId: "user-2",
    });
    expect(refreshMock).toHaveBeenCalled();
    // A phone appointment has no duration or location to fill in.
    expect(screen.queryByTestId("lead-task-duration")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lead-task-location")).not.toBeInTheDocument();
  });

  it("reveals duration and location for an in-person appointment and sends them", async () => {
    const user = userEvent.setup();
    render(
      <LeadTaskWidget
        propertyId="prop-1"
        address="123 Main"
        currentUserId="user-1"
        initialAssigneeId="user-1"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("lead-task-assignee")).not.toBeDisabled());
    await user.click(screen.getByTestId("lead-task-mode-in_person"));
    await user.selectOptions(screen.getByTestId("lead-task-duration"), "60");
    await user.type(screen.getByTestId("lead-task-location"), " 12 Oak St ");
    await user.type(screen.getByTestId("lead-task-due-at"), "2026-06-20T10:00");
    await user.click(screen.getByTestId("lead-task-submit"));
    expect(createLeadTaskAction).toHaveBeenCalledWith("prop-1", {
      kind: "appointment",
      mode: "in_person",
      durationMinutes: 60,
      location: "12 Oak St",
      dueAt: new Date("2026-06-20T10:00").toISOString(),
      assigneeId: "user-1",
    });
  });

  it("requires a title for a task and sends it", async () => {
    const user = userEvent.setup();
    render(
      <LeadTaskWidget
        propertyId="prop-1"
        address="123 Main"
        currentUserId="user-1"
        initialAssigneeId="user-1"
      />,
    );

    await waitFor(() => expect(screen.getByTestId("lead-task-assignee")).not.toBeDisabled());
    await user.click(screen.getByTestId("lead-task-type-task"));
    await user.type(screen.getByTestId("lead-task-due-at"), "2026-06-20T10:00");
    expect(screen.getByTestId("lead-task-submit")).toBeDisabled();
    await user.type(screen.getByTestId("lead-task-title"), "Pull the comps");
    await user.click(screen.getByTestId("lead-task-submit"));

    expect(createLeadTaskAction).toHaveBeenCalledWith("prop-1", {
      kind: "task",
      title: "Pull the comps",
      dueAt: new Date("2026-06-20T10:00").toISOString(),
      assigneeId: "user-1",
    });
  });

  it("does not preserve a former owner as the assignee for a new task", async () => {
    render(
      <LeadTaskWidget
        propertyId="prop-1"
        address="123 Main"
        currentUserId="user-1"
        initialAssigneeId="former-user"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("lead-task-assignee")).toHaveValue("user-1");
    });
    expect(
      screen.queryByRole("option", { name: /former/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps Create disabled until a valid active roster has loaded", async () => {
    let resolveRoster!: (value: unknown) => void;
    listPropertyOrgUsers.mockReturnValue(
      new Promise((resolve) => {
        resolveRoster = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <LeadTaskWidget
        propertyId="prop-1"
        address="123 Main"
        currentUserId="user-1"
        initialAssigneeId="user-1"
      />,
    );
    await user.type(screen.getByTestId("lead-task-due-at"), "2026-06-20T10:00");
    expect(screen.getByTestId("lead-task-submit")).toBeDisabled();
    resolveRoster({
      ok: true,
      data: [{ id: "user-1", email: "me@example.com", isActive: true }],
    });
    await waitFor(() =>
      expect(screen.getByTestId("lead-task-submit")).not.toBeDisabled(),
    );
  });
});
