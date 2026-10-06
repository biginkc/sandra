import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openLead: vi.fn(),
  dialLeadAction: vi.fn(),
  getStatus: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./softphone-provider", () => ({
  useOptionalSoftphone: () => ({ openLead: mocks.openLead, callingEnabled: true }),
}));
vi.mock("@/app/(dashboard)/my-leads/dialpad-actions", () => ({
  dialLeadAction: mocks.dialLeadAction,
  getDialpadCallStatusAction: mocks.getStatus,
}));

import { DialpadCallProvider } from "@/components/dialpad/dialpad-call-provider";
import { SoftphoneLeadButton } from "./softphone-lead-button";

const lead = {
  id: "11111111-1111-4111-8111-111111111111",
  contactId: "22222222-2222-4222-8222-222222222222",
  firstName: "Seller",
  name: "Seller One",
  address: "1 Main St",
  state: "MO",
  phones: ["+18165550123"],
  dncLocked: false,
  contactDnc: false,
  callable: true,
};

function renderButton(enabled: boolean, leadOverride = lead) {
  return render(
    <DialpadCallProvider enabled={enabled}>
      <SoftphoneLeadButton lead={leadOverride} />
    </DialpadCallProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStatus.mockResolvedValue({ ok: false, code: "denied", message: "x" });
});

describe("SoftphoneLeadButton Dialpad routing", () => {
  it("uses the softphone and never Dialpad when the server route is off", async () => {
    const user = userEvent.setup();
    renderButton(false);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(mocks.openLead).toHaveBeenCalledWith(lead);
    expect(mocks.dialLeadAction).not.toHaveBeenCalled();
  });

  it("route off shows only the existing Call", () => {
    renderButton(false);
    expect(screen.getByTestId("call-lead-button")).toBeInTheDocument();
    expect(screen.queryByText("Call with coach")).not.toBeInTheDocument();
  });

  it("route on shows both; Call goes to Dialpad, Call with coach opens the softphone", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    renderButton(true);
    expect(screen.getByTestId("call-lead-button")).toBeInTheDocument();
    await user.click(screen.getByText("Call with coach"));
    expect(mocks.openLead).toHaveBeenCalledWith(lead);
    expect(mocks.dialLeadAction).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1));
    expect(mocks.openLead).toHaveBeenCalledTimes(1);
  });

  it("uses the softphone when there is no provider at all", async () => {
    const user = userEvent.setup();
    render(<SoftphoneLeadButton lead={lead} />);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(mocks.openLead).toHaveBeenCalledWith(lead);
  });

  it("places the call through Dialpad with the property and contact ids when the route is on", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1));
    expect(mocks.dialLeadAction).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: lead.id, contactId: lead.contactId, idempotencyKey: expect.any(String) }),
    );
    expect(mocks.openLead).not.toHaveBeenCalled();
    expect(await screen.findByTestId("dialpad-call-status")).toBeInTheDocument();
  });

  it("keeps the softphone path for a lead with no contact even when the route is on", async () => {
    const user = userEvent.setup();
    renderButton(true, { ...lead, contactId: null } as unknown as typeof lead);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(mocks.openLead).toHaveBeenCalled();
    expect(mocks.dialLeadAction).not.toHaveBeenCalled();
  });

  it("falls back to the softphone when the server answers not_configured", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: false, code: "not_configured", message: "off" });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(mocks.openLead).toHaveBeenCalledWith(lead));
    expect(screen.queryByTestId("dial-status")).not.toBeInTheDocument();
  });

  it("shows the quiet-hours denial without opening the softphone", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: false, code: "denied", denial: "outside_calling_hours", message: "Calling is unavailable during quiet hours." });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(await screen.findByText(/quiet hours/)).toBeInTheDocument();
    expect(mocks.openLead).not.toHaveBeenCalled();
  });

  it("shows a denial and offers a confirmed redial for an unresolved prior call", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "denied", message: "Your Dialpad account is not verified." });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(await screen.findByText(/not verified/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "prior_call_unresolved", message: "An earlier call may have rung.", priorIntentId: "33333333-3333-4333-8333-333333333333" });
    await user.click(screen.getByTestId("call-lead-button"));
    await user.click(await screen.findByRole("button", { name: "Call again anyway" }));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenLastCalledWith(expect.objectContaining({ confirmRedialOf: "33333333-3333-4333-8333-333333333333" })));
  });
});
