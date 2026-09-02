import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    viewAction: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        detailsUrl: "https://app.hellosign.com/home/manage?guid=request-1",
      },
    }),
    remindAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
    voidAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
    retryAction: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { requestId: "request-retry" } }),
    confirmNotSentAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
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
    detailsAvailable: true,
    voidRequestedAt: null,
    signedPdfFileId: null,
    errorMessage: null,
    retryConsumed: false,
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
  it("does not offer dead actions for a delivered lifecycle error", async () => {
    const user = userEvent.setup();
    render(
      <ContractActions
        contract={contract({ status: "error", deliveryState: "sent" })}
        actions={actionHandlers()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Purchase agreement" }),
    );
    expect(screen.queryByText("Send reminder")).not.toBeInTheDocument();
    expect(screen.queryByText("Void contract")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry send")).not.toBeInTheDocument();
    expect(screen.getByText("View in Dropbox Sign")).toBeInTheDocument();
  });

  it("offers retry only for a failed delivery", async () => {
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
    expect(screen.getByText("Retry send")).toBeInTheDocument();
    expect(screen.queryByText("Send reminder")).not.toBeInTheDocument();
    expect(screen.queryByText("Void contract")).not.toBeInTheDocument();
  });

  it("offers confirm-not-sent for an unresolved unknown send without enabling retry", async () => {
    const user = userEvent.setup();
    render(
      <ContractActions
        contract={contract({
          deliveryState: "send_unknown",
          detailsAvailable: false,
        })}
        actions={actionHandlers()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Purchase agreement" }),
    );

    expect(screen.getByText("Confirm not sent")).toBeInTheDocument();
    expect(screen.queryByText("Retry send")).not.toBeInTheDocument();
  });

  it("hides retry after a failed source has been consumed by a child", async () => {
    render(
      <ContractActions
        contract={contract({
          status: "error",
          deliveryState: "failed",
          retryConsumed: true,
        })}
        actions={actionHandlers()}
      />,
    );

    expect(screen.queryByText("Retry send")).not.toBeInTheDocument();
    expect(screen.getByText("View in Dropbox Sign")).toBeInTheDocument();
  });

  it("downloads only through the injected authorized file action", async () => {
    const user = userEvent.setup();
    const actions = actionHandlers();
    const popup = popupWindow();
    const events: string[] = [];
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      events.push("open");
      return popup.window;
    });
    vi.mocked(actions.downloadAction).mockImplementation(async () => {
      events.push("authorize");
      return {
        ok: true,
        data: { url: "https://authorized.example/signed.pdf" },
      };
    });
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

    await waitFor(() =>
      expect(actions.downloadAction).toHaveBeenCalledWith({ fileId: "file-1" }),
    );
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(events).toEqual(["open", "authorize"]);
    expect(popup.window.opener).toBeNull();
    expect(popup.location.href).toBe("https://authorized.example/signed.pdf");
  });

  it("closes a placeholder on authorization failure and reports popup blocking", async () => {
    const user = userEvent.setup();
    const actions = actionHandlers();
    const popup = popupWindow();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(popup.window)
      .mockReturnValueOnce(null);
    vi.mocked(actions.viewAction).mockResolvedValue({
      ok: false,
      error: { code: "DETAILS_UNAVAILABLE", message: "Details unavailable." },
    });
    render(<ContractActions contract={contract()} actions={actions} />);

    await user.click(screen.getByText("View in Dropbox Sign"));
    await waitFor(() => expect(popup.close).toHaveBeenCalledTimes(1));
    expect(popup.location.href).toBe("about:blank");

    await user.click(screen.getByText("View in Dropbox Sign"));
    expect(actions.viewAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your browser blocked the Dropbox Sign window.",
    );
    expect(open).toHaveBeenLastCalledWith("about:blank", "_blank");
  });

  it("surfaces a safe error when the authorized details window closes before navigation", async () => {
    const user = userEvent.setup();
    const actions = actionHandlers();
    const popup = popupWindow({ closed: true });
    vi.spyOn(window, "open").mockReturnValue(popup.window);
    render(<ContractActions contract={contract()} actions={actions} />);

    await user.click(screen.getByText("View in Dropbox Sign"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not open Dropbox Sign details.",
      ),
    );
    expect(actions.viewAction).toHaveBeenCalledWith({
      requestId: "request-1",
    });
    expect(popup.replace).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a safe error when signed-PDF navigation throws", async () => {
    const user = userEvent.setup();
    const actions = actionHandlers();
    const popup = popupWindow({ replaceThrows: true });
    vi.spyOn(window, "open").mockReturnValue(popup.window);
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

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not open the signed PDF.",
      ),
    );
    expect(popup.close).toHaveBeenCalledTimes(1);
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

  it.each([
    ["remind", "Send reminder", "Send reminder", "Sending reminder…", {}],
    ["void", "Void contract", "Request void", "Requesting void…", {}],
    [
      "confirm_not_sent",
      "Confirm not sent",
      "Confirm not sent",
      "Checking Dropbox Sign…",
      { deliveryState: "send_unknown", detailsAvailable: false },
    ],
    [
      "retry",
      "Retry send",
      "Retry send",
      "Retrying contract…",
      { status: "error", deliveryState: "failed" },
    ],
  ] as const)(
    "guards pending %s dismissal and announces its exact busy label",
    async (mode, menuLabel, confirmLabel, busyLabel, overrides) => {
      const user = userEvent.setup();
      const actions = actionHandlers();
      const pending = deferred<unknown>();
      if (mode === "remind") {
        vi.mocked(actions.remindAction).mockReturnValue(
          pending.promise as never,
        );
      } else if (mode === "void") {
        vi.mocked(actions.voidAction).mockReturnValue(pending.promise as never);
      } else if (mode === "confirm_not_sent") {
        vi.mocked(actions.confirmNotSentAction).mockReturnValue(
          pending.promise as never,
        );
      } else {
        vi.mocked(actions.retryAction).mockReturnValue(
          pending.promise as never,
        );
      }
      render(
        <ContractActions
          contract={contract(overrides as Partial<LeadContractRow>)}
          actions={actions}
        />,
      );
      await user.click(screen.getByText(menuLabel));
      await user.click(screen.getByRole("button", { name: confirmLabel }));

      expect(await screen.findByRole("status")).toHaveTextContent(busyLabel);
      expect(
        screen.queryByRole("button", { name: "Close" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await user.keyboard("{Escape}");
      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      expect(overlay).not.toBeNull();
      fireEvent.pointerDown(overlay!);
      expect(screen.getByRole("status")).toHaveTextContent(busyLabel);

      await act(async () => {
        pending.resolve(
          mode === "retry"
            ? { ok: true, data: { requestId: "request-retry" } }
            : { ok: true, data: null },
        );
        await pending.promise;
      });
      await waitFor(() =>
        expect(screen.queryByRole("status")).not.toBeInTheDocument(),
      );
    },
  );
});

function popupWindow(
  options: { closed?: boolean; replaceThrows?: boolean } = {},
) {
  const location = { href: "about:blank" };
  const close = vi.fn();
  const replace = vi.fn((url: string) => {
    if (options.replaceThrows) throw new Error("navigation denied");
    location.href = url;
  });
  const document = {
    head: { append: vi.fn() },
    createElement: vi.fn(() => ({ name: "", content: "" })),
  };
  const window = {
    opener: {},
    closed: options.closed ?? false,
    location: { replace },
    document,
    close,
  } as unknown as Window;
  return { window, location, close, replace };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
