import { Page } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <Page>
      <div aria-busy="true" aria-label="Loading Overview" className="space-y-6">
        <header className="space-y-2">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-48 max-w-full" />
        </header>

        <Skeleton className="h-24 w-full rounded-2xl" />

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {[0, 1].map((column) => (
            <div
              key={column}
              className="border-border bg-card space-y-4 rounded-2xl border p-5"
            >
              <div className="flex items-center justify-between gap-4">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
              {[0, 1, 2].map((row) => (
                <div key={row} className="space-y-2 rounded-xl border p-4">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Skeleton className="h-11 w-24 rounded-md" />
                    <Skeleton className="h-11 w-24 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((card) => (
            <Skeleton key={card} className="h-28 rounded-2xl" />
          ))}
        </section>
      </div>
    </Page>
  );
}
