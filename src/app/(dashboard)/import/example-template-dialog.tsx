"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  copyToClipboard,
  downloadCsv,
  rowsToCsv,
} from "@/lib/csv/export";
import type { SubOperationModule } from "@/lib/csv/update-operations";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subOperation: SubOperationModule | null;
};

export function ExampleTemplateDialog({
  open,
  onOpenChange,
  subOperation,
}: Props) {
  const [copying, setCopying] = useState(false);

  if (!subOperation) return null;

  const headers = [
    ...subOperation.requiredColumns,
    ...subOperation.optionalColumns,
  ];

  const handleCopy = async () => {
    setCopying(true);
    const ok = await copyToClipboard(headers.join(","));
    setCopying(false);
    if (ok) toast.success("Headers copied — paste into row 1 of your sheet.");
    else toast.error("Couldn't copy. Select the headers and copy manually.");
  };

  const handleDownload = () => {
    const csv = rowsToCsv(subOperation.exampleRows, headers);
    downloadCsv(`${subOperation.id}-example.csv`, csv);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{subOperation.label} — example template</DialogTitle>
          <DialogDescription>
            Required columns:{" "}
            <code className="text-foreground font-mono">
              {subOperation.requiredColumns.join(", ")}
            </code>
            {subOperation.optionalColumns.length > 0 && (
              <>
                {" "}
                · optional:{" "}
                <code className="text-muted-foreground font-mono">
                  {subOperation.optionalColumns.join(", ")}
                </code>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {headers.map((h) => (
                  <TableHead key={h}>{h}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {subOperation.exampleRows.map((row, i) => (
                <TableRow key={i}>
                  {headers.map((h) => (
                    <TableCell key={h} className="font-mono text-xs">
                      {row[h] ?? ""}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCopy} disabled={copying}>
            {copying ? "Copying…" : "Copy headers"}
          </Button>
          <Button onClick={handleDownload}>Download example.csv</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
