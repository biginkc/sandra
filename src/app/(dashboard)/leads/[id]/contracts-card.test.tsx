import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { ContractActions } from "./contract-actions";
import { ContractsCard, ContractStatusChip } from "./contracts-card";
import type { ContractActionHandlers, LeadContractRow } from "./esign-types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Base UI positions dropdown content using browser layout APIs that jsdom does
// not provide. Keep the real action/dialog behavior while rendering menu items
// inline, matching the repository's existing dropdown RTL convention.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ render }: { render: React.ReactNode }) => render,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: React.ComponentPropsWithoutRef<"button">) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

function actionHandlers(): ContractActionHandlers {
  return {
    viewAction: vi.fn().mockResolvedValue({ ok: true, data: { detailsUrl: "https://app.hellosign.com/home/manage?guid=request-1" } }),
    remindAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
    voidAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
    retryAction: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { requestId: "request-retry" } }),
    downloadAction: vi.fn().mockResolvedValue({
      ok: true,
      data: { url: "https://authorized.example/signed.pdf" },
    }),
  };
}

function contract(overrides: Partial<LeadContractRow> = {}): LeadContractRow {
  return {
    id: "request-1",
    templateName: "Purchase agreement",
    signers: [
      {
        id: "signature-1",
        role: "Seller",
        order: 0,
        name: "Seller Owner",
        emailAddress: "seller@example.com",
        status: "awaiting",
        lastRemindedAt: null,
      },
    ],
    status: "awaiting",
    deliveryState: "sent",
    testMode: true,
    sentAt: "2026-08-29T18:00:00.000Z",
    detailsUrl: "https://app.hellosign.com/home/manage?guid=request-1",
    voidRequestedAt: null,
    signedPdfFileId: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("ContractsCard", () => {
  it("renders a distinct empty state", () => {
    render(<ContractsCard contracts={[]} actions={actionHandlers()} />);

    expect(screen.getByText("No contracts sent.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Send a contract from this lead to track its status here.",
      ),
    ).toBeInTheDocument();
  });

  it("does not disguise a load failure as an empty history", () => {
    render(
      <ContractsCard
        contracts={[]}
        actions={actionHandlers()}
        loadError="Try again."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Contracts did not load. Try again.",
    );
    expect(screen.queryByText("No contracts sent.")).not.toBeInTheDocument();
  });

  it.each([
    { overrides: { deliveryState: "sending" }, label: "Sending" },
    { overrides: { deliveryState: "send_unknown" }, label: "Send unknown" },
    { overrides: { deliveryState: "failed" }, label: "Error" },
    { overrides: { status: "viewed" }, label: "Viewed" },
    { overrides: { status: "signed" }, label: "Signed" },
    { overrides: { status: "declined" }, label: "Declined" },
    { overrides: { status: "voided" }, label: "Voided" },
    {
      overrides: { voidRequestedAt: "2026-08-29T18:30:00.000Z" },
      label: "Void pending",
    },
  ] as const)(
    "shows $label for its lifecycle state",
    ({ overrides, label }) => {
      render(
        <ContractStatusChip
          contract={contract(overrides as Partial<LeadContractRow>)}
        />,
      );

      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  it("keeps Signed visible before the PDF artifact exists", async () => {
    const user = userEvent.setup();
    render(
      <ContractsCard
        contracts={[contract({ status: "signed", signedPdfFileId: null })]}
        actions={actionHandlers()}
      />,
    );

    expect(screen.getByText("Signed")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Actions for Purchase agreement" }),
    );
    expect(screen.queryByText("Download signed PDF")).not.toBeInTheDocument();
    expect(screen.getByText("View in Dropbox Sign")).toBeInTheDocument();
  });
});

describe("ContractActions", () => {
  it("downloads only through the injected authorized file action", async () => {
    const user = userEvent.setup();
    const actions = actionHandlers();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <ContractActions
        contract={contract({
          status: "signed",
          signedPdfFileId: "file-1",
        })}
        actions={actions}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Purchase agreement" }),
    );
    await user.click(screen.getByText("Download signed PDF"));

    expect(actions.downloadAction).toHaveBeenCalledWith({ fileId: "file-1" });
    expect(open).toHaveBeenCalledWith(
      "https://authorized.example/signed.pdf",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("reminds only the first unfinished signer in provider order", async () => {
    const user = userEvent.setup();
    const actions = actionHandlers();
    render(
      <ContractActions
        contract={contract({
          signers: [
            {
              id: "signature-2",
              role: "Buyer",
              order: 1,
              name: "Buyer One",
              emailAddress: "buyer@example.com",
              status: "awaiting",
              lastRemindedAt: null,
            },
            {
              id: "signature-1",
              role: "Seller",
              order: 0,
              name: "Seller Owner",
              emailAddress: "seller@example.com",
              status: "signed",
              lastRemindedAt: null,
            },
          ],
        })}
        actions={actions}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Purchase agreement" }),
    );
    await user.click(screen.getByText("Send reminder"));
    expect(
      screen.getByRole("heading", { name: "Send signature reminder?" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Buyer role: Buyer One/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send reminder" }));

    expect(actions.remindAction).toHaveBeenCalledWith({
      requestId: "request-1",
      signerId: "signature-2",
    });
  });

  it("explains that voiding waits for the verified provider callback", async () => {
    const user = userEvent.setup();
    render(
      <ContractActions contract={contract()} actions={actionHandlers()} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Purchase agreement" }),
    );
    await user.click(screen.getByText("Void contract"));

    expect(
      screen.getByRole("heading", { name: "Void this contract?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Sandra will show this contract as voided only after the verified cancellation callback/,
      ),
    ).toBeInTheDocument();
  });

  it("explains that retry preserves the failed attempt", async () => {
    const user = userEvent.setup();
    render(
      <ContractActions
        contract={contract({ status: "error", deliveryState: "failed" })}
        actions={actionHandlers()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Purchase agreement" }),
    );
    await user.click(screen.getByText("Retry send"));

    expect(
      screen.getByText(
        /creates a new contract history row and keeps this failed attempt/,
      ),
    ).toBeInTheDocument();
  });
});
