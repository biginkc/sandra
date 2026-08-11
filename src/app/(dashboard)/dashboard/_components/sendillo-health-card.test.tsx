import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SendilloHealthCard } from "./sendillo-health-card";

describe("<SendilloHealthCard />", () => {
  it("renders Sendillo-era KPI labels and counts", () => {
    render(
      <SendilloHealthCard
        result={{
          status: "available",
          updatedAt: "2026-06-18T19:40:00Z",
          stale: false,
          health: {
            smsRows: 10262,
            outboundMessages: 9643,
            inboundMessages: 619,
            conversations: 9375,
            latestInboundMissingDisposition: 108,
            unreadMissingDisposition: 53,
            humanAttentionMissingDisposition: 51,
            anyInboundMissingDisposition: 222,
            firstMessageAt: "2026-06-10T03:32:07Z",
            latestMessageAt: "2026-06-18T19:36:09Z",
          },
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Sendillo SMS health" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sendillo-era SMS only. Dialpad history is excluded."),
    ).toBeInTheDocument();

    expectMetric(
      "Outbound / inbound SMS rows",
      "9,643 / 619",
      "10,262 total Sendillo rows",
    );
    expectMetric("Sendillo conversations", "9,375", "Non-queued SMS threads");
    expectMetric(
      "Inbound SMS rows",
      "619",
      "222 inbound-reply threads still have no disposition",
    );
    expectMetric("Needs disposition", "108", "Latest reply is inbound");
    expectMetric(
      "Unread needs disposition",
      "53",
      "Unread inbound on an undispositioned property",
    );
    expectMetric("Human attention", "51", "Flagged and still undispositioned");
    expect(
      screen.getByText("Last updated Jun 18, 2:40 PM CDT"),
    ).toBeInTheDocument();
    expect(screen.getByText("Jun 9 - Jun 18")).toBeInTheDocument();
  });

  it("labels an old stored snapshot as delayed without hiding its counts", () => {
    render(
      <SendilloHealthCard
        result={{
          status: "available",
          updatedAt: "2026-06-18T19:40:00Z",
          stale: true,
          health: {
            smsRows: 1,
            outboundMessages: 1,
            inboundMessages: 0,
            conversations: 1,
            latestInboundMissingDisposition: 0,
            unreadMissingDisposition: 0,
            humanAttentionMissingDisposition: 0,
            anyInboundMissingDisposition: 0,
            firstMessageAt: "2026-06-18T19:30:00Z",
            latestMessageAt: "2026-06-18T19:30:00Z",
          },
        }}
      />,
    );
    expect(screen.getByText(/Data delayed · Last updated/)).toBeInTheDocument();
    expect(screen.getByText("1 total Sendillo rows")).toBeInTheDocument();
  });

  it("renders an unavailable state instead of false zeroes", () => {
    render(
      <SendilloHealthCard
        result={{
          status: "unavailable",
          message: "Sendillo SMS health unavailable",
          health: {
            smsRows: 0,
            outboundMessages: 0,
            inboundMessages: 0,
            conversations: 0,
            latestInboundMissingDisposition: 0,
            unreadMissingDisposition: 0,
            humanAttentionMissingDisposition: 0,
            anyInboundMissingDisposition: 0,
            firstMessageAt: null,
            latestMessageAt: null,
          },
        }}
      />,
    );

    expect(
      screen.getByText("Sendillo SMS health unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText("0 total Sendillo rows")).not.toBeInTheDocument();
  });
});

function expectMetric(label: string, value: string, helper: string) {
  const tile = screen.getByText(label).parentElement;
  expect(tile).not.toBeNull();
  expect(within(tile!).getByText(value)).toBeInTheDocument();
  expect(within(tile!).getByText(helper)).toBeInTheDocument();
}
