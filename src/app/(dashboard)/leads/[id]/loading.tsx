import { Page } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

export default function LeadDetailLoading() {
  return (
    <Page className="gap-0 p-0">
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading lead details"
        className="flex min-w-0 flex-col"
      >
        <span className="sr-only">Loading lead details…</span>

        <section
          aria-hidden="true"
          className="border-b border-white/10 bg-slate-900"
        >
          <Skeleton className="h-[210px] rounded-none bg-slate-800 sm:h-[230px] lg:h-[250px]" />
          <div className="flex flex-col gap-3 bg-gradient-to-b from-slate-900 to-slate-950 px-4 py-3.5 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-44 bg-white/20" />
              <Skeleton className="h-8 w-3/4 max-w-xl bg-white/20" />
              <Skeleton className="h-4 w-56 max-w-full bg-white/20" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 w-24 rounded-md bg-white/20" />
              <Skeleton className="h-9 w-28 rounded-md bg-white/20" />
            </div>
          </div>
        </section>

        <section
          aria-hidden="true"
          className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 border-b px-4 pt-3 md:px-6"
        >
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="min-w-0 rounded-[14px] border px-4 py-3"
            >
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </section>

        <section
          aria-hidden="true"
          className="border-b px-4 py-2.5 md:px-6"
        >
          <div className="flex flex-wrap items-center gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton
                key={index}
                className={`h-8 rounded-full ${index === 2 ? "w-36" : "w-24"}`}
              />
            ))}
            <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
          </div>
        </section>

        <section
          aria-hidden="true"
          className="grid min-w-0 items-start gap-[14px] px-4 pt-3.5 pb-7 md:px-6 xl:grid-cols-[minmax(0,1fr)_340px]"
        >
          <div className="min-w-0 space-y-3">
            <div className="border-border bg-card flex min-w-0 flex-col gap-4 rounded-[14px] border p-4">
              <Skeleton className="h-5 w-28" />
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-start gap-3">
                  <Skeleton className="mt-1 h-8 w-8 shrink-0 rounded-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-4 w-3/5" />
                  </div>
                </div>
              ))}
            </div>
            <div className="border-border bg-card flex min-h-24 flex-col gap-3 rounded-[14px] border p-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
            </div>
            <div className="flex min-h-16 flex-col gap-3 rounded-[14px] border p-4">
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          </div>

          <aside className="flex min-w-0 flex-col gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-[14px] border p-3.5"
              >
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ))}
          </aside>
        </section>
      </div>
    </Page>
  );
}
