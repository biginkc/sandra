import { Page } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

import {
  DEFAULT_COLLAPSED_STATUSES,
  STATUS_ACCENT,
  STATUS_LABEL,
  STATUS_ORDER,
} from "./board-config";

export default function LeadsLoading() {
  return (
    <Page>
      <header className="flex flex-col gap-2">
        <div className="text-muted-foreground text-[10px] font-bold tracking-widest uppercase">
          Workspace / <span className="text-foreground">Leads</span>
        </div>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-bold tracking-[-0.02em]">Leads</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Drag to move leads through the pipeline.
            </p>
          </div>
          <Skeleton className="h-11 w-32 rounded-full" />
        </div>
      </header>

      <div className="border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3">
        <Skeleton className="h-10 min-w-52 flex-1 rounded-full sm:max-w-md" />
        <Skeleton className="h-8 w-48 rounded-full" />
        <Skeleton className="h-8 w-36 rounded-full" />
      </div>

      <div className="flex gap-3 overflow-x-auto pb-3" aria-label="Loading leads">
        {STATUS_ORDER.map((status) => {
          const collapsed = DEFAULT_COLLAPSED_STATUSES.includes(status);
          if (collapsed) {
            return (
              <div
                key={status}
                className={`bg-muted/30 flex min-h-[60vh] w-10 shrink-0 flex-col items-center rounded-lg border border-t-4 ${STATUS_ACCENT[status]}`}
              >
                <div
                  className="text-muted-foreground mt-10 text-xs font-semibold tracking-wide whitespace-nowrap"
                  style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                >
                  {STATUS_LABEL[status]}
                </div>
              </div>
            );
          }

          return (
            <div
              key={status}
              className={`bg-muted/30 flex min-h-[60vh] w-72 shrink-0 flex-col rounded-lg border border-t-4 ${STATUS_ACCENT[status]}`}
            >
              <div className="flex items-center justify-between px-3 py-3">
                <span className="text-sm font-semibold">{STATUS_LABEL[status]}</span>
                <Skeleton className="h-5 w-7 rounded-full" />
              </div>
              <div className="flex flex-col gap-2 p-2">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="border-border bg-card rounded-md border p-3 shadow-sm"
                  >
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="mt-2 h-3 w-5/6" />
                    <div className="mt-4 flex gap-2">
                      <Skeleton className="h-5 w-14 rounded-full" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                    <Skeleton className="mt-3 h-3 w-full" />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
