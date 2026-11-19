"use client";

import { Suspense } from "react";
import Link from "next/link";

import type { LeadMediaPresentation } from "./lead-media";
import {
  LeadMediaImage,
  LeadMediaImagePlaceholder,
} from "./lead-media-image";

const actionFocusClasses =
  "[&_button]:focus-visible:ring-white [&_button]:focus-visible:ring-offset-2 [&_button]:focus-visible:ring-offset-slate-950 [&_a]:rounded-md [&_a]:outline-none [&_a]:focus-visible:ring-2 [&_a]:focus-visible:ring-white [&_a]:focus-visible:ring-offset-2 [&_a]:focus-visible:ring-offset-slate-950 [&>span]:focus-within:overflow-visible";

type LeadMediaHeroProps = {
  /** Kept for callers that already resolved media before rendering the hero. */
  media?: LeadMediaPresentation;
  /** Server-resolved imagery can stream into this stable client shell. */
  mediaSlot?: React.ReactNode;
  address: string;
  locationLine: string;
  homeownerName: string | null;
  /** The "Owns N houses" badge, shown after the homeowner's name. */
  ownerBadge?: React.ReactNode;
  collectionHref?: "/leads" | "/properties" | "/my-leads";
  collectionLabel?: "Leads" | "Search" | "My Leads";
  actions: React.ReactNode;
};

export function LeadMediaHero({
  media,
  mediaSlot,
  address,
  locationLine,
  homeownerName,
  ownerBadge,
  collectionHref = "/leads",
  collectionLabel = "Leads",
  actions,
}: LeadMediaHeroProps) {
  const description = [locationLine, homeownerName].filter(Boolean).join(" · ");

  if (media?.kind === "flat" && !mediaSlot) {
    return (
      <section
        className="border-border bg-card border-b px-4 py-3.5 md:px-6"
        data-testid="lead-media-flat"
      >
        <nav
          aria-label="Breadcrumb"
          className="text-muted-foreground mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold tracking-[0.16em] uppercase"
        >
          <span>Workspace</span>
          <span aria-hidden>/</span>
          <Link href={collectionHref} className="hover:text-foreground">
            {collectionLabel}
          </Link>
          <span aria-hidden>/</span>
          <span className="text-foreground break-words">{address}</span>
        </nav>
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-3.5">
          <div className="min-w-0">
            <h1 className="text-2xl leading-tight font-bold tracking-[-0.02em] break-words">
              {address}
            </h1>
            <p className="text-muted-foreground mt-1 text-[13px] break-words">
              {description || "—"}
              {ownerBadge ? (
                <span className="ml-1.5 inline-flex align-middle">{ownerBadge}</span>
              ) : null}
              {" "}· Street View unavailable
            </p>
          </div>
          <HeroActions
            actions={actions}
            variant="flat"
            className="[&_[data-testid=call-lead-button]]:border-slate-900 [&_[data-testid=call-lead-button]]:bg-slate-900 [&_[data-testid=call-lead-button]]:text-white"
          />
        </div>
      </section>
    );
  }

  const mediaContent = mediaSlot ? (
    <Suspense fallback={<LeadMediaImagePlaceholder />}>
      {mediaSlot}
    </Suspense>
  ) : media ? (
    <LeadMediaImage media={media} address={address} />
  ) : (
    <LeadMediaImagePlaceholder />
  );

  const mediaLabel =
    media?.kind === "streetView"
      ? `Street View of ${address}`
      : media?.kind === "aerial"
        ? `Aerial view of ${address}`
        : `Lead media for ${address}`;

  return (
    <section
      className="relative isolate overflow-hidden border-b border-white/10 bg-slate-900"
      data-testid="lead-media-hero"
      aria-label={mediaLabel}
    >
      {mediaContent}
      <div
        className="relative z-10 flex flex-col gap-3 bg-gradient-to-b from-slate-900 to-slate-950 px-4 py-3.5 text-white sm:px-6 lg:flex-row lg:items-end lg:justify-between"
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
              href={collectionHref}
              className="transition-colors hover:text-white"
            >
              {collectionLabel}
            </Link>
            <span aria-hidden>/</span>
            <span className="break-words text-white">{address}</span>
          </nav>
          <h1 className="text-2xl leading-tight font-black tracking-[-0.03em] break-words text-white sm:text-3xl">
            {address}
          </h1>
          <p className="mt-1 text-sm break-words text-white/80">
            {description || "—"}
            {ownerBadge ? (
              <span className="ml-1.5 inline-flex align-middle">{ownerBadge}</span>
            ) : null}
          </p>
        </div>
        <HeroActions actions={actions} variant="image" />
      </div>
    </section>
  );
}

function HeroActions({
  actions,
  variant,
  className = "",
}: {
  actions: React.ReactNode;
  variant: "flat" | "image";
  className?: string;
}) {
  const imageClasses =
    variant === "image"
      ? "[&_:is(button,a)]:border-white/80 [&_:is(button,a)]:bg-white/95 [&_:is(button,a)]:dark:bg-white/95 [&_:is(button,a)]:text-slate-950 [&_:is(button,a)]:hover:text-slate-950 [&_:is(button,a)]:aria-expanded:text-slate-950 [&_:is(button,a)]:aria-expanded:bg-white [&_:is(button,a)]:shadow-sm [&_:is(button,a)]:hover:bg-white [&_:is(button,a)]:dark:hover:bg-white"
      : "";

  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-2 [&_:is(button,a)]:min-h-9 ${imageClasses} ${className} ${actionFocusClasses}`}
      data-testid="lead-media-actions"
      role="group"
      aria-label="Lead actions"
    >
      {actions}
    </div>
  );
}
