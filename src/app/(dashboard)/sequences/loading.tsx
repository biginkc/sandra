import { Page } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

export default function DripsLoading() {
  return <Page><Skeleton className="h-10 w-40" /><div className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map((n) => <Skeleton key={n} className="h-28 rounded-2xl" />)}</div><Skeleton className="h-72 rounded-2xl" /></Page>;
}
