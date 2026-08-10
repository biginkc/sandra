import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./refresh-credits-button", () => ({
  RefreshCreditsButton: () => <button type="button">Refresh</button>,
}));

import { SkipTraceCredits } from "./skip-trace-credits";

describe("SkipTraceCredits", () => {
  it("shows an exact Central timestamp and admin controls for a snapshot", () => {
    render(
      <SkipTraceCredits
        isAdmin
        balance={{
          available: true,
          credits: 6692,
          tier: "ok",
          capturedAt: "2026-08-10T16:15:00.000Z",
        }}
      />,
    );
    expect(screen.getByText("6,692")).toBeInTheDocument();
    expect(screen.getByText(/Last checked Aug 10, 11:15 AM CDT/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add credits/ })).toHaveAttribute(
      "href",
      "/admin/skip-trace-settings",
    );
  });

  it("keeps settings recovery beside refresh before the first snapshot", () => {
    const { container } = render(
      <SkipTraceCredits
        isAdmin
        balance={{ available: false, reason: "not_checked" }}
      />,
    );
    expect(screen.getByText("No balance check has completed yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open settings/ })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("flex-col", "sm:flex-row");
  });

  it("does not expose provider controls to a non-admin", () => {
    render(
      <SkipTraceCredits
        isAdmin={false}
        balance={{
          available: true,
          credits: 10,
          tier: "critical",
          capturedAt: "2026-08-10T16:15:00.000Z",
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add credits/ })).not.toBeInTheDocument();
  });

  it("stacks the balance and controls at phone widths", () => {
    const { container } = render(
      <SkipTraceCredits
        isAdmin
        balance={{
          available: true,
          credits: 6692,
          tier: "ok",
          capturedAt: "2026-08-10T16:15:00.000Z",
        }}
      />,
    );

    expect(container.firstElementChild).toHaveClass("flex-col", "sm:flex-row");
    expect(screen.getByRole("button", { name: "Refresh" }).parentElement).toHaveClass(
      "w-full",
      "flex-wrap",
      "sm:w-auto",
    );
  });
});
