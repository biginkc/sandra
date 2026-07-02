import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CampaignDeliveryCard } from "./campaign-delivery-card";

describe("<CampaignDeliveryCard />", () => {
  it("shows a nullable provider campaign without exposing provider mutation controls", () => {
    render(
      <CampaignDeliveryCard
        senderProvider="sendillo"
        senderNumber="+18164876899"
        providerCampaignExternalId={null}
        providerCampaignName={null}
        locked={false}
      />,
    );

    expect(screen.getByText("sendillo")).toBeInTheDocument();
    expect(screen.getByText("+18164876899")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(
      screen.getByText("Sender editable until first queue"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /buy number/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create provider campaign/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add number/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the sender as locked after outbound rows exist", () => {
    render(
      <CampaignDeliveryCard
        senderProvider="sendillo"
        senderNumber="+18164876899"
        providerCampaignExternalId="camp-123"
        providerCampaignName="BMH 10DLC"
        locked={true}
      />,
    );

    expect(screen.getByText("Sender locked")).toBeInTheDocument();
    expect(screen.getByText("BMH 10DLC")).toBeInTheDocument();
    expect(
      screen.queryByText("Sender editable until first queue"),
    ).not.toBeInTheDocument();
  });
});
