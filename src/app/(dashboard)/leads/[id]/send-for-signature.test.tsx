import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ESIGN_MERGE_FIELD_NAMES,
  type TemplateOption,
} from "@/lib/esign/contracts";

import type {
  LeadEsignPreflight,
  LoadLeadEsignPreflightAction,
  SendBlockerCode,
  SendContractAction,
} from "./esign-types";
import { SendForSignature } from "./send-for-signature";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const template: TemplateOption = {
  id: "template-local-1",
  name: "Purchase agreement",
  documentType: "purchase_agreement",
  providerTemplateId: "provider-template-1",
  sellerRoleName: "Seller",
  signerRoles: [
    { name: "Seller", order: 0 },
    { name: "Buyer", order: 1 },
  ],
  mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
};

const preflight: LeadEsignPreflight = {
  propertyId: "property-1",
  testMode: true,
  blockers: [],
  templates: [template],
  sellerDefaults: {
    name: "Seller Owner",
    emailAddress: "seller@example.com",
  },
  mergeDefaults: {
    seller_name: "Seller Owner",
    property_address: "123 Main St",
    offer_price: "$125,000",
    closing_date: "2026-09-30",
    earnest_money: "$1,000",
  },
};

function actions(preflightValue: LeadEsignPreflight = preflight) {
  const preflightAction = vi
    .fn<LoadLeadEsignPreflightAction>()
    .mockResolvedValue({
      ok: true,
      data: preflightValue,
    });
  const sendAction = vi.fn<SendContractAction>().mockResolvedValue({
    ok: true,
    data: { requestId: "request-1" },
  });
  return { preflightAction, sendAction };
}

