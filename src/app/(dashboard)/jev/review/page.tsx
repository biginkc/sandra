import Link from "next/link";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { getReviewJevData } from "../queries";
import { ReviewList } from "./review-list";
import { ReviewSummary } from "./review-summary";

export const dynamic = "force-dynamic";

function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export default async function ReviewJevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const { items, summary, hasMore, error } = await getReviewJevData(page);

  return (
    <Page>
      <PageHeader
        title="Review Jev"
        description="Every recent decision — applied, held, superseded, or a classification failure/unclear with no decision made — with confidence, threshold, model/rubric version, and correction history. Review cadence never blocks automatic applies; this is audit, not a gate."
      />
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive" data-testid="jev-review-error">
          Could not load Review Jev: {error}
        </p>
      ) : (
        <>
          <ReviewSummary summary={summary} />
          <ReviewList items={items} />
          <div className="flex items-center justify-between text-sm">
            {page > 0 ? (
              <Link href={`/jev/review?page=${page - 1}`} className="text-primary underline" data-testid="jev-review-prev-page">
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            {hasMore && (
              <Link href={`/jev/review?page=${page + 1}`} className="text-primary underline" data-testid="jev-review-next-page">
                Older →
              </Link>
            )}
          </div>
        </>
      )}
    </Page>
  );
}
