import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ContractStatus } from "@/lib/esign/contract-status";

import { ContractStatusBadge } from "./contract-status-badge";

const cases: Array<
  [ContractStatus, string, string, string]
> = [
  ["awaiting", "Awaiting", "bg-status-replying-bg", "bg-status-replying-fg"],
  ["viewed", "Viewed", "bg-status-new-bg", "bg-status-new-fg"],
  ["signed", "Signed", "bg-alert-healthy/10", "bg-alert-healthy"],
  ["declined", "Declined", "bg-status-hot-bg", "bg-status-hot-fg"],
  [
    "voided",
    "Voided",
    "bg-status-contacted-bg",
    "bg-status-contacted-fg",
  ],
  ["error", "Error", "bg-destructive/10", "bg-destructive"],
];

describe("ContractStatusBadge", () => {
  it.each(cases)(
    "renders %s using the approved existing token mapping",
    (status, label, badgeClass, dotClass) => {
      render(<ContractStatusBadge status={status} />);

      const badge = screen.getByTestId("contract-status-badge");
      const dot = screen.getByTestId("contract-status-dot");
      expect(badge).toHaveTextContent(label);
      expect(badge).toHaveAttribute("data-status", status);
      expect(badge.className).toContain(badgeClass);
      expect(dot.className).toContain(dotClass);
    },
  );

  it.each([null, undefined])("renders nothing for absent status %s", (status) => {
    const { container } = render(<ContractStatusBadge status={status} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("uses the outline Badge geometry with 10px text and a 6px dot", () => {
    render(<ContractStatusBadge status="signed" />);

    const badge = screen.getByTestId("contract-status-badge");
    const dot = screen.getByTestId("contract-status-dot");
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge.className).toContain("border");
    expect(badge.className).toContain("text-[10px]");
    expect(dot.className).toContain("size-1.5");
    expect(dot.className).toContain("rounded-full");
  });

  it("accepts a bounded presentation class without changing its state mapping", () => {
    render(<ContractStatusBadge status="viewed" className="max-w-24" />);

    const badge = screen.getByTestId("contract-status-badge");
    expect(badge.className).toContain("max-w-24");
    expect(badge.className).toContain("bg-status-new-bg");
  });
});
