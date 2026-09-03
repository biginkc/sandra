import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  InvitePanel,
  MembershipAccessBadge,
  MembershipRoleControl,
  RoleEditor,
} from "./invite-panel";
import type { SandraMembershipInventory } from "./membership-inventory";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateMembershipRole: vi.fn(),
  callAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("./actions", () => ({
  updateMembershipRole: mocks.updateMembershipRole,
}));

vi.mock("@/lib/errors/call-action", () => ({
  callAction: mocks.callAction,
}));

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.updateMembershipRole.mockReset();
  mocks.callAction.mockReset();
  mocks.updateMembershipRole.mockResolvedValue({
    ok: true,
    data: { userId: "member-user", role: "owner" },
  });
  mocks.callAction.mockImplementation(async (actionPromise) => actionPromise);
});

describe("<InvitePanel />", () => {
  it("links account and access management to the configured Hugo URL", () => {
    render(<InvitePanel hugoUrl="https://identity.example.test/team" />);

    expect(screen.getByRole("link", { name: /open hugo/i })).toHaveAttribute(
      "href",
      "https://identity.example.test/team",
    );
    expect(screen.getByText(/Hugo creates accounts/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /grant access/i }),
    ).not.toBeInTheDocument();
  });

  it("fails visibly when the Hugo URL is not configured", () => {
    render(<InvitePanel hugoUrl={null} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Set NEXT_PUBLIC_HUGO_URL",
    );
    expect(
      screen.queryByRole("link", { name: /open hugo/i }),
    ).not.toBeInTheDocument();
  });
});

describe("<RoleEditor />", () => {
  it("changes only the role for an existing member and refreshes the team view", async () => {
    const user = userEvent.setup();
    render(
      <RoleEditor
        userId="member-user"
        email="member@example.test"
        role="member"
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Sandra role for member@example.test",
      }),
      "owner",
    );

    expect(mocks.updateMembershipRole).toHaveBeenCalledWith(
      "member-user",
      "owner",
    );
    await waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledOnce();
    });
  });

  it("does nothing when the selected role is unchanged", async () => {
    const user = userEvent.setup();
    render(
      <RoleEditor
        userId="member-user"
        email="member@example.test"
        role="member"
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", {
        name: "Sandra role for member@example.test",
      }),
      "member",
    );

    expect(mocks.updateMembershipRole).not.toHaveBeenCalled();
    expect(mocks.callAction).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("Hugo-managed lifecycle state", () => {
  const baseMembership: SandraMembershipInventory = {
    role: "member",
    accessStatus: "active",
    accessExpiresAt: null,
    deletionPreparedAt: null,
    hasActiveAccess: true,
  };

  it.each([
    {
      label: "suspended",
      membership: {
        ...baseMembership,
        accessStatus: "suspended",
        hasActiveAccess: false,
      },
    },
    {
      label: "revoked",
      membership: {
        ...baseMembership,
        accessStatus: "revoked",
        hasActiveAccess: false,
      },
    },
    {
      label: "expired",
      membership: {
        ...baseMembership,
        accessExpiresAt: "2026-07-28T12:00:00.000Z",
        hasActiveAccess: false,
      },
    },
    {
      label: "deletion prepared",
      membership: {
        ...baseMembership,
        deletionPreparedAt: "2026-07-29T12:00:00.000Z",
        hasActiveAccess: false,
      },
    },
  ])(
    "shows $label access read-only and withholds role editing",
    ({ label, membership }) => {
      render(
        <>
          <MembershipRoleControl
            userId="managed-by-hugo"
            email="member@example.test"
            membership={membership}
          />
          <MembershipAccessBadge membership={membership} />
        </>,
      );

      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("Member")).toBeInTheDocument();
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    },
  );

  it("keeps role editing available for an active existing member", () => {
    render(
      <MembershipRoleControl
        userId="active-member"
        email="active@example.test"
        membership={baseMembership}
      />,
    );

    expect(
      screen.getByRole("combobox", {
        name: "Sandra role for active@example.test",
      }),
    ).toBeEnabled();
  });
});
