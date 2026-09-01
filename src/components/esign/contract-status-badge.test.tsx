import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ContractStatus } from "@/lib/esign/contract-status";

import { ContractStatusBadge } from "./contract-status-badge";

const cases: Array<
  [ContractStatus, string, string, string, string, string]
> = [
  [
    "awaiting",
    "Awaiting",
    "bg-status-replying-bg",
    "text-status-replying-fg",
    "border-status-replying-border",
    "bg-status-replying-fg",
  ],
  [
    "viewed",
    "Viewed",
    "bg-status-new-bg",
    "text-status-new-fg",
    "border-status-new-border",
    "bg-status-new-fg",
  ],
  [
    "signed",
    "Signed",
    "bg-alert-healthy/10",
    "text-alert-healthy",
    "border-alert-healthy/30",
    "bg-alert-healthy",
  ],
  [
    "declined",
    "Declined",
    "bg-status-hot-bg",
    "text-status-hot-fg",
    "border-status-hot-border",
    "bg-status-hot-fg",
  ],
  [
    "voided",
    "Voided",
    "bg-status-contacted-bg",
    "text-status-contacted-fg",
    "border-status-contacted-border",
    "bg-status-contacted-fg",
  ],
  [
    "error",
    "Error",
    "bg-destructive/10",
    "text-destructive",
    "border-destructive/30",
    "bg-destructive",
  ],
];

describe("ContractStatusBadge", () => {
  it.each(cases)(
    "renders %s using the approved existing token mapping",
    (status, label, backgroundClass, textClass, borderClass, dotClass) => {
      render(<ContractStatusBadge status={status} />);

      const badge = screen.getByTestId("contract-status-badge");
      const dot = screen.getByTestId("contract-status-dot");
      expect(badge).toHaveTextContent(label);
      expect(badge).toHaveAttribute("data-status", status);
      expect(badge.className).toContain(backgroundClass);
      expect(badge.className).toContain(textClass);
      expect(badge.className).toContain(borderClass);
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
    expect(badge).toHaveAttribute("data-contract-variant", "outline");
    expect(badge.className).toContain("border");
    expect(badge.className).toContain("text-[10px]");
    expect(dot.className).toContain("size-1.5");
    expect(dot.className).toContain("rounded-full");
  });

});
