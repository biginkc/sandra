"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LeadMediaPresentation } from "./lead-media";

export function LeadMediaImagePlaceholder() {
  return (
    <div
      className="relative h-[210px] overflow-hidden bg-slate-900 sm:h-[230px] lg:h-[250px]"
      data-testid="lead-media-image-placeholder"
      aria-hidden="true"
    />
  );
}

export function LeadMediaImage({
  media,
  address,
  showPreviewMisconfiguration = false,
}: {
  media: LeadMediaPresentation;
  address: string;
  showPreviewMisconfiguration?: boolean;
}) {
  const mediaIdentity =
    media.kind === "flat" ? `flat:${media.reason}` : media.images.small;
  const [failureState, setFailureState] = useState<{
    mediaIdentity: string;
    failedImage: "streetView" | "aerial" | null;
  }>({ mediaIdentity, failedImage: null });
  const failedImage =
    failureState.mediaIdentity === mediaIdentity
      ? failureState.failedImage
      : null;

  const renderedKind =
    media.kind === "flat"
      ? "flat"
      : media.kind === "streetView" && failedImage === null
        ? "streetView"
        : failedImage === "aerial"
          ? "flat"
          : "aerial";
  const imageRef = useRef<HTMLImageElement | null>(null);
  const reconcileImageFailure = useCallback(() => {
    setFailureState((current) => {
      const failedImageForCurrentRender =
        renderedKind === "streetView" ? "streetView" : "aerial";

      if (
        current.mediaIdentity === mediaIdentity &&
        current.failedImage === failedImageForCurrentRender
      ) {
        return current;
      }

      return {
        mediaIdentity,
        failedImage: failedImageForCurrentRender,
      };
    });
  }, [mediaIdentity, renderedKind]);

  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth === 0) {
      reconcileImageFailure();
    }
  }, [mediaIdentity, reconcileImageFailure, renderedKind]);

  if (renderedKind === "flat") {
    return (
      <div
        className="flex h-[210px] items-center justify-center bg-slate-900 px-4 text-sm text-white/70 sm:h-[230px] lg:h-[250px]"
        data-testid="lead-media-flat"
        role="img"
        aria-label={`No imagery available for ${address}`}
      >
        <span>Property imagery unavailable</span>
      </div>
    );
  }

  const renderedImages =
    renderedKind === "streetView"
      ? media.kind === "streetView"
        ? media.images
        : null
      : media.kind === "streetView"
        ? media.aerialImages
        : media.kind === "aerial"
          ? media.images
          : null;
  if (!renderedImages) return <LeadMediaImagePlaceholder />;

  const mediaLabel =
    renderedKind === "streetView"
      ? `Street View of ${address}`
      : `Aerial view of ${address}`;

  return (
    <div
      className="relative isolate overflow-hidden bg-slate-900"
      data-testid={`lead-media-${renderedKind === "streetView" ? "street-view" : "aerial"}`}
      data-media-fallback-reason={
        renderedKind === "aerial"
          ? media.kind === "aerial"
            ? media.fallbackReason
            : "street-image-error"
          : undefined
      }
    >
      <div
        className="relative h-[210px] overflow-hidden bg-slate-900 sm:h-[230px] lg:h-[250px]"
        data-testid="lead-media-image-frame"
        role="img"
        aria-label={mediaLabel}
      >
        <picture className="block h-full bg-slate-900" data-testid="lead-media-picture">
          <source media="(min-width: 1792px)" srcSet={renderedImages.ultra} />
          <source media="(min-width: 1536px)" srcSet={renderedImages.extraLarge} />
          <source media="(min-width: 1440px)" srcSet={renderedImages.large} />
          <source media="(min-width: 1280px)" srcSet={renderedImages.wide} />
          <source media="(min-width: 1024px)" srcSet={renderedImages.desktop} />
          <source media="(min-width: 768px)" srcSet={renderedImages.tablet} />
          <source media="(min-width: 640px)" srcSet={renderedImages.smallTablet} />
          <source media="(min-width: 390px)" srcSet={renderedImages.mobile} />
          {/* Keep the image bottom-aligned so full-bleed trimming affects only
              the top of the scene, never Google's bottom attribution edges. */}
          <img
            ref={imageRef}
            src={renderedImages.small}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full bg-slate-900 object-cover object-bottom"
            loading="eager"
            fetchPriority="high"
            referrerPolicy="strict-origin-when-cross-origin"
            draggable={false}
            data-testid="lead-media-image"
            onError={reconcileImageFailure}
          />
        </picture>
      </div>
      {showPreviewMisconfiguration &&
      media.kind === "aerial" &&
      media.fallbackReason === "metadata-failure" ? (
        <p
          className="absolute top-2 left-2 z-20 max-w-[calc(100%-1rem)] rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-950 shadow"
          role="status"
          data-testid="lead-media-preview-misconfiguration"
        >
          Street View metadata unavailable — check preview configuration.
        </p>
      ) : null}
    </div>
  );
}
