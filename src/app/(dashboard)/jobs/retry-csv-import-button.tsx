"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import {
  getCsvImportRetryAvailability,
  retryCsvImportJob,
  type CsvImportRetryAvailability,
} from "../import/actions";

export function RetryCsvImportButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] =
    useState<CsvImportRetryAvailability | null>(null);

  useEffect(() => {
    let mounted = true;
    void callAction(getCsvImportRetryAvailability(jobId), {
      fallbackMessage: "Could not check import retry status",
    }).then((result) => {
      if (!mounted) return;
      if (result.ok) setAvailability(result.data);
      else setError(result.error.message);
    });
    return () => {
      mounted = false;
    };
  }, [jobId]);

  if (availability && availability.state !== "retryable") {
    return availability.message ? (
      <span role="status" className="text-muted-foreground max-w-72 text-xs">
        {availability.message}
      </span>
    ) : null;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        disabled={pending || availability === null}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const result = await callAction(retryCsvImportJob(jobId), {
              fallbackMessage: "Could not retry this import",
            });
            if (result.ok) {
              toast.success("Import resumed.");
              router.refresh();
            } else {
              const blockedState = retryStateFromErrorCode(result.error.code);
              if (blockedState) {
                setAvailability({
                  state: blockedState,
                  message: result.error.message,
                });
              } else {
                setError(result.error.message);
              }
            }
          } finally {
            setPending(false);
          }
        }}
      >
        {availability === null
          ? "Checking retry…"
          : pending
            ? "Starting retry…"
            : "Retry import"}
      </Button>
      {error ? <span role="alert" className="text-destructive max-w-72 text-xs">{error}</span> : null}
    </div>
  );
}

function retryStateFromErrorCode(
  code: string,
): CsvImportRetryAvailability["state"] | null {
  if (code === "CSV_IMPORT_RETRY_IN_FLIGHT") return "in_flight";
  if (code === "CSV_IMPORT_RETRY_EXHAUSTED") return "exhausted";
  if (code === "CSV_IMPORT_RETRY_MANUAL_RECONCILIATION") {
    return "manual_reconciliation";
  }
  return null;
}
