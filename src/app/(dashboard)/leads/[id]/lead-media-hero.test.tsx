import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeadMediaHero } from "./lead-media-hero";

const shared = {
  address: "123 Main St",
  locationLine: "Kansas City, MO 64111",
  homeownerName: "Jamie Seller",
  actions: <button type="button">Book appointment</button>,
};

describe("<LeadMediaHero />", () => {
  it("renders the official interactive Street View presentation", () => {
    render(
      <LeadMediaHero
        {...shared}
        media={{
          kind: "streetView",
          embedUrl:
            "https://www.google.com/maps/embed/v1/streetview?key=test&pano=pano-1",
          heading: 173,
          panoramaId: "pano-1",
        }}
      />,
    );

    expect(screen.getByTestId("lead-media-street-view")).toBeInTheDocument();
    const frame = screen.getByTitle("Street View of 123 Main St");
    expect(frame).toHaveAttribute("allowfullscreen");
    expect(frame).toHaveAttribute(
      "referrerpolicy",
      "strict-origin-when-cross-origin",
    );
    expect(frame).toHaveAttribute(
      "allow",
      "accelerometer; gyroscope; fullscreen",
    );
    expect(frame).toHaveAttribute(
      "src",
      expect.stringContaining("/maps/embed/v1/streetview"),
    );
    expect(screen.getByTestId("lead-media-overlay")).toHaveClass(
      "pointer-events-none",
    );
    expect(
      screen.getByRole("button", { name: "Book appointment" }).parentElement,
    ).toHaveClass("pointer-events-auto");
  });

  it("renders the automatic aerial fallback without a view selector", () => {
    render(
      <LeadMediaHero
        {...shared}
        media={{
          kind: "aerial",
          embedUrl:
            "https://www.google.com/maps/embed/v1/view?key=test&maptype=satellite",
          resolvedBy: "coordinates",
          fallbackReason: "no-coverage",
        }}
      />,
    );

    expect(screen.getByTestId("lead-media-aerial")).toBeInTheDocument();
    expect(screen.getByTitle("Aerial view of 123 Main St")).toHaveAttribute(
      "src",
      expect.stringContaining("maptype=satellite"),
    );
    expect(screen.queryByRole("button", { name: /street|aerial/i })).toBeNull();
  });

  it("uses the flat header only when neither media view resolves", () => {
    render(
      <LeadMediaHero
        {...shared}
        media={{ kind: "flat", reason: "missing-location" }}
      />,
    );

    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "123 Main St" })).toBeVisible();
    expect(screen.queryByTitle(/view of/i)).toBeNull();
    const actions = screen.getByRole("button", {
      name: "Book appointment",
    }).parentElement;
    expect(actions).toHaveClass("flex-wrap", "min-w-0");
    expect(actions?.className).toContain("[&_button]:min-h-9");
  });
});