describe("SendForSignature", () => {
  it.each<{
    blockers: readonly SendBlockerCode[];
    message: string;
  }>([
    {
      blockers: ["owner_email_missing"],
      message: "Send disabled: save a seller email on the lead before sending.",
    },
    {
      blockers: ["no_templates"],
      message: "Send disabled: no eSign templates are available.",
    },
    {
      blockers: ["sending_disabled"],
      message: "Send disabled: sending from leads is turned off.",
    },
    {
      blockers: ["provider_disconnected"],
      message: "Send disabled: Dropbox Sign is not connected.",
    },
    {
      blockers: ["owner_email_missing", "provider_disconnected"],
      message: "Send disabled: Dropbox Sign is not connected.",
    },
  ])(
    "renders the exact primary disabled reason: $message",
    async ({ blockers, message }) => {
      const { preflightAction, sendAction } = actions();

      render(
        <SendForSignature
          propertyId="property-1"
          initialBlockers={blockers}
          preflightAction={preflightAction}
          sendAction={sendAction}
        />,
      );

      expect(screen.getByTestId("send-for-signature-trigger")).toBeDisabled();
      expect(
        screen.getByTestId("send-for-signature-disabled-reason"),
      ).toHaveTextContent(message);
      expect(preflightAction).not.toHaveBeenCalled();
    },
  );

  it("explains a missing seller email from the loaded recipient snapshot without sending", async () => {
    const user = userEvent.setup();
    const { preflightAction, sendAction } = actions({
      ...preflight,
      blockers: [],
      templates: [
        { ...template, signerRoles: [{ name: "Seller", order: 0 }] },
      ],
      sellerDefaults: { ...preflight.sellerDefaults, emailAddress: "" },
    });

    render(
      <SendForSignature
        propertyId="property-1"
        initialBlockers={[]}
        preflightAction={preflightAction}
        sendAction={sendAction}
      />,
    );

    await user.click(screen.getByTestId("send-for-signature-trigger"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Send disabled: save a seller email on the lead before sending.",
    );
    await user.type(
      within(screen.getByTestId("esign-signer-0")).getByLabelText("Email"),
      "seller@example.com",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Send disabled: save a seller email on the lead before sending.",
    );
    await user.click(screen.getByRole("checkbox"));
    const submit = screen.getByTestId("send-for-signature-submit");
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("prefills the seller, requires every provider role, and sends the edited five-field snapshot", async () => {
    const user = userEvent.setup();
    const { preflightAction, sendAction } = actions();
    const onFinished = vi.fn();

    render(
      <SendForSignature
        propertyId="property-1"
        initialBlockers={[]}
        preflightAction={preflightAction}
        sendAction={sendAction}
        onFinished={onFinished}
      />,
    );

    await user.click(screen.getByTestId("send-for-signature-trigger"));
    expect(
      await screen.findByTestId("esign-test-mode-notice"),
    ).toHaveTextContent(
      "Dropbox Sign is in test mode. This document is watermarked and not legally binding.",
    );
    expect(screen.queryByText(/add signer/i)).not.toBeInTheDocument();

    const seller = screen.getByTestId("esign-signer-0");
    const buyer = screen.getByTestId("esign-signer-1");
    expect(
      within(seller).getByDisplayValue("Seller Owner"),
    ).toBeInTheDocument();
    expect(
      within(seller).getByDisplayValue("seller@example.com"),
    ).toBeInTheDocument();
    expect(within(buyer).getByText("2. Buyer")).toBeInTheDocument();

    await user.type(within(buyer).getByLabelText("Name"), "Buyer One");
    await user.type(within(buyer).getByLabelText("Email"), "buyer@example.com");
    const offer = screen.getByLabelText("Offer price");
    await user.clear(offer);
    await user.type(offer, "$130,000");
    await user.click(
      screen.getByRole("checkbox", {
        name: "I reviewed the recipients and contract details.",
      }),
    );

    const submit = screen.getByTestId("send-for-signature-submit");
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(sendAction).toHaveBeenCalledTimes(1));
    const sent = sendAction.mock.calls[0][0];
    expect(sent).toEqual({
      propertyId: "property-1",
      templateId: "template-local-1",
      sendIntentId: expect.any(String),
      signers: [
        {
          role: "Seller",
          order: 0,
          name: "Seller Owner",
          emailAddress: "seller@example.com",
        },
        {
          role: "Buyer",
          order: 1,
          name: "Buyer One",
          emailAddress: "buyer@example.com",
        },
      ],
      mergeValues: {
        ...preflight.mergeDefaults,
        offer_price: "$130,000",
      },
    });
    expect(new Set(Object.keys(sent.mergeValues))).toEqual(
      new Set(ESIGN_MERGE_FIELD_NAMES),
    );
    expect(onFinished).toHaveBeenCalledWith("request-1");
  });

  it("keeps the dialog open and preserves the send intent after an action failure", async () => {
    const user = userEvent.setup();
    const { preflightAction, sendAction } = actions({
      ...preflight,
      templates: [{ ...template, signerRoles: [{ name: "Seller", order: 0 }] }],
    });
    sendAction.mockResolvedValue({
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: "Dropbox Sign did not respond.",
      },
    });

    render(
      <SendForSignature
        propertyId="property-1"
        initialBlockers={[]}
        preflightAction={preflightAction}
        sendAction={sendAction}
      />,
    );
    await user.click(screen.getByTestId("send-for-signature-trigger"));
    await screen.findByDisplayValue("seller@example.com");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByTestId("send-for-signature-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Dropbox Sign did not respond.",
    );
    const firstIntent = sendAction.mock.calls[0][0].sendIntentId;
    await user.click(screen.getByTestId("send-for-signature-submit"));
    await waitFor(() => expect(sendAction).toHaveBeenCalledTimes(2));
    expect(sendAction.mock.calls[1][0].sendIntentId).toBe(firstIntent);
  });

  it.each([
    ["Seller name", "Changed Seller"],
    ["Property address", "456 Oak St"],
    ["Offer price", "$140,000"],
    ["Closing date", "2026-10-15"],
    ["Earnest money", "$2,000"],
  ] as const)(
    "clears review confirmation after editing %s",
    async (label, value) => {
      const user = userEvent.setup();
      const { preflightAction, sendAction } = actions({
        ...preflight,
        templates: [
          { ...template, signerRoles: [{ name: "Seller", order: 0 }] },
        ],
      });
      render(
        <SendForSignature
          propertyId="property-1"
          initialBlockers={[]}
          preflightAction={preflightAction}
          sendAction={sendAction}
        />,
      );
      await user.click(screen.getByTestId("send-for-signature-trigger"));
      await screen.findByDisplayValue("seller@example.com");
      const confirmation = screen.getByRole("checkbox");
      await user.click(confirmation);
      expect(confirmation).toBeChecked();

      const field = screen.getByLabelText(label);
      await user.clear(field);
      await user.type(field, value);

      expect(confirmation).not.toBeChecked();
      expect(screen.getByTestId("send-for-signature-submit")).toBeDisabled();
    },
  );

  it.each([
    "seller@@example.com",
    "seller name@example.com",
    "seller@exa mple.com",
  ])("rejects malformed email %j with an accessible error", async (email) => {
    const user = userEvent.setup();
    const { preflightAction, sendAction } = actions({
      ...preflight,
      templates: [{ ...template, signerRoles: [{ name: "Seller", order: 0 }] }],
    });
    render(
      <SendForSignature
        propertyId="property-1"
        initialBlockers={[]}
        preflightAction={preflightAction}
        sendAction={sendAction}
      />,
    );
    await user.click(screen.getByTestId("send-for-signature-trigger"));
    const input = await screen.findByLabelText("Email");
    await user.clear(input);
    await user.type(input, email);
    await user.click(screen.getByRole("checkbox"));

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "Enter one email address without spaces.",
    );
    expect(screen.getByTestId("send-for-signature-submit")).toBeDisabled();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("blocks X, Escape, backdrop, and Cancel while sending but closes after success", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<SendContractAction>>>();
    const { preflightAction, sendAction } = actions({
      ...preflight,
      templates: [{ ...template, signerRoles: [{ name: "Seller", order: 0 }] }],
    });
    sendAction.mockReturnValue(pending.promise);
    render(
      <SendForSignature
        propertyId="property-1"
        initialBlockers={[]}
        preflightAction={preflightAction}
        sendAction={sendAction}
      />,
    );
    await user.click(screen.getByTestId("send-for-signature-trigger"));
    await screen.findByDisplayValue("seller@example.com");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByTestId("send-for-signature-submit"));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Sending contract for signature…",
    );
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    expect(
      screen.getByRole("heading", { name: "Send for signature" }),
    ).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ ok: true, data: { requestId: "request-1" } });
      await pending.promise;
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Send for signature" }),
      ).not.toBeInTheDocument(),
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
