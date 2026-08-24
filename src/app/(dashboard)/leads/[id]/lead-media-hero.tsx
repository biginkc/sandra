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

  if (media.kind === "flat") {
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

  const mediaLabel =
    media.kind === "streetView"
      ? `Street View of ${address}`
      : `Aerial view of ${address}`;

  return (
    <section
      className="relative isolate min-h-[210px] overflow-hidden bg-slate-900 sm:min-h-[230px] lg:min-h-[250px]"
      data-testid={`lead-media-${media.kind === "streetView" ? "street-view" : "aerial"}`}
      data-media-fallback-reason={
        media.kind === "aerial" ? media.fallbackReason : undefined
      }
      aria-label={mediaLabel}
    >
      <iframe
        title={mediaLabel}
        src={media.embedUrl}
        className="absolute inset-0 h-full w-full border-0"
        loading="eager"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="accelerometer; gyroscope; fullscreen"
        allowFullScreen
      />
      {process.env.VERCEL_ENV === "preview" &&
      media.kind === "aerial" &&
      (media.fallbackReason === "metadata-failure" ||
        media.fallbackReason === "missing-signing-secret") ? (
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
