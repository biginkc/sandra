import { Page } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

export default function NeedsPersonLoading() {
  return <Page><Skeleton className="h-10 w-52" />{[0, 1, 2].map((n) => <Skeleton key={n} className="h-48 rounded-2xl" />)}</Page>;
}
