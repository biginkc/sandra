"use client";

import { FileSignatureIcon, RefreshCwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableFooter,
  DataTableShell,
} from "@/components/ui/data-table-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddTemplateDialog } from "./add-template-dialog";
import { templateLibraryActions } from "./client-actions";
import { TemplateRowActions } from "./template-row-actions";
import type {
  EsignTemplateRow,
  TemplateLibraryActions,
  TemplateLibraryLoadResult,
} from "./types";

export function TemplateLibrary({
  result,
  actions,
  dropboxSignConnected = true,
  templateCreationDisabledReason,
  onRetry,
}: {
  result: TemplateLibraryLoadResult;
  actions?: TemplateLibraryActions | null;
  dropboxSignConnected?: boolean;
  templateCreationDisabledReason?: string;
  onRetry?: () => void;
}) {
  const resolvedActions = actions === undefined ? templateLibraryActions : (actions ?? undefined);
  if (!result.ok) {
    return (
      <DataTableShell>
        <div
          role="alert"
          className="flex min-h-64 flex-col items-center justify-center gap-3 px-6 py-12 text-center"
        >
          <div className="bg-destructive/10 text-destructive flex size-10 items-center justify-center rounded-full">
            <FileSignatureIcon aria-hidden />
          </div>
          <div className="space-y-1">
            <h2 className="font-medium">Could not load eSign templates</h2>
            <p className="text-muted-foreground max-w-lg text-sm">
              {result.error.message}
            </p>
            <p className="text-muted-foreground font-mono text-xs">
              {result.error.code}
            </p>
          </div>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCwIcon data-icon="inline-start" />
              Retry
            </Button>
          )}
        </div>
      </DataTableShell>
    );
  }

  if (result.data.length === 0) {
    return (
      <DataTableShell>
        <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-8 py-14 text-center">
          <div className="space-y-1">
            <h2 className="font-semibold">
              {dropboxSignConnected ? "No templates yet" : "Dropbox Sign is not connected"}
            </h2>
            <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
              {dropboxSignConnected
                ? "Upload a contract PDF and place the signature, initials, date, and merge fields once. Every send after that is two clicks from a lead."
                : "Connect Dropbox Sign in Integrations before adding or managing eSign templates."}
            </p>
          </div>
          <AddTemplateDialog
            actions={resolvedActions}
            disabledReason={
              templateCreationDisabledReason ??
              (resolvedActions ? undefined : "Template actions are not connected yet.")
            }
          />
          <p className="text-muted-foreground font-mono text-[11px]">
            {dropboxSignConnected
              ? "PDF up to 40 MB · or pick a file from Dropbox"
              : "Reconnect Dropbox Sign to upload contract PDFs."}
          </p>
        </div>
      </DataTableShell>
    );
  }

  return (
    <DataTableShell data-testid="esign-template-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Document type</TableHead>
            <TableHead>Signer roles</TableHead>
            <TableHead>Last edited</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.data.map((template) => (
            <TemplateTableRow key={template.id} template={template} actions={resolvedActions} />
          ))}
        </TableBody>
      </Table>
      <DataTableFooter>
        <span className="text-muted-foreground text-sm">
          {result.data.length} template{result.data.length === 1 ? "" : "s"}
        </span>
      </DataTableFooter>
    </DataTableShell>
  );
}

function TemplateTableRow({
  template,
  actions,
}: {
  template: EsignTemplateRow;
  actions?: TemplateLibraryActions;
}) {
  const orderedRoles = [...template.signerRoles].sort((a, b) => a.order - b.order);
  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-52 flex-col gap-0.5">
          <span className="font-medium">
            {template.name}
          </span>
          <span className="text-muted-foreground text-xs">
            {template.sourceFilename} · {formatBytes(template.sourceSizeBytes)}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{template.documentType}</Badge>
      </TableCell>
      <TableCell>
        <ol aria-label={`Required signer roles for ${template.name}`} className="space-y-0.5">
          {orderedRoles.map((role) => (
            <li key={`${role.order}-${role.name}`} className="text-sm">
              <span className="text-muted-foreground mr-1">{role.order + 1}.</span>
              {role.name}
              {role.name === template.sellerRoleName && (
                <span className="text-muted-foreground ml-1 text-xs">(seller)</span>
              )}
            </li>
          ))}
        </ol>
      </TableCell>
      <TableCell>
        <time dateTime={template.updatedAt} className="text-sm">
          {formatDate(template.updatedAt)}
        </time>
        <div className="text-muted-foreground text-xs">{template.updatedByName}</div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <TemplateRowActions template={template} actions={actions} />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function TemplateLibraryLoading() {
  return (
    <DataTableShell aria-label="Loading eSign templates">
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 5 }).map((_, index) => (
              <TableHead key={index}><Skeleton className="h-3 w-24" /></TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, row) => (
            <TableRow key={row}>
              {Array.from({ length: 5 }).map((__, cell) => (
                <TableCell key={cell}><Skeleton className="h-5 w-28" /></TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(new Date(iso));
}
