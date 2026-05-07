import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EscalationBadge } from "./escalation-badge";

describe("EscalationBadge", () => {
  it("renders nothing when reason is null", () => {
    const { container } = render(<EscalationBadge reason={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when reason is undefined", () => {
    const { container } = render(<EscalationBadge reason={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when reason is empty string", () => {
    const { container } = render(<EscalationBadge reason="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders sky color for keyword:handoff_request", () => {
    render(<EscalationBadge reason="keyword:handoff_request" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "sky");
    expect(badge).toHaveAttribute("data-tier", "handoff_request");
    expect(badge).toHaveTextContent("Wants human");
    expect(badge.className).toContain("bg-sky-100");
    expect(badge.className).toContain("text-sky-700");
  });

  it("renders emerald color for keyword:price_offer", () => {
    render(<EscalationBadge reason="keyword:price_offer" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "emerald");
    expect(badge).toHaveTextContent("Price offer");
    expect(badge.className).toContain("bg-emerald-100");
  });

  it("renders violet color for keyword:legal_contract", () => {
    render(<EscalationBadge reason="keyword:legal_contract" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "violet");
    expect(badge).toHaveTextContent("Legal/Contract");
    expect(badge.className).toContain("bg-violet-100");
  });

  it("renders rose color for keyword:distressed_seller", () => {
    render(<EscalationBadge reason="keyword:distressed_seller" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "rose");
    expect(badge).toHaveTextContent("Distressed");
    expect(badge.className).toContain("bg-rose-100");
  });

  it("renders amber for non-keyword gates (sentiment)", () => {
    render(<EscalationBadge reason="sentiment:hostile" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "amber");
    expect(badge).toHaveAttribute("data-gate", "sentiment");
    expect(badge).toHaveTextContent("Sentiment");
    expect(badge.className).toContain("bg-amber-100");
  });

  it("renders amber for low_confidence", () => {
    render(<EscalationBadge reason="low_confidence:0.42" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "amber");
    expect(badge).toHaveTextContent("Low confidence");
  });

  it("renders amber for safety blocks", () => {
    render(<EscalationBadge reason="safety:contains_dollar_amount" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "amber");
    expect(badge).toHaveTextContent("Safety blocked");
  });

  it("renders amber for generate_error", () => {
    render(<EscalationBadge reason="generate_error" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("data-color", "amber");
    expect(badge).toHaveTextContent("AI error");
  });

  it("includes the longLabel as tooltip via title attribute", () => {
    render(<EscalationBadge reason="keyword:price_offer" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge).toHaveAttribute("title", "keyword match (price offer)");
  });

  it("respects size=md", () => {
    render(<EscalationBadge reason="keyword:price_offer" size="md" />);
    const badge = screen.getByTestId("escalation-badge");
    expect(badge.className).toContain("h-6");
    expect(badge.className).toContain("text-xs");
  });
});
