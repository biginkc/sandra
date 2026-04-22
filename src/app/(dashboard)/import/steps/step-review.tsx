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

// User-facing labels for warning rule keys. Keys are produced by
// `computeContactWarningRules()` in src/lib/csv/validate.ts.
const WARNING_LABELS: Record<string, string> = {
  no_contact: "No contact info",
  no_phone: "No phone",
  no_mailing_address: "No separate mailing address",
};

const WARNING_HINTS: Record<string, string> = {
  no_contact:
    "Nothing to call, text, or personalize — these rows become mail-only leads.",
  no_phone:
    "Owner info exists but no phone — can't call or SMS these rows.",
  no_mailing_address:
    "Direct mail will go to the property address. If the property is vacant, the mailer may bounce.",
};

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
        <CardContent className="flex flex-col gap-3">
          {summary && Object.keys(summary.errorsByRule).length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Errors (block import)
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.errorsByRule).map(([rule, count]) => (
                  <Badge key={rule} variant="secondary">
                    {rule}: {count}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {summary && Object.keys(summary.warningsByRule).length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Warnings (import still proceeds)
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.warningsByRule).map(([rule, count]) => (
                  <Badge key={rule} variant="outline" title={WARNING_HINTS[rule] ?? ""}>
                    {WARNING_LABELS[rule] ?? rule}: {count}
                  </Badge>
                ))}
              </div>
            </div>
          )}
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
