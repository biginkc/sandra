import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeadMediaHero } from "./lead-media-hero";
import { LeadMediaImage } from "./lead-media-image";

const images = {
  small: "https://maps.googleapis.com/maps/api/staticmap?size=320x341",
  mobile: "https://maps.googleapis.com/maps/api/staticmap?size=390x289",
  smallTablet: "https://maps.googleapis.com/maps/api/staticmap?size=640x230",
  tablet: "https://maps.googleapis.com/maps/api/staticmap?size=512x230",
  desktop: "https://maps.googleapis.com/maps/api/staticmap?size=640x230",
  wide: "https://maps.googleapis.com/maps/api/staticmap?size=640x170",
  large: "https://maps.googleapis.com/maps/api/staticmap?size=640x145",
  extraLarge: "https://maps.googleapis.com/maps/api/staticmap?size=640x135",
  ultra: "https://maps.googleapis.com/maps/api/staticmap?size=640x110",
};

const media = {
  kind: "aerial" as const,
  images,
  resolvedBy: "address" as const,
  fallbackReason: "no-coverage" as const,
};

const metadataFailureMedia = {
  ...media,
  fallbackReason: "metadata-failure" as const,
};

describe("lead media image slots", () => {
  it("keeps the hero actions mounted while a Suspense image slot resolves and fails", async () => {
    const deferred = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve, resolved: false };
    })();

    function DeferredMedia() {
      if (!deferred.resolved) throw deferred.promise;
      return <LeadMediaImage media={media} address="123 Main St" />;
    }

    function DraftAction() {
      return <input aria-label="Draft note" defaultValue="" />;
    }

    render(
      <LeadMediaHero
        address="123 Main St"
        locationLine="Kansas City, MO"
        homeownerName="Jamie Seller"
        actions={<DraftAction />}
        mediaSlot={<DeferredMedia />}
      />,
    );

    const draft = screen.getByRole("textbox", { name: "Draft note" });
    fireEvent.change(draft, { target: { value: "keep this draft" } });

    expect(screen.getByTestId("lead-media-image-placeholder")).toBeInTheDocument();

    await act(async () => {
      deferred.resolved = true;
      deferred.resolve();
      await deferred.promise;
    });

    expect(screen.getByTestId("lead-media-image")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Aerial view of 123 Main St" }),
    ).toBe(screen.getByTestId("lead-media-image-frame"));
    expect(screen.getByRole("textbox", { name: "Draft note" })).toBe(draft);
    expect(draft).toHaveValue("keep this draft");

    fireEvent.error(screen.getByTestId("lead-media-image"));

    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Draft note" })).toBe(draft);
    expect(draft).toHaveValue("keep this draft");
  });

  it("keeps image failures inside the media slot", () => {
    render(<LeadMediaImage media={media} address="123 Main St" />);

    fireEvent.error(screen.getByTestId("lead-media-image"));

    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument();
    expect(screen.getByTestId("lead-media-flat")).toHaveAttribute(
      "aria-label",
      "No imagery available for 123 Main St",
    );
    expect(
      screen.getByRole("img", { name: "No imagery available for 123 Main St" }),
    ).toHaveTextContent("Property imagery unavailable");
  });

  it("shows preview metadata guidance only when the server enables it", () => {
    const { rerender } = render(
      <LeadMediaImage
        media={metadataFailureMedia}
        address="123 Main St"
        showPreviewMisconfiguration
      />,
    );

    expect(
      screen.getByTestId("lead-media-preview-misconfiguration"),
    ).toHaveTextContent("Street View metadata unavailable");

    rerender(
      <LeadMediaImage
        media={metadataFailureMedia}
        address="123 Main St"
        showPreviewMisconfiguration={false}
      />,
    );

    expect(
      screen.queryByTestId("lead-media-preview-misconfiguration"),
    ).not.toBeInTheDocument();
  });
});
