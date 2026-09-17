import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadInventory: vi.fn(),
  loadAssignments: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./sms-actions", () => ({
  loadRepSmsSenderInventory: mocks.loadInventory,
  loadRepSmsAssignments: mocks.loadAssignments,
  saveRepSmsSender: mocks.save,
}));

import { RepSmsSettings } from "./rep-sms-settings";

const eligible = {
  number: "+18164876883",
  ownerName: "Sendillo",
  ownerType: "sendillo",
  status: "active",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadInventory.mockResolvedValue({
    ok: true,
    data: {
      eligible: [eligible],
      ineligible: [
        {
          number: "+18162939379",
          reasons: [
            "missing_account_identity",
            "missing_number_identity",
            "number_status_missing",
            "messaging_status_missing",
          ],
        },
        {
          number: "+18163780213",
          reasons: ["number_status_not_active", "messaging_status_not_active"],
        },
      ],
    },
  });
  mocks.loadAssignments.mockResolvedValue({ ok: true, data: [] });
});

describe("RepSmsSettings sender diagnostics", () => {
  it("shows ineligible numbers and reasons while keeping eligible numbers assignable", async () => {
    render(
      <RepSmsSettings
        orgId="org-1"
        members={[
          { id: "rep-1", label: "Maria", active: true, acquisitionsEnabled: true, role: "member" },
        ] as never}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage texting numbers" }));

    await waitFor(() => expect(screen.getByText("Sendillo numbers unavailable for rep assignment")).toBeInTheDocument());
    expect(screen.getByText("+18162939379")).toBeInTheDocument();
    expect(screen.getByText("Missing stable Sendillo account identity.")).toBeInTheDocument();
    expect(screen.getByText("Missing stable Sendillo number identity.")).toBeInTheDocument();
    expect(screen.getByText("Sendillo number status is absent.")).toBeInTheDocument();
    expect(screen.getByText("Sendillo messaging status is absent.")).toBeInTheDocument();
    expect(screen.getByText("+18163780213")).toBeInTheDocument();
    expect(screen.getByText("Sendillo number status is not active.")).toBeInTheDocument();
    expect(screen.getByText("Sendillo messaging status is not active.")).toBeInTheDocument();

    const numberSelect = screen.getByLabelText("Number");
    expect(numberSelect).toHaveTextContent("Sendillo · +18164876883");
    expect(numberSelect).not.toHaveTextContent("+18162939379");
    expect(numberSelect).not.toHaveTextContent("+18163780213");
  });

  it("does not render provider IDs or raw payload fields from diagnostics", async () => {
    mocks.loadInventory.mockResolvedValue({
      ok: true,
      data: {
        eligible: [],
        ineligible: [{ number: "+18162939379", reasons: ["missing_account_identity"] }],
      },
    });

    render(<RepSmsSettings orgId="org-1" members={[] as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage texting numbers" }));

    await waitFor(() => expect(screen.getByText("+18162939379")).toBeInTheDocument());
    expect(screen.queryByText(/account-\d|number-\d|secret|raw/i)).not.toBeInTheDocument();
  });
});
