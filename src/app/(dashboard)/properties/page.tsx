import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

export default async function PropertiesPage() {
  const supabase = await createClient();
  const { data: properties, error } = await supabase
    .from("properties")
    .select(
      "id, address, city, state, zip, market, status, cass_status, is_vacant, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Properties</h1>
          <p className="text-muted-foreground text-sm">
            {properties?.length
              ? `Showing the latest ${properties.length} properties.`
              : "No properties yet. Import a CSV to get started."}
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
    </div>
  );
}
