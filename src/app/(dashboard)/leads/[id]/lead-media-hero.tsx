"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { LeadMediaPresentation } from "./lead-media";

const actionFocusClasses =
  "[&_button]:focus-visible:ring-white [&_button]:focus-visible:ring-offset-2 [&_button]:focus-visible:ring-offset-slate-950 [&_a]:rounded-md [&_a]:outline-none [&_a]:focus-visible:ring-2 [&_a]:focus-visible:ring-white [&_a]:focus-visible:ring-offset-2 [&_a]:focus-visible:ring-offset-slate-950 [&>span]:focus-within:overflow-visible";

type MediaKind = "loading" | "flat" | "streetView" | "aerial";
type MediaState = { kind: MediaKind; fallbackReason?: string };
const MediaKindContext = createContext<((state: MediaState) => void) | null>(null);
const imageFrameClasses = "relative h-[210px] overflow-hidden bg-slate-900 sm:h-[230px] lg:h-[250px]";

export function LeadMediaLoading() {
  return <div className={imageFrameClasses} data-testid="lead-media-image-frame" aria-label="Loading property imagery" aria-busy="true" />;
}

export function LeadMediaHero({
  media, children, address, locationLine, homeownerName, actions,
}: {
  media?: LeadMediaPresentation;
  children?: React.ReactNode;
  address: string;
  locationLine: string;
  homeownerName: string | null;
  actions: React.ReactNode;
}) {
  const [resolvedMedia, setResolvedMedia] = useState<MediaState | null>(null);
  const kind = resolvedMedia?.kind ?? media?.kind ?? "loading";
  const flat = kind === "flat";
  const description = [locationLine, homeownerName].filter(Boolean).join(" · ");

  // Keep this header and every action mounted while the imagery slot streams
  // or falls back. Drafts and open dialogs must survive a media transition.
  return (
    <MediaKindContext.Provider value={setResolvedMedia}>
      <section
        className={flat ? "border-border bg-card border-b" : "relative isolate overflow-hidden border-b border-white/10 bg-slate-900"}
        data-testid={`lead-media-${kind === "streetView" ? "street-view" : kind}`}
        data-media-fallback-reason={resolvedMedia?.fallbackReason ?? (media?.kind === "aerial" ? media.fallbackReason : undefined)}
      >
        {media ? <LeadMediaVisual media={media} address={address} /> : children}
        <div
          className={flat
            ? "relative z-10 flex flex-col gap-3 px-4 py-3.5 md:px-6 lg:flex-row lg:items-end lg:justify-between"
            : "relative z-10 flex flex-col gap-3 bg-gradient-to-b from-slate-900 to-slate-950 px-4 py-3.5 text-white sm:px-6 lg:flex-row lg:items-end lg:justify-between"}
          data-testid="lead-media-overlay"
        >
          <div className="min-w-0 max-w-3xl">
            <nav aria-label="Breadcrumb" className={`mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold tracking-widest uppercase ${flat ? "text-muted-foreground" : "text-white/75"}`}>
              <span>Workspace</span><span aria-hidden>/</span>
              <Link href="/leads" className={flat ? "hover:text-foreground" : "transition-colors hover:text-white"}>Leads</Link>
              <span aria-hidden>/</span>
              <span className={`break-words ${flat ? "text-foreground" : "text-white"}`}>{address}</span>
            </nav>
            <h1 className={flat
              ? "text-2xl leading-tight font-bold tracking-[-0.02em] break-words"
              : "text-2xl leading-tight font-black tracking-[-0.03em] break-words text-white sm:text-3xl"}>{address}</h1>
            <p className={flat ? "text-muted-foreground mt-1 text-[13px] break-words" : "mt-1 text-sm break-words text-white/80"}>
              {description || "—"}{flat ? " · Street View unavailable" : null}
            </p>
          </div>
          <div
            className={`flex min-w-0 flex-wrap items-center gap-2 [&_button]:min-h-9 ${flat
              ? "[&_[data-testid=call-lead-button]]:border-slate-900 [&_[data-testid=call-lead-button]]:bg-slate-900 [&_[data-testid=call-lead-button]]:text-white"
              : "[&_button]:border-white/80 [&_button]:bg-white/95 [&_button]:text-slate-950 [&_button]:shadow-sm [&_button]:hover:bg-white"} ${actionFocusClasses}`}
            data-testid="lead-media-actions"
          >{actions}</div>
        </div>
      </section>
    </MediaKindContext.Provider>
  );
}

export function LeadMediaVisual({ media, address }: { media: LeadMediaPresentation; address: string }) {
  const reportKind = useContext(MediaKindContext);
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

  const fallbackReason = renderedKind === "aerial"
    ? media.kind === "aerial" ? media.fallbackReason : "street-image-error"
    : undefined;
  useEffect(() => {
    reportKind?.({ kind: renderedKind, fallbackReason });
  }, [reportKind, renderedKind, fallbackReason]);

  if (renderedKind === "flat") return null;

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
  if (!renderedImages) return null;

  const mediaLabel =
    renderedKind === "streetView"
      ? `Street View of ${address}`
      : `Aerial view of ${address}`;

  return (
    <section
      className="relative"
      data-media-fallback-reason={
        renderedKind === "aerial"
          ? media.kind === "aerial"
            ? media.fallbackReason
            : "street-image-error"
          : undefined
      }
      aria-label={mediaLabel}
    >
      <div
        className={imageFrameClasses}
        data-testid="lead-media-image-frame"
      >
        <picture className="block h-full bg-slate-900" data-testid="lead-media-picture">
        <source media="(min-width: 1792px)" srcSet={renderedImages.ultra} />
        <source
          media="(min-width: 1536px)"
          srcSet={renderedImages.extraLarge}
        />
        <source media="(min-width: 1440px)" srcSet={renderedImages.large} />
        <source media="(min-width: 1280px)" srcSet={renderedImages.wide} />
        <source media="(min-width: 1024px)" srcSet={renderedImages.desktop} />
        <source media="(min-width: 768px)" srcSet={renderedImages.tablet} />
        <source
          media="(min-width: 640px)"
          srcSet={renderedImages.smallTablet}
        />
        <source media="(min-width: 390px)" srcSet={renderedImages.mobile} />
        {/* Responsive sources are intentionally taller than this frame. Keep
            the image bottom-aligned so full-bleed trimming affects only the
            top of the scene, never Google's bottom attribution edges. */}
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
      {process.env.VERCEL_ENV === "preview" &&
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
    </section>
  );
}
