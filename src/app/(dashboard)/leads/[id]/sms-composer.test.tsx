import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listFromNumbers: vi.fn(),
  sendSmsFromLead: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("../actions", () => ({
  listFromNumbers: mocks.listFromNumbers,
  sendSmsFromLead: mocks.sendSmsFromLead,
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from "sonner";
import { SmsComposer } from "./sms-composer";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listFromNumbers.mockResolvedValue({
    ok: true,
    data: [
      {
        number: "+18163706846",
        ownerName: "Mel",
        ownerType: "user",
        status: "user",
      },
    ],
  });
});

describe("SmsComposer provider outcomes", () => {
  it("sends once when keyboard and click activate the composer in the same tick", async () => {
    mocks.sendSmsFromLead.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: {
          status: "provider_unknown",
          messageId: "attempted-message",
          error: "The provider did not return a definitive receipt.",
        },
      },
    });
    const user = userEvent.setup();
    render(
      <SmsComposer
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
        homeownerName="Homeowner"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send SMS" }));
    const composer = await screen.findByLabelText("Message");
    await user.type(composer, "Do not duplicate this message");
    const sendButton = screen.getByRole("button", { name: "Send now" });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    fireEvent.click(sendButton);

    expect(mocks.sendSmsFromLead).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText(/pending reconciliation/i)).toBeVisible());
    expect(screen.getByLabelText("Message")).toHaveValue("Do not duplicate this message");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled(),
    );
  });

  it("preserves the draft and disables resend while provider reconciliation is pending", async () => {
    mocks.sendSmsFromLead.mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: {
          status: "provider_unknown",
          messageId: "attempted-message",
          error: "The provider did not return a definitive receipt.",
        },
      },
    });
    const user = userEvent.setup();
    render(
      <SmsComposer
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
        homeownerName="Homeowner"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send SMS" }));
    const composer = await screen.findByLabelText("Message");
    await user.type(composer, "Keep this exact draft");
    await user.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => expect(mocks.sendSmsFromLead).toHaveBeenCalledOnce());
    expect(composer).toHaveValue("Keep this exact draft");
    expect(composer).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
    expect(screen.getByText(/pending reconciliation/i)).toBeVisible();
    expect(toast.warning).toHaveBeenCalledWith("Send pending reconciliation", {
      description:
        "The messaging provider did not provide a definitive receipt. Your draft is preserved. Review the thread before retrying to avoid a duplicate message.",
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
