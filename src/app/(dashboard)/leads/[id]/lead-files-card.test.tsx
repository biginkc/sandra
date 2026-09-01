import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ContractActionHandlers, LeadFileRow } from "./esign-types";
import { LeadFilesCard } from "./lead-files-card";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const downloadAction: ContractActionHandlers["downloadAction"] = vi
  .fn()
  .mockResolvedValue({
    ok: true,
    data: { url: "https://authorized.example/file.pdf" },
  });

const file: LeadFileRow = {
  id: "file-1",
  displayName: "Signed purchase agreement.pdf",
  kind: "signed_contract",
  createdAt: "2026-08-29T18:00:00.000Z",
  sizeBytes: 1536,
};

describe("LeadFilesCard", () => {
  it("renders its empty state", () => {
    render(<LeadFilesCard files={[]} downloadAction={downloadAction} />);
    expect(screen.getByText("No files yet.")).toBeInTheDocument();
  });

  it("renders load failures separately from the empty state", () => {
    render(
      <LeadFilesCard
        files={[]}
        downloadAction={downloadAction}
        loadError="Try again."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Files did not load. Try again.",
    );
    expect(screen.queryByText("No files yet.")).not.toBeInTheDocument();
  });

  it("uses a short-lived authorized download instead of a stored public URL", async () => {
    const user = userEvent.setup();
    const popup = popupWindow();
    const events: string[] = [];
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      events.push("open");
      return popup.window;
    });
    const authorizedDownload = vi
      .fn(downloadAction)
      .mockImplementation(async () => {
        events.push("authorize");
        return {
          ok: true,
          data: { url: "https://authorized.example/file.pdf" },
        };
      });
    render(
      <LeadFilesCard files={[file]} downloadAction={authorizedDownload} />,
    );

    expect(
      screen.getByText("Signed purchase agreement.pdf"),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Download Signed purchase agreement.pdf",
      }),
    );

    await waitFor(() =>
      expect(authorizedDownload).toHaveBeenCalledWith({ fileId: "file-1" }),
    );
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(events).toEqual(["open", "authorize"]);
    expect(popup.window.opener).toBeNull();
    expect(popup.location.href).toBe("https://authorized.example/file.pdf");
  });

  it("closes failed placeholders and surfaces popup blocking without authorization", async () => {
    const user = userEvent.setup();
    const popup = popupWindow();
    vi.spyOn(window, "open")
      .mockReturnValueOnce(popup.window)
      .mockReturnValueOnce(null);
    const action = vi
      .fn<ContractActionHandlers["downloadAction"]>()
      .mockResolvedValue({
        ok: false,
        error: { code: "FILE_NOT_FOUND", message: "File unavailable." },
      });
    render(<LeadFilesCard files={[file]} downloadAction={action} />);
    const button = screen.getByRole("button", {
      name: "Download Signed purchase agreement.pdf",
    });

    await user.click(button);
    await waitFor(() => expect(popup.close).toHaveBeenCalledTimes(1));
    await user.click(button);

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your browser blocked the file window.",
    );
  });

  it("surfaces the existing inline error when authorized navigation fails", async () => {
    const user = userEvent.setup();
    const popup = popupWindow({ replaceThrows: true });
    vi.spyOn(window, "open").mockReturnValue(popup.window);
    const action = vi
      .fn<ContractActionHandlers["downloadAction"]>()
      .mockResolvedValue({
        ok: true,
        data: { url: "https://authorized.example/file.pdf" },
      });
    render(<LeadFilesCard files={[file]} downloadAction={action} />);

    await user.click(
      screen.getByRole("button", {
        name: "Download Signed purchase agreement.pdf",
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not open this file.",
      ),
    );
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
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
