import { act, fireEvent, render, screen, within } from "@testing-library/react";
import Link from "next/link";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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
  desktop: "https://maps.googleapis.com/maps/api/streetview?size=640x230",
  wide: "https://maps.googleapis.com/maps/api/streetview?size=640x170",
  large: "https://maps.googleapis.com/maps/api/streetview?size=640x145",
  extraLarge: "https://maps.googleapis.com/maps/api/streetview?size=640x135",
  ultra: "https://maps.googleapis.com/maps/api/streetview?size=640x110",
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
    "https://maps.googleapis.com/maps/api/staticmap?size=640x230&maptype=satellite",
  wide:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x170&maptype=satellite",
  large:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x145&maptype=satellite",
  extraLarge:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x135&maptype=satellite",
  ultra:
    "https://maps.googleapis.com/maps/api/staticmap?size=640x110&maptype=satellite",
};

const actionFocusClasses = [
  "[&_button]:focus-visible:ring-white",
  "[&_button]:focus-visible:ring-offset-2",
  "[&_button]:focus-visible:ring-offset-slate-950",
  "[&_a]:rounded-md",
  "[&_a]:outline-none",
  "[&_a]:focus-visible:ring-2",
  "[&_a]:focus-visible:ring-white",
  "[&_a]:focus-visible:ring-offset-2",
  "[&_a]:focus-visible:ring-offset-slate-950",
  "[&>span]:focus-within:overflow-visible",
];

function expectVisibleActionFocus() {
  const actions = screen.getByTestId("lead-media-actions");
  for (const className of actionFocusClasses) {
    expect(actions.className).toContain(className);
  }
}

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
      "absolute",
      "h-full",
      "w-full",
      "object-cover",
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
    expect(screen.getByTestId("lead-media-street-view")).toHaveClass(
      "overflow-hidden",
      "bg-slate-900",
    );
    expect(screen.getByTestId("lead-media-picture")).toHaveClass(
      "block",
      "h-full",
      "bg-slate-900",
    );
    expect(screen.getByTestId("lead-media-image-frame")).toHaveClass(
      "h-[210px]",
      "sm:h-[230px]",
      "lg:h-[250px]",
      "overflow-hidden",
    );
    expect(screen.getByTestId("lead-media-overlay")).toHaveClass(
      "bg-gradient-to-b",
      "from-slate-900",
      "to-slate-950",
      "py-3.5",
      "lg:flex-row",
    );
    expect(screen.queryByTestId("lead-media-scrim")).toBeNull();
    expect(screen.queryByTestId("lead-media-bottom-scrim")).toBeNull();
    expect(screen.getByTestId("lead-media-actions").className).toContain(
      "[&_button]:text-slate-950",
    );
    expect(screen.getByTestId("lead-media-actions").className).toContain(
      "[&_button]:bg-white/95",
    );
    expectVisibleActionFocus();
    expect(screen.getByTestId("lead-media-actions")).not.toHaveClass(
      "absolute",
      "xl:absolute",
    );
    expect(
      screen.getByRole("button", { name: "Book appointment" }).parentElement,
    ).toHaveClass("flex-wrap", "min-w-0");
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
    const aerialSources = Array.from(document.querySelectorAll("source"));
    expect(
      aerialSources.find((source) => source.media === "(min-width: 640px)"),
    ).toHaveAttribute("srcset", aerialImages.smallTablet);
    expect(
      aerialSources.find((source) => source.media === "(min-width: 768px)"),
    ).toHaveAttribute("srcset", aerialImages.tablet);
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

  it("does not skip aerial for duplicate failures from the same Street View render", () => {
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
    const image = screen.getByTestId("lead-media-image");

    act(() => {
      image.dispatchEvent(new Event("error"));
      image.dispatchEvent(new Event("error"));
    });

    expect(screen.getByTestId("lead-media-aerial")).toHaveAttribute(
      "data-media-fallback-reason",
      "street-image-error",
    );
    expect(screen.getByTestId("lead-media-image")).toHaveAttribute(
      "src",
      aerialImages.small,
    );
    expect(screen.queryByTestId("lead-media-flat")).toBeNull();
  });

  it("reconciles a Street View image that failed before hydration", async () => {
    const hero = (
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
      />
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(hero);
    document.body.append(container);
    const image = within(container).getByTestId("lead-media-image");
    Object.defineProperty(image, "complete", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      get: () => (image.getAttribute("src") === streetImages.small ? 0 : 640),
    });
    let root: Root | undefined;

    try {
      await act(async () => {
        root = hydrateRoot(container, hero);
      });

      expect(
        within(container).getByTestId("lead-media-aerial"),
      ).toHaveAttribute("data-media-fallback-reason", "street-image-error");
      expect(within(container).getByTestId("lead-media-image")).toHaveAttribute(
        "src",
        aerialImages.small,
      );
      expect(within(container).queryByTestId("lead-media-flat")).toBeNull();
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it("reconciles an aerial image that failed before hydration", async () => {
    const hero = (
      <LeadMediaHero
        {...shared}
        media={{
          kind: "aerial",
          images: aerialImages,
          resolvedBy: "address",
          fallbackReason: "no-coverage",
        }}
      />
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(hero);
    document.body.append(container);
    const image = within(container).getByTestId("lead-media-image");
    Object.defineProperty(image, "complete", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 0,
    });
    let root: Root | undefined;

    try {
      await act(async () => {
        root = hydrateRoot(container, hero);
      });

      expect(
        within(container).getByTestId("lead-media-flat"),
      ).toBeInTheDocument();
      expect(within(container).queryByTestId("lead-media-image")).toBeNull();
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
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
    expectVisibleActionFocus();
    expect(screen.getByText(/Street View unavailable/)).toBeVisible();
  });

  it("keeps linked hero actions visibly focused without clipping their pill", () => {
    render(
      <LeadMediaHero
        {...shared}
        actions={
          <>
            <a href="https://example.com">Zillow</a>
            <span className="overflow-hidden">
              <Link href="/leads/previous">Previous</Link>
              <Link href="/leads/next">Next</Link>
            </span>
          </>
        }
        media={{
          kind: "aerial",
          images: aerialImages,
          resolvedBy: "address",
          fallbackReason: "no-coverage",
        }}
      />,
    );

    expectVisibleActionFocus();
    const previous = screen.getByRole("link", { name: "Previous" });
    previous.focus();
    expect(previous).toHaveFocus();
    expect(previous.parentElement).toHaveClass("overflow-hidden");
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
