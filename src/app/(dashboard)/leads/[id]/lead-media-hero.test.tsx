import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeadMediaHero } from "./lead-media-hero";

const shared = {
  address: "123 Main St",
  locationLine: "Kansas City, MO 64111",
  homeownerName: "Jamie Seller",
  actions: <button type="button">Book appointment</button>,
};

const streetImages = {
  small: "https://maps.googleapis.com/maps/api/streetview?size=320x341",
  mobile: "https://maps.googleapis.com/maps/api/streetview?size=390x289",
  smallTablet: "https://maps.googleapis.com/maps/api/streetview?size=640x230",
  tablet: "https://maps.googleapis.com/maps/api/streetview?size=512x230",
  desktop: "https://maps.googleapis.com/maps/api/streetview?size=640x208",
  wide: "https://maps.googleapis.com/maps/api/streetview?size=640x156",
  large: "https://maps.googleapis.com/maps/api/streetview?size=640x135",
  extraLarge: "https://maps.googleapis.com/maps/api/streetview?size=640x125",
  ultra: "https://maps.googleapis.com/maps/api/streetview?size=640x104",
};
const aerialImages = {
  small:
    "https://maps.googleapis.com/maps/api/staticmap?size=320x341&maptype=satellite",
  mobile:
    "https://maps.googleapis.com/maps/api/staticmap?size=390x289&maptype=satellite",
  smallTablet:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x230&maptype=satellite",
  tablet:
    "https://maps.googleapis.com/maps/api/staticmap?size=512x230&maptype=satellite",
  desktop:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x208&maptype=satellite",
  wide:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x156&maptype=satellite",
  large:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x135&maptype=satellite",
  extraLarge:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x125&maptype=satellite",
  ultra:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x104&maptype=satellite",
};

