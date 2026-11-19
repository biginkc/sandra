import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ListUpdatedBanner, RowRemovedNotice } from "./list-updated-banner";

describe("<ListUpdatedBanner />", () => {
  it("says List updated and offers Refresh", async () => {
    const onRefresh = vi.fn();
    render(<ListUpdatedBanner onRefresh={onRefresh} />);
    expect(screen.getByRole("status")).toHaveTextContent("List updated");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
  it("disables Refresh while refreshing", () => {
    render(<ListUpdatedBanner refreshing onRefresh={() => {}} />);
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  });
});

describe("<RowRemovedNotice />", () => {
  it("shows the one-line message", () => {
    render(<RowRemovedNotice message="Moved to Waiting on them" />);
    expect(screen.getByRole("status")).toHaveTextContent("Moved to Waiting on them");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("can be dismissed", async () => {
    const onDismiss = vi.fn();
    render(<RowRemovedNotice message="Moved to Waiting on them" onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
