"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { callAction } from "@/lib/errors/call-action";

import { qualifyLead, qualifyLeadsBulk } from "../leads/actions";

export type ProspectRow = {
  id: string;
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
  cass_status: string;
  is_vacant: boolean | null;
  created_at: string;
};

type Props = {
  prospects: ProspectRow[];
};

export function ProspectsTable({ prospects }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const allSelected = useMemo(
    () => prospects.length > 0 && selected.size === prospects.length,
    [selected.size, prospects.length],
  );
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => {
    setSelected((prev) => {
      if (prev.size === prospects.length) return new Set();
      return new Set(prospects.map((p) => p.id));
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleQualifySelected = () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    startTransition(async () => {
      const result = await callAction(qualifyLeadsBulk(ids), {
        fallbackMessage: "Could not qualify selected prospects",
      });
      if (result.ok) {
        const { qualified, alreadyQualified, failed } = result.data;
        const parts: string[] = [];
        if (qualified > 0)
          parts.push(`Qualified ${qualified} prospect${qualified === 1 ? "" : "s"}`);
        if (alreadyQualified > 0)
          parts.push(`${alreadyQualified} already qualified`);
        if (failed.length > 0)
          parts.push(`${failed.length} failed`);
        const { toast } = await import("sonner");
        const summary = parts.join(" · ") || "Done";
        if (failed.length > 0) {
          toast.warning(summary, {
            description: failed[0].message,
          });
        } else {
          toast.success(summary);
        }
        // Keep failed rows selected so the VA can retry; drop the ones
        // that succeeded or were already qualified.
        const failedIds = new Set(failed.map((f) => f.propertyId));
        setSelected(failedIds);
        router.refresh();
      }
    });
  };

  const handleQualifyOne = (id: string, address: string) => {
    startTransition(async () => {
      const result = await callAction(qualifyLead(id), {
        successMessage: `Qualified ${address}`,
        fallbackMessage: `Could not qualify ${address}`,
      });
      if (result.ok) {
        setSelected((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center gap-2">
        {selected.size > 0 ? (
          <>
            <Button
              onClick={handleQualifySelected}
              disabled={pending}
              size="sm"
            >
              {pending
                ? "Qualifying…"
                : `Qualify selected (${selected.size})`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={pending}
            >
              Clear
            </Button>
          </>
        ) : (
          <div className="text-muted-foreground text-sm">
            Select prospects to qualify them into the leads pipeline.
          </div>
        )}
      </div>

      <div className="border-border rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all prospects on this page"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  className="size-4 cursor-pointer"
                />
              </TableHead>
              <TableHead>Address</TableHead>
              <TableHead>City</TableHead>
              <TableHead>State</TableHead>
              <TableHead>ZIP</TableHead>
              <TableHead>Market</TableHead>
              <TableHead>CASS</TableHead>
              <TableHead>Vacant</TableHead>
              <TableHead className="w-28 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prospects.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-muted-foreground py-8 text-center"
                >
                  No prospects. Import a CSV to fill the data lake.
                </TableCell>
              </TableRow>
            ) : (
              prospects.map((p) => {
                const isChecked = selected.has(p.id);
                return (
                  <TableRow
                    key={p.id}
                    data-selected={isChecked}
                    className="hover:bg-muted/50 cursor-pointer data-[selected=true]:bg-muted/40"
                    onClick={() => router.push(`/leads/${p.id}`)}
                  >
                    <TableCell
                      onClick={(e) => e.stopPropagation()}
                      className="cursor-default"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.address}`}
                        checked={isChecked}
                        onChange={() => toggleOne(p.id)}
                        className="size-4 cursor-pointer"
                      />
                    </TableCell>
                    <TableCell className="font-medium">{p.address}</TableCell>
                    <TableCell>{p.city ?? "—"}</TableCell>
                    <TableCell>{p.state}</TableCell>
                    <TableCell>{p.zip ?? "—"}</TableCell>
                    <TableCell>{p.market ?? "—"}</TableCell>
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
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => handleQualifyOne(p.id, p.address)}
                      >
                        Qualify
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
