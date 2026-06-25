import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssignDropdown } from "./assign-dropdown";
import { listOrgUsers, updateLeadAssignee } from "../leads/actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("../leads/actions", () => ({
  listOrgUsers: vi.fn(),
  updateLeadAssignee: vi.fn(),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-testid="dropdown-menu" onClick={() => onOpenChange?.(true)}>
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ render }: { render: React.ReactNode }) => render,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    ...props
  }: React.ComponentPropsWithoutRef<"div"> & { disabled?: boolean }) => (
    <div
      role="menuitem"
      aria-disabled={disabled}
      tabIndex={disabled ? undefined : 0}
      onClick={disabled ? undefined : onClick}
      {...props}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

describe("<AssignDropdown />", () => {
  beforeEach(() => {
    vi.mocked(listOrgUsers).mockReset();
    vi.mocked(updateLeadAssignee).mockReset();
  });

  it("opens the picker from an unassigned lead and assigns a teammate directly", async () => {
    const user = userEvent.setup();
    vi.mocked(listOrgUsers).mockResolvedValueOnce({
      ok: true,
      data: [
        { id: "user-1", email: "me@example.com" },
        { id: "user-2", email: "teammate@example.com" },
      ],
    });
    vi.mocked(updateLeadAssignee).mockResolvedValueOnce({
      ok: true,
      data: null,
    });

    render(
      <AssignDropdown
        propertyId="prop-1"
        initialAssigneeId={null}
        initialAssigneeEmail={null}
        currentUserId="user-1"
      />,
    );

    expect(screen.queryByTestId("assign-to-me")).not.toBeInTheDocument();
    const trigger = screen.getByTestId("assign-dropdown-trigger");
    expect(trigger).toHaveTextContent("Unassigned");

    await user.click(trigger);

    expect(await screen.findByTestId("assign-dropdown-me")).toHaveTextContent(
      "Me",
    );
    expect(
      await screen.findByTestId("assign-dropdown-user-user-2"),
    ).toHaveTextContent("teammate@example.com");
    expect(screen.getByTestId("assign-dropdown-unassign")).toHaveTextContent(
      "Unassign",
    );

    await user.click(screen.getByTestId("assign-dropdown-user-user-2"));

    expect(updateLeadAssignee).toHaveBeenCalledWith("prop-1", "user-2");
  });

  it("does not show Me when the current user is absent from the org member list", async () => {
    const user = userEvent.setup();
    vi.mocked(listOrgUsers).mockResolvedValueOnce({
      ok: true,
      data: [{ id: "user-2", email: "teammate@example.com" }],
    });

    render(
      <AssignDropdown
        propertyId="prop-1"
        initialAssigneeId={null}
        initialAssigneeEmail={null}
        currentUserId="user-1"
      />,
    );

    await user.click(screen.getByTestId("assign-dropdown-trigger"));

    expect(screen.queryByTestId("assign-dropdown-me")).not.toBeInTheDocument();
    expect(
      await screen.findByTestId("assign-dropdown-user-user-2"),
    ).toHaveTextContent("teammate@example.com");
  });

  it("shows a team-load error instead of an empty menu", async () => {
    const user = userEvent.setup();
    vi.mocked(listOrgUsers).mockResolvedValueOnce({
      ok: false,
      error: { code: "TEAM_FETCH_FAILED", message: "network failed" },
    });

    render(
      <AssignDropdown
        propertyId="prop-1"
        initialAssigneeId={null}
        initialAssigneeEmail={null}
        currentUserId="user-1"
      />,
    );

    await user.click(screen.getByTestId("assign-dropdown-trigger"));

    expect(
      await screen.findByText("Could not load team members."),
    ).toBeInTheDocument();
  });

  it("resets assignment state when the property changes", () => {
    const { rerender } = render(
      <AssignDropdown
        propertyId="prop-1"
        initialAssigneeId="user-1"
        initialAssigneeEmail="me@example.com"
        currentUserId="user-1"
      />,
    );

    expect(screen.getByTestId("assign-dropdown-trigger")).toHaveTextContent(
      "Assigned: me",
    );

    rerender(
      <AssignDropdown
        propertyId="prop-2"
        initialAssigneeId={null}
        initialAssigneeEmail={null}
        currentUserId="user-1"
      />,
    );

    expect(screen.getByTestId("assign-dropdown-trigger")).toHaveTextContent(
      "Unassigned",
    );
  });
});
