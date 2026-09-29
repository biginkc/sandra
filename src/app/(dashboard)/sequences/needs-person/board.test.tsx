import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NeedsPersonLead } from "./actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(dashboard)/leads/bulk-start-drip-dialog", () => ({ BulkStartDripDialog: () => null }));
vi.mock("@/components/sequences/start-drip-picker", () => ({ StartDripPicker: () => null }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ updatePropertyStatus: vi.fn() }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ startDripForLeads: vi.fn() }));

import { NeedsPersonBoard } from "./board";

it("shows the uncapped total and a route to leads beyond the first 500", () => {
  const rows: NeedsPersonLead[] = Array.from({ length: 50 }, (_, i) => ({
    property_id: `property-${i}`, sequence_id: "sequence", bucket: "finished_no_reply",
    reason: "Finished, no reply", address: `Lead ${i}`, status: "contacted", threadId: null,
  }));
  render(<NeedsPersonBoard rows={rows} counts={{ finished_no_reply: 501, couldnt_send: 0, needs_sequence: 0 }}
    pages={{ finished_no_reply: 1, couldnt_send: 1, needs_sequence: 1 }} />);
  expect(screen.getByText("Page 1 of 11 · 501 leads")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/sequences/needs-person?finished_no_reply=2&open=finished_no_reply%2Cneeds_sequence#finished-no-reply");
});

it("keeps the Couldn't send group expanded after pagination remounts the board", () => {
  const row: NeedsPersonLead = {
    property_id: "property-a", sequence_id: "sequence", bucket: "couldnt_send",
    reason: "Failed", address: "A Street", status: "contacted", threadId: "conversation-a",
  };
  const counts = { finished_no_reply: 0, couldnt_send: 51, needs_sequence: 0 };
  const first = render(<NeedsPersonBoard rows={[row]} counts={counts}
    pages={{ finished_no_reply: 1, couldnt_send: 1, needs_sequence: 1 }} />);
  fireEvent.click(screen.getByRole("button", { name: /COULDN’T SEND/ }));
  expect(screen.getByRole("link", { name: "Open thread" })).toHaveAttribute("href", "/messages?thread=conversation-a");
  const nextHref = screen.getByRole("link", { name: "Next" }).getAttribute("href")!;
  const nextUrl = new URL(nextHref, "http://localhost");
  expect(nextUrl.searchParams.get("open")).toContain("couldnt_send");
  first.unmount();

  render(<NeedsPersonBoard rows={[{ ...row, property_id: "property-b", address: "B Street" }]} counts={counts}
    pages={{ finished_no_reply: 1, couldnt_send: 2, needs_sequence: 1 }}
    openGroups={nextUrl.searchParams.get("open") ?? undefined} />);
  expect(screen.getByText("B Street")).toBeVisible();
  expect(screen.getByRole("button", { name: /COULDN’T SEND/ })).toHaveAttribute("aria-expanded", "true");
});
