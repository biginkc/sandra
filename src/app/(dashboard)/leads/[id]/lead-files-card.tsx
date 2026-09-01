"use client";

import { DownloadIcon, FileTextIcon, FolderOpenIcon } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { callAction } from "@/lib/errors/call-action";
import {
  navigateAuthorizedPopup,
  openAuthorizedPopup,
} from "@/lib/esign/authorized-popup";

import type { ContractActionHandlers, LeadFileRow } from "./esign-types";

type Props = {
  files: readonly LeadFileRow[];
  downloadAction: ContractActionHandlers["downloadAction"];
  loadError?: string | null;
};

export function LeadFilesCard({
  files,
  downloadAction,
  loadError = null,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const download = (fileId: string) => {
    setError(null);
    const popup = openAuthorizedPopup();
    if (!popup) {
      setError(
        "Your browser blocked the file window. Allow popups and try again.",
      );
      return;
    }
    startTransition(async () => {
      const result = await callAction(downloadAction({ fileId }), {
        fallbackMessage: "Could not prepare this file",
      });
      if (!result.ok) {
        popup.close();
        setError(result.error.message);
        return;
      }
      if (!navigateAuthorizedPopup(popup, result.data.url)) {
        setError("Could not open this file.");
      }
    });
  };

  return (
    <Card size="sm" data-testid="lead-files-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpenIcon className="size-4" aria-hidden />
          Files
        </CardTitle>
        <CardDescription>Documents saved for this lead.</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">
            Files did not load. {loadError}
          </p>
        ) : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files yet.</p>
        ) : (
          <ul className="divide-y divide-border" aria-label="Lead files">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <FileTextIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {file.displayName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatFileDate(file.createdAt)}
                    {file.sizeBytes === null
                      ? ""
                      : ` · ${formatFileSize(file.sizeBytes)}`}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  onClick={() => download(file.id)}
                  aria-label={`Download ${file.displayName}`}
                >
                  <DownloadIcon className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function formatFileDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
