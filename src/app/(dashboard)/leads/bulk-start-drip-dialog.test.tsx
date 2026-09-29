import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { listDripChoices, startDripForLeads } = vi.hoisted(() => ({
  listDripChoices: vi.fn(),
  startDripForLeads: vi.fn(),
}));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices, startDripForLeads }));

import { BulkStartDripDialog } from "./bulk-start-drip-dialog";

describe("BulkStartDripDialog", () => {
  it("lists shared picker choices and renders grouped reasons, counts, and addresses", async () => {
    const user = userEvent.setup();
    listDripChoices.mockResolvedValue({ ok: true, data: [{ id: "drip", name: "Follow up", textCount: 2, days: 3, firstSend: "Monday at 9 AM" }] });
    startDripForLeads.mockResolvedValue({ ok: true, data: { results: [
      { propertyId: "a", status: "enrolled", reason: "Enrolled" },
      { propertyId: "b", status: "skipped", reason: "Already in this drip" },
      { propertyId: "c", status: "skipped", reason: "Already in this drip" },
    ] } });
    render(<BulkStartDripDialog open leads={[{ id: "a", address: "1 Main" }, { id: "b", address: "2 Main" }, { id: "c", address: "3 Main" }]} onClose={vi.fn()} onComplete={vi.fn()} />);
    const choice = await screen.findByRole("button", { name: /Follow up/ });
    expect(choice).toHaveTextContent("First text: Monday at 9 AM");
    await user.click(choice);
    await waitFor(() => expect(screen.getByText(/1 started/)).toBeVisible());
    expect(screen.getByRole("dialog")).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-hidden");
    expect(screen.getByLabelText("Drip result details")).toHaveClass("min-h-0", "overflow-y-auto");
    expect(screen.getByText("2 skipped: Already in this drip")).toBeVisible();
    expect(screen.getByText("2 Main")).toBeInTheDocument();
    expect(screen.getByText("3 Main")).toBeInTheDocument();
  });
});
