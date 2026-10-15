import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConversationBox, type ConversationMessage } from "./conversation-box";
import { NOW } from "./test-support";

const out = (at: string, over: Partial<ConversationMessage> = {}): ConversationMessage => ({ direction: "outbound", body: "Hi there", at, automated: false, ...over });
const inb = (at: string, over: Partial<ConversationMessage> = {}): ConversationMessage => ({ direction: "inbound", body: "Who is this?", at, automated: false, ...over });

function setup(messages: ConversationMessage[], extra: Partial<Parameters<typeof ConversationBox>[0]> = {}) {
  const onShowAll = vi.fn();
  render(<ConversationBox propertyId="lead-1" state={{ status: "ready", messages }} now={NOW} onShowAll={onShowAll} {...extra} />);
  return onShowAll;
}

describe("<ConversationBox />", () => {
  it("shows the last outbound then the last inbound, one line each, newest at the bottom", () => {
    setup([
      out("2026-10-14T10:00:00Z", { body: "old out" }),
      inb("2026-10-14T11:00:00Z", { body: "old in" }),
      out("2026-10-14T12:00:00Z", { body: "latest out" }),
      inb("2026-10-14T17:00:00Z", { body: "latest in\nwith break" }),
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Us: latest out");
    expect(items[1]).toHaveTextContent("Them: latest in with break");
    expect(items[1]).toHaveTextContent("1h ago");
    expect(screen.queryByText(/old out|old in/)).not.toBeInTheDocument();
  });
  it("orders by time even when the container passes newest first", () => {
    setup([inb("2026-10-14T17:00:00Z"), out("2026-10-14T12:00:00Z")]);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("data-direction", "outbound");
    expect(items[1]).toHaveAttribute("data-direction", "inbound");
  });
  it.each([["drip", "Us (drip):"], ["campaign", "Us (campaign):"], ["sandra", "Us (Sandra):"]] as const)("tags %s outbound texts", (automation, tag) => {
    setup([out("2026-10-14T12:00:00Z", { automation }), inb("2026-10-14T13:00:00Z")]);
    expect(screen.getByText(tag)).toBeInTheDocument();
  });
  it("tags automated outbound as (drip)", () => {
    setup([out("2026-10-14T12:00:00Z", { automated: true }), inb("2026-10-14T13:00:00Z")]);
    expect(screen.getByText("Us (drip):")).toBeInTheDocument();
  });
  it("an unanswered inbound is blue; an answered one is not", () => {
    setup([out("2026-10-14T12:00:00Z"), inb("2026-10-14T13:00:00Z")]);
    const item = screen.getAllByRole("listitem")[1];
    expect(item).toHaveAttribute("data-unanswered", "true");
    expect(item.className).toContain("text-blue-700");
  });
  it("answered when the newest text is ours, or when the container says so", () => {
    const { unmount } = render(<ConversationBox propertyId="a" state={{ status: "ready", messages: [inb("2026-10-14T12:00:00Z"), out("2026-10-14T13:00:00Z")] }} now={NOW} onShowAll={() => {}} />);
    expect(screen.getAllByRole("listitem")[0]).not.toHaveAttribute("data-unanswered");
    unmount();
    setup([out("2026-10-14T12:00:00Z"), inb("2026-10-14T13:00:00Z")], { unanswered: false });
    expect(screen.getAllByRole("listitem")[1]).not.toHaveAttribute("data-unanswered");
  });
  it("has no They said line", () => {
    setup([inb("2026-10-14T13:00:00Z")]);
    expect(screen.queryByText(/they said/i)).not.toBeInTheDocument();
  });
  it("Show all texts calls back", async () => {
    const onShowAll = setup([out("2026-10-14T12:00:00Z")]);
    await userEvent.click(screen.getByRole("button", { name: "Show all texts" }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });
  it("handles only one direction", () => {
    setup([out("2026-10-14T12:00:00Z")]);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
  it("loading, empty and error states", async () => {
    const { unmount } = render(<ConversationBox propertyId="a" state={{ status: "loading" }} now={NOW} onShowAll={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading texts");
    unmount();
    const empty = render(<ConversationBox propertyId="a" state={{ status: "ready", messages: [] }} now={NOW} onShowAll={() => {}} />);
    expect(screen.getByText("No texts yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all texts" })).not.toBeInTheDocument();
    empty.unmount();
    const onRetry = vi.fn();
    render(<ConversationBox propertyId="a" state={{ status: "error", message: "Boom" }} now={NOW} onShowAll={() => {}} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    await userEvent.click(screen.getByRole("button", { name: "Retry texts" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
