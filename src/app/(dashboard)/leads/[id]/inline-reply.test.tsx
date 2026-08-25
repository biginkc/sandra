import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerRefreshMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefreshMock }),
}));
vi.mock("../actions", () => ({
  loadLeadVars: vi.fn(),
  sendSmsFromLead: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import { sendSmsFromLead } from "../actions";
import { InlineReply } from "./inline-reply";

describe("<InlineReply /> disabled explanations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stacks the send control at narrow widths instead of forcing overflow", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
      />,
    );

    expect(screen.getByTestId("inline-reply-send")).toHaveClass(
      "w-full",
      "sm:w-auto",
    );
  });

  it("renders an adjacent compact action with the send-safety explanation", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
        footerAction={<button type="button">Add note</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Add note" })).toBeVisible();
    expect(
      screen.getByText(/Sends immediately after Sandra checks/i),
    ).toBeVisible();
  });

  it("explains that a missing contact prevents a reply", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId={null}
        homeownerPhone={null}
      />,
    );

    expect(screen.getByText(/No homeowner contact/i)).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the supplied phone restriction instead of a misleading generic error", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone={null}
        phoneUnavailableMessage="The saved number is a landline, so SMS is unavailable."
      />,
    );

    expect(screen.getByText(/saved number is a landline/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /send reply/i })).toBeNull();
  });

  it("sends immediately through the protected server path", async () => {
    const user = userEvent.setup();
    vi.mocked(sendSmsFromLead).mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: {
          status: "sent",
          messageId: "message-1",
          externalId: "provider-1",
        },
      },
    } as Awaited<ReturnType<typeof sendSmsFromLead>>);

    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
      />,
    );

    const composer = screen.getByLabelText("Reply to this lead");
    await user.type(composer, "Send this now");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => {
      expect(sendSmsFromLead).toHaveBeenCalledWith(
        "property-1",
        "Send this now",
        null,
        false,
        "+18165550123",
      );
    });
    expect(composer).toHaveValue("");
    expect(toast.success).toHaveBeenCalledWith("Message sent", {
      description: "Sent to +18165550123.",
    });
    expect(routerRefreshMock).toHaveBeenCalledOnce();
  });

  it("preserves the exact draft when the provider rejects the send", async () => {
    const user = userEvent.setup();
    vi.mocked(sendSmsFromLead).mockResolvedValueOnce({
      ok: true,
      data: {
        outcome: {
          status: "provider_failed",
          error: "Provider rejected the message.",
        },
      },
    } as Awaited<ReturnType<typeof sendSmsFromLead>>);

    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
      />,
    );

    const composer = screen.getByLabelText("Reply to this lead");
    await user.type(composer, "Keep this exact draft");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => expect(sendSmsFromLead).toHaveBeenCalledOnce());
    expect(composer).toHaveValue("Keep this exact draft");
    expect(toast.error).toHaveBeenCalledWith("Provider error", {
      description: "Provider rejected the message.",
    });
    expect(routerRefreshMock).not.toHaveBeenCalled();
  });
});
