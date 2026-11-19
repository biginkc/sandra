import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mark: vi.fn(), refresh: vi.fn() }));
vi.mock("./actions", () => ({ markNormaRequestReviewed: mocks.mark }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { NormaReviewCard } from "./review-card";

const row = { id: "req-1", propertyId: "prop-1", address: "12 Elm St", summary: "Call dropped", outcome: null, updatedAt: "2026-10-14T12:00:00Z", selected: true };

beforeEach(() => vi.resetAllMocks());

describe("NormaReviewCard (opened by request id from My Leads)", () => {
  it("shows the selected request and marks exactly that request reviewed", async () => {
    mocks.mark.mockResolvedValue({ ok: true, code: "reviewed" });
    render(<NormaReviewCard rows={[row]} />);
    expect(screen.getByTestId("norma-review-req-1")).toHaveAttribute("data-selected", "true");
    await userEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(mocks.mark).toHaveBeenCalledWith("prop-1", "req-1"));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });
  it("tells the rep when the call is no longer waiting for review", () => {
    render(<NormaReviewCard rows={[]} />);
    expect(screen.getByTestId("norma-review-empty")).toBeInTheDocument();
  });
  it("shows an error and does not refresh when marking fails", async () => {
    mocks.mark.mockResolvedValue({ ok: false, code: "error" });
    render(<NormaReviewCard rows={[row]} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await screen.findByRole("alert");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
