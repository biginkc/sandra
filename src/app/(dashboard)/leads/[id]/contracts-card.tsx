"use client";

import { FileSignatureIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { StatusChip, type StatusVariant } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { ContractActions } from "./contract-actions";
import type { ContractActionHandlers, LeadContractRow } from "./esign-types";

type Props = {
  contracts: readonly LeadContractRow[];
  actions: ContractActionHandlers;
  loadError?: string | null;
  onChanged?: () => void;
};

export function ContractsCard({
  contracts,
  actions,
  loadError = null,
  onChanged,
}: Props) {
  return (
    <Card data-testid="lead-contracts-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSignatureIcon className="size-4" aria-hidden />
          Contracts
        </CardTitle>
        <CardDescription>
          Signature requests sent for this lead.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            Contracts did not load. {loadError}
          </div>
        ) : contracts.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="font-semibold">No contracts sent.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Send a contract from this lead to track its status here.
            </p>
          </div>
        ) : (
          <DataTableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Signers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contracts.map((contract) => (
                  <TableRow
                    key={contract.id}
                    data-testid={`contract-row-${contract.id}`}
                  >
                    <TableCell>
                      <div className="font-medium">{contract.templateName}</div>
                      {contract.testMode ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Test mode
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="max-w-64 whitespace-normal">
                        {[...contract.signers]
                          .sort((a, b) => a.order - b.order)
                          .map((signer) => `${signer.role}: ${signer.name}`)
                          .join(" · ")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ContractStatusChip contract={contract} />
                    </TableCell>
                    <TableCell>{formatSentAt(contract.sentAt)}</TableCell>
                    <TableCell className="text-right">
                      <ContractActions
                        contract={contract}
                        actions={actions}
                        onChanged={onChanged}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataTableShell>
        )}
      </CardContent>
    </Card>
  );
}

export function ContractStatusChip({
  contract,
}: {
  contract: LeadContractRow;
}) {
  const presentation = contractStatusPresentation(contract);
  return (
    <StatusChip
      status={presentation.variant}
      label={presentation.label}
      className={presentation.className}
      data-testid={`contract-status-${contract.id}`}
    />
  );
}

function contractStatusPresentation(contract: LeadContractRow): {
  label: string;
  variant: StatusVariant;
  className?: string;
} {
  if (contract.deliveryState === "sending") {
    return { label: "Sending", variant: "cold" };
  }
  if (contract.deliveryState === "send_unknown") {
    return { label: "Send unknown", variant: "hot" };
  }
  if (contract.deliveryState === "failed" || contract.status === "error") {
    return {
      label: "Error",
      variant: "dead",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    };
  }
  if (
    contract.voidRequestedAt &&
    (contract.status === "awaiting" || contract.status === "viewed")
  ) {
    return { label: "Void pending", variant: "cold" };
  }

  const byStatus: Record<
    LeadContractRow["status"],
    { label: string; variant: StatusVariant; className?: string }
  > = {
    awaiting: { label: "Awaiting", variant: "replying" },
    viewed: { label: "Viewed", variant: "new" },
    signed: { label: "Signed", variant: "contacted" },
    declined: { label: "Declined", variant: "hot" },
    voided: { label: "Voided", variant: "dead" },
    error: {
      label: "Error",
      variant: "dead",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
  };
  return byStatus[contract.status];
}

function formatSentAt(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}
