import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CampaignScoreboard } from "./campaign-scoreboard";

describe("<CampaignScoreboard />", () => {
  it("renders the KPI colors and the failed-number health note", () => {
    render(
      <CampaignScoreboard
        kpis={{
          audience: 120,
          attempted: 100,
          delivered: 96,
          delivered_rate: 96,
          failed: 11,
          failed_rate: 11,
          replied: 9,
          reply_rate: 9,
          opted_out: 3,
          opt_out_rate: 3,
        }}
      />,
    );

    expect(screen.getByTestId("campaign-kpi-card-delivered")).toHaveAttribute(
      "data-band",
      "yellow",
    );
    expect(screen.getByTestId("campaign-kpi-card-delivered").className).toContain(
      "bg-amber-50",
    );

    expect(screen.getByTestId("campaign-kpi-card-reply")).toHaveAttribute(
      "data-band",
      "yellow",
    );
    expect(screen.getByTestId("campaign-kpi-card-failed")).toHaveAttribute(
      "data-band",
      "yellow",
    );
    expect(screen.getByTestId("campaign-kpi-card-optOut")).toHaveAttribute(
      "data-band",
      "red",
    );

    expect(
      screen.getByText("Consider provisioning a new sending number"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Provider attempted 100 of 120 audience").length,
    ).toBeGreaterThan(0);
  });

  it("keeps the failed-number note hidden when failed is green", () => {
    render(
      <CampaignScoreboard
        kpis={{
          audience: 10,
          attempted: 10,
          delivered: 10,
          delivered_rate: 100,
          failed: 0,
          failed_rate: 0,
          replied: 1,
          reply_rate: 10,
          opted_out: 0,
          opt_out_rate: 0,
        }}
      />,
    );

    expect(screen.getByTestId("campaign-kpi-card-delivered")).toHaveAttribute(
      "data-band",
      "green",
    );
    expect(screen.queryByText("Consider provisioning a new sending number")).toBeNull();
  });
});
