import { render, screen } from "@testing-library/react";
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
  expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/sequences/needs-person?finished_no_reply=2#finished-no-reply");
});
