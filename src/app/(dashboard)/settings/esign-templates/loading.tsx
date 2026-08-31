import { Page } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

import { TemplateLibraryLoading } from "./template-library";

export default function EsignTemplatesLoading() {
  return (
    <Page>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-14 w-full rounded-xl" />
      <TemplateLibraryLoading />
    </Page>
  );
}
