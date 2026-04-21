"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { WizardAction, WizardState } from "../wizard";

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepReview({ state }: Props) {
  const summary = state.summary;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Validation summary</CardTitle>
          <CardDescription>
            {summary
              ? `${summary.totalRows} rows · ${summary.validRows} valid · ${summary.invalidRows} invalid · ${summary.emptyRows} empty`
              : "No validation run yet."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {summary &&
              Object.entries(summary.errorsByRule).map(([rule, count]) => (
                <Badge key={rule} variant="secondary">
                  {rule}: {count}
                </Badge>
              ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview (first 10 rows)</CardTitle>
          <CardDescription>
            Each row shows validation status and the first error, if any.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border-border rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[70px]">Status</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Error (if any)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.previewRows.map((r) => (
                  <TableRow key={r.rowIndex}>
                    <TableCell>
                      <Badge variant={r.ok ? "default" : "destructive"}>
                        {r.ok ? "valid" : "error"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {String(r.normalized.address ?? "—")}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {r.errors[0]?.message ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
                {state.previewRows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-muted-foreground py-6 text-center"
                    >
                      No rows to preview.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
