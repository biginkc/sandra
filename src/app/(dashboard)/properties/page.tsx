import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { ProspectsTable, type ProspectRow } from "./prospects-table";

const PAGE_SIZE = 50;

export const metadata = {
  title: "Prospects · Sandra CRM",
};

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const rawPage = Number(params.page ?? 1);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supabase = await createClient();
  const { data: properties, count, error } = await supabase
    .from("properties")
    .select(
      "id, address, city, state, zip, market, cass_status, is_vacant, created_at",
      { count: "exact" },
    )
    .eq("status", "prospect")
    .order("created_at", { ascending: false })
    .range(from, to);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : from + 1;
  const showingTo = Math.min(to + 1, total);

  const prospects: ProspectRow[] = (properties ?? []).map((p) => ({
    id: p.id,
    address: p.address,
    city: p.city,
    state: p.state,
    zip: p.zip,
    market: p.market,
    cass_status: p.cass_status,
    is_vacant: p.is_vacant,
    created_at: p.created_at,
  }));

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Prospects</h1>
          <p className="text-muted-foreground text-sm">
            {total === 0
              ? "No prospects yet. Import a CSV to fill the data lake."
              : `Showing ${showingFrom}–${showingTo} of ${total} prospect${total === 1 ? "" : "s"}. Qualify a prospect to move it into the leads pipeline.`}
          </p>
        </div>
        <Link href="/import" className={buttonVariants()}>
          Import CSV
        </Link>
      </div>

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load prospects: {error.message}
        </div>
      ) : null}

      <ProspectsTable prospects={prospects} />

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={`/properties?page=${page - 1}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                ← Prev
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                ← Prev
              </Button>
            )}
            {page < totalPages ? (
              <Link
                href={`/properties?page=${page + 1}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                Next →
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next →
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
