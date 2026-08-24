"use client";

import { useState } from "react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";

import type { LeadMediaPresentation } from "./lead-media";

export function LeadMediaHero({
  media,
  address,
  locationLine,
  homeownerName,
  actions,
}: {
  media: LeadMediaPresentation;
  address: string;
  locationLine: string;
  homeownerName: string | null;
  actions: React.ReactNode;
}) {
  const description = [locationLine, homeownerName].filter(Boolean).join(" · ");
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

  if (renderedKind === "flat") {
    return (
      <div className="px-4 pt-6 md:px-6 md:pt-8" data-testid="lead-media-flat">
        <PageHeader
          breadcrumb={[
            { label: "Workspace" },
            { label: "Leads", href: "/leads" },
            { label: address },
          ]}
          title={address}
          description={description || "—"}
          actions={
            <div className="flex min-w-0 flex-wrap items-center gap-2 [&_button]:min-h-9">
              {actions}
            </div>
          }
        />
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
  if (!renderedImages) return null;

  const mediaLabel =
    renderedKind === "streetView"
      ? `Street View of ${address}`
      : `Aerial view of ${address}`;

  return (
    <section
      className="relative isolate min-h-[210px] overflow-hidden bg-slate-900 sm:min-h-[230px] lg:min-h-[250px]"
      data-testid={`lead-media-${renderedKind === "streetView" ? "street-view" : "aerial"}`}
      data-media-fallback-reason={
        renderedKind === "aerial"
          ? media.kind === "aerial"
            ? media.fallbackReason
            : "street-image-error"
          : undefined
      }
      aria-label={mediaLabel}
    >
      <picture>
        <source media="(min-width: 1440px)" srcSet={renderedImages.large} />
        <source media="(min-width: 1280px)" srcSet={renderedImages.wide} />
        <source media="(min-width: 1024px)" srcSet={renderedImages.desktop} />
        <source media="(min-width: 768px)" srcSet={renderedImages.tablet} />
        <source
          media="(min-width: 640px)"
          srcSet={renderedImages.smallTablet}
        />
        <source media="(min-width: 390px)" srcSet={renderedImages.mobile} />
        {/* Google returns a complete, attributed image. Keep it unproxied and
            uncropped so the signed URL and baked attribution remain intact. */}
        <img
          src={renderedImages.small}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full bg-slate-900 object-contain object-bottom"
          loading="eager"
          fetchPriority="high"
          referrerPolicy="strict-origin-when-cross-origin"
          draggable={false}
          data-testid="lead-media-image"
          onError={() =>
            setFailureState({
              mediaIdentity,
              failedImage:
                renderedKind === "streetView" && failedImage === null
                  ? "streetView"
                  : "aerial",
            })
          }
        />
      </picture>
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
      <div
        className="pointer-events-none absolute inset-x-0 bottom-9 h-44 bg-gradient-to-t from-slate-950/90 via-slate-950/65 to-transparent"
        aria-hidden
      />
      <div
        className="pointer-events-none relative z-10 flex min-h-[210px] flex-col justify-end gap-4 px-4 pt-20 pb-12 text-white sm:min-h-[230px] sm:px-6 lg:min-h-[250px] lg:flex-row lg:items-end lg:justify-between"
        data-testid="lead-media-overlay"
      >
        <div className="min-w-0 max-w-3xl">
          <nav
            aria-label="Breadcrumb"
            className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold tracking-widest text-white/75 uppercase"
          >
            <span>Workspace</span>
            <span aria-hidden>/</span>
            <Link
              href="/leads"
              className="pointer-events-auto transition-colors hover:text-white"
            >
              Leads
            </Link>
            <span aria-hidden>/</span>
            <span className="break-words text-white">{address}</span>
          </nav>
          <h1 className="text-2xl leading-tight font-black tracking-[-0.03em] break-words text-white sm:text-3xl">
            {address}
          </h1>
          <p className="mt-1 text-sm break-words text-white/80">
            {description || "—"}
          </p>
        </div>
        <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2 [&_button]:min-h-9 [&_button]:shadow-sm">
          {actions}
        </div>
      </div>
    </section>
  );
}
