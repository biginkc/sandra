import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 50;

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
      "id, address, city, state, zip, market, status, cass_status, is_vacant, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : from + 1;
  const showingTo = Math.min(to + 1, total);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Properties</h1>
          <p className="text-muted-foreground text-sm">
            {total === 0
              ? "No properties yet. Import a CSV to get started."
              : `Showing ${showingFrom}–${showingTo} of ${total} propert${total === 1 ? "y" : "ies"}.`}
          </p>
        </div>
        <Link href="/import" className={buttonVariants()}>
          Import CSV
        </Link>
      </div>

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load properties: {error.message}
        </div>
      ) : null}

      <div className="border-border rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead>City</TableHead>
              <TableHead>State</TableHead>
              <TableHead>ZIP</TableHead>
              <TableHead>Market</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>CASS</TableHead>
              <TableHead>Vacant</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {properties && properties.length > 0 ? (
              properties.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.address}</TableCell>
                  <TableCell>{p.city ?? "—"}</TableCell>
                  <TableCell>{p.state}</TableCell>
                  <TableCell>{p.zip ?? "—"}</TableCell>
                  <TableCell>{p.market ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{p.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        p.cass_status === "verified" ? "default" : "secondary"
                      }
                    >
                      {p.cass_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {p.is_vacant === true
                      ? "Yes"
                      : p.is_vacant === false
                        ? "No"
                        : "—"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-muted-foreground py-8 text-center"
                >
                  No properties yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

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