describe("<LeadMediaHero />", () => {
  it("renders the official static Street View presentation", () => {
    render(
      <LeadMediaHero
        {...shared}
        media={{
          kind: "streetView",
          images: streetImages,
          aerialImages,
          aerialResolvedBy: "address",
          heading: 173,
          panoramaId: "pano-1",
        }}
      />,
    );

    expect(screen.getByTestId("lead-media-street-view")).toBeInTheDocument();
    const image = screen.getByTestId("lead-media-image");
    expect(image).toHaveAttribute(
      "src",
      expect.stringContaining("/maps/api/streetview"),
    );
    expect(image).toHaveAttribute("draggable", "false");
    expect(image).toHaveClass(
      "object-contain",
      "object-bottom",
      "pointer-events-none",
    );
    expect(image).toHaveAttribute(
      "referrerpolicy",
      "strict-origin-when-cross-origin",
    );
    const sources = Array.from(document.querySelectorAll("source"));
    expect(sources).toHaveLength(8);
    expect(
      sources.map((source) => [source.media, source.getAttribute("srcset")]),
    ).toEqual([
      ["(min-width: 1792px)", streetImages.ultra],
      ["(min-width: 1536px)", streetImages.extraLarge],
      ["(min-width: 1440px)", streetImages.large],
      ["(min-width: 1280px)", streetImages.wide],
      ["(min-width: 1024px)", streetImages.desktop],
      ["(min-width: 768px)", streetImages.tablet],
      ["(min-width: 640px)", streetImages.smallTablet],
      ["(min-width: 390px)", streetImages.mobile],
    ]);
    expect(image).toHaveAttribute("src", streetImages.small);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByTitle("Street View of 123 Main St")).toBeNull();
    expect(screen.getByTestId("lead-media-overlay")).toHaveClass(
      "pointer-events-none",
      "pb-9",
      "min-[1024px]:pb-12",
      "min-[1440px]:pb-14",
      "min-[1536px]:pb-[60px]",
      "min-[1792px]:pb-16",
    );
    expect(screen.getByTestId("lead-media-scrim")).toHaveClass(
      "bottom-0",
      "bg-[linear-gradient(to_top,transparent_0px,transparent_36px,rgba(2,6,23,0.9)_37px,rgba(2,6,23,0.65)_58%,transparent_100%)]",
      "min-[1024px]:bg-[linear-gradient(to_top,transparent_0px,transparent_48px,rgba(2,6,23,0.9)_49px,rgba(2,6,23,0.65)_58%,transparent_100%)]",
      "min-[1440px]:bg-[linear-gradient(to_top,transparent_0px,transparent_56px,rgba(2,6,23,0.9)_57px,rgba(2,6,23,0.65)_58%,transparent_100%)]",
      "min-[1536px]:bg-[linear-gradient(to_top,transparent_0px,transparent_60px,rgba(2,6,23,0.9)_61px,rgba(2,6,23,0.65)_58%,transparent_100%)]",
      "min-[1792px]:bg-[linear-gradient(to_top,transparent_0px,transparent_64px,rgba(2,6,23,0.9)_65px,rgba(2,6,23,0.65)_58%,transparent_100%)]",
    );
    expect(screen.getByTestId("lead-media-scrim")).not.toHaveClass("bottom-9");
    expect(screen.getByTestId("lead-media-bottom-scrim")).toHaveClass(
      "bottom-0",
      "left-36",
      "right-36",
      "xl:block",
      "min-[1792px]:left-56",
      "min-[1792px]:right-56",
    );
    expect(screen.getByTestId("lead-media-actions").className).toContain(
      "[&_button]:text-slate-950",
    );
    expect(screen.getByTestId("lead-media-actions").className).toContain(
      "[&_button]:bg-white/95",
    );
    expect(screen.getByTestId("lead-media-actions")).toHaveClass(
      "xl:absolute",
      "xl:bottom-0",
      "xl:items-end",
      "min-[1280px]:right-36",
      "min-[1280px]:h-12",
      "min-[1792px]:right-56",
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
          images: aerialImages,
          resolvedBy: "coordinates",
          fallbackReason: "no-coverage",
        }}
      />,
    );

    expect(screen.getByTestId("lead-media-aerial")).toBeInTheDocument();
    expect(screen.getByTestId("lead-media-image")).toHaveAttribute(
      "src",
      expect.stringContaining("maptype=satellite"),
    );
    expect(screen.queryByRole("button", { name: /street|aerial/i })).toBeNull();
  });

  it("falls back from an initial aerial image failure to the flat header", () => {
    render(
      <LeadMediaHero
        {...shared}
        media={{
          kind: "aerial",
          images: aerialImages,
          resolvedBy: "address",
          fallbackReason: "no-coverage",
        }}
      />,
    );

    fireEvent.error(screen.getByTestId("lead-media-image"));
    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument();
  });

  it("falls back from a failed Street View image to aerial and then flat", () => {
    render(
      <LeadMediaHero
        {...shared}
        media={{
          kind: "streetView",
          images: streetImages,
          aerialImages,
          aerialResolvedBy: "address",
          heading: null,
          panoramaId: "pano-1",
        }}
      />,
    );

    fireEvent.error(screen.getByTestId("lead-media-image"));
    expect(screen.getByTestId("lead-media-aerial")).toHaveAttribute(
      "data-media-fallback-reason",
      "street-image-error",
    );
    expect(screen.getByTestId("lead-media-image")).toHaveAttribute(
      "src",
      expect.stringContaining("/maps/api/staticmap"),
    );

    fireEvent.error(screen.getByTestId("lead-media-image"));
    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument();
    expect(screen.queryByTestId("lead-media-image")).toBeNull();
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
    expect(screen.queryByTestId("lead-media-image")).toBeNull();
    const actions = screen.getByRole("button", {
      name: "Book appointment",
    }).parentElement;
    expect(actions).toHaveClass("flex-wrap", "min-w-0");
    expect(actions?.className).toContain("[&_button]:min-h-9");
  });

  it("resets a prior image failure when the resolved lead media changes", () => {
    const { rerender } = render(
      <LeadMediaHero
        {...shared}
        media={{
          kind: "aerial",
          images: aerialImages,
          resolvedBy: "address",
          fallbackReason: "no-coverage",
        }}
      />,
    );

    fireEvent.error(screen.getByTestId("lead-media-image"));
    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument();

    rerender(
      <LeadMediaHero
        {...shared}
        media={{
          kind: "streetView",
          images: streetImages,
          aerialImages,
          aerialResolvedBy: "address",
          heading: null,
          panoramaId: "pano-2",
        }}
      />,
    );

    expect(screen.getByTestId("lead-media-street-view")).toBeInTheDocument();
  });
});
