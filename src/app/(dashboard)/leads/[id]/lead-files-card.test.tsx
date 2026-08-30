import { render, screen } from "@testing-library/react";
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
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<LeadFilesCard files={[file]} downloadAction={downloadAction} />);

    expect(
      screen.getByText("Signed purchase agreement.pdf"),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Download Signed purchase agreement.pdf",
      }),
    );

    expect(downloadAction).toHaveBeenCalledWith({ fileId: "file-1" });
    expect(open).toHaveBeenCalledWith(
      "https://authorized.example/file.pdf",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
