"use client";

import { RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { verifyPropertiesBulk } from "@/app/(dashboard)/leads/actions";
import { callAction } from "@/lib/errors/call-action";
import type { Result } from "@/lib/errors/result";
import {
  approveSkipTraceJob,
  preflightSkipTrace,
  requestSkipTrace,
  type SkipTracePreflight,
} from "@/lib/skip-trace/actions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  propertyIds: string[];
  approveJobId?: string;
  onFinished?: () => void;
  title?: string;
  launchButtonLabel?: string;
  launchSuccessMessage?: string;
  launchFallbackMessage?: string;
  onLaunchSkipTrace?: () => Promise<Result<unknown>>;
  onLaunchSuccess?: (data: unknown) => void;
  onPreflight?: (propertyIds: string[]) => Promise<Result<SkipTracePreflight>>;
  onStartCassVerification?: (
    propertyIds: string[],
    requestKey: string,
  ) => Promise<Result<unknown>>;
};

function plural(n: number, singular: string, pluralLabel = `${singular}s`) {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralLabel}`;
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

function creditCopy(preflight: SkipTracePreflight | null) {
  if (!preflight) return "Checking Tracefy credits...";
  if (preflight.eligible === 0) return "No Tracefy credits needed yet.";
  if (preflight.tracefyCreditStatus === "unavailable") {
    return `Tracefy credits could not be confirmed. Needed: ${preflight.tracefyCreditsRequired.toLocaleString()}.`;
  }
  const available = preflight.tracefyCreditsAvailable ?? 0;
  return `${available.toLocaleString()} available / ${preflight.tracefyCreditsRequired.toLocaleString()} needed`;
}

export function SkipTracePreflightDialog({
  open,
  onOpenChange,
  propertyIds,
  approveJobId,
  onFinished,
  title,
  launchButtonLabel,
  launchSuccessMessage,
  launchFallbackMessage,
  onLaunchSkipTrace,
  onLaunchSuccess,
  onPreflight,
  onStartCassVerification,
}: Props) {
  const [preflight, setPreflight] = useState<SkipTracePreflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmCass, setConfirmCass] = useState(false);
  const [cassStarted, setCassStarted] = useState(false);
  const [loadedIdsKey, setLoadedIdsKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const idsKey = useMemo(() => propertyIds.join("|"), [propertyIds]);
  const idsKeyRef = useRef(idsKey);
  const openRef = useRef(open);
  const requestSeqRef = useRef(0);
  const cassRequestKeyRef = useRef<string | null>(null);
  const mode = approveJobId ? "approve" : "request";

  useEffect(() => {
    idsKeyRef.current = idsKey;
    openRef.current = open;
  }, [idsKey, open]);

  const loadPreflight = () => {
    if (!open || propertyIds.length === 0) return;
    const requestedIds = [...propertyIds];
    const requestedKey = idsKey;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    setPreflight(null);
    setLoadedIdsKey(null);
    setError(null);
    setConfirmCass(false);
    void (async () => {
      let result: Awaited<ReturnType<typeof preflightSkipTrace>>;
      try {
        result = await (onPreflight ?? preflightSkipTrace)(requestedIds);
      } catch (e) {
        if (
          requestSeqRef.current !== requestSeq ||
          idsKeyRef.current !== requestedKey ||
          !openRef.current
        ) {
          return;
        }
        setPreflight(null);
        setLoadedIdsKey(null);
        setError(e instanceof Error ? e.message : "Could not load preflight.");
        setLoading(false);
        return;
      }
      if (
        requestSeqRef.current !== requestSeq ||
        idsKeyRef.current !== requestedKey ||
        !openRef.current
      ) {
        return;
      }
      if (result.ok) {
        setPreflight(result.data);
        setLoadedIdsKey(requestedKey);
      } else {
        setPreflight(null);
        setLoadedIdsKey(null);
        setError(result.error.message);
      }
      setLoading(false);
    })();
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) loadPreflight();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idsKey]);

  const reset = () => {
    setPreflight(null);
    setError(null);
    setConfirmCass(false);
    setCassStarted(false);
    setLoadedIdsKey(null);
    setLoading(false);
    cassRequestKeyRef.current = null;
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const close = () => {
    handleOpenChange(false);
  };

  const launchSkipTrace = () => {
    if (!preflight || !hasCurrentPreflight || !canLaunchSkipTrace) return;
    startTransition(async () => {
      if (onLaunchSkipTrace) {
        const result = await callAction(onLaunchSkipTrace(), {
          successMessage: launchSuccessMessage,
          fallbackMessage: launchFallbackMessage ?? "Could not launch skip trace",
        });
        if (!result.ok) {
          loadPreflight();
          return;
        }
        close();
        onLaunchSuccess?.(result.data);
        onFinished?.();
        return;
      }

      if (mode === "approve" && approveJobId) {
        const result = await callAction(approveSkipTraceJob(approveJobId), {
          fallbackMessage: "Could not approve skip trace",
        });
        if (!result.ok) {
          loadPreflight();
          return;
        }
        if (result.data.status === "canceled") {
          toast.info("Skip-trace canceled - nothing eligible remains.", {
            description: `${result.data.excluded} propert${result.data.excluded === 1 ? "y was" : "ies were"} excluded before provider submission.`,
          });
        } else {
          toast.success("Skip-trace approved - running.");
        }
      } else {
        const result = await callAction(requestSkipTrace(propertyIds), {
          fallbackMessage: "Could not request skip trace",
        });
        if (!result.ok) {
          loadPreflight();
          return;
        }
        const data = result.data;
        if (data.status === "none_eligible") {
          toast.info("Nothing to skip-trace yet", {
            description:
              "Run CASS verification, then refresh this preflight before launching.",
          });
          loadPreflight();
          return;
        }
        toast.success(
          data.status === "queued"
            ? `Skip-trace started for ${plural(data.eligible, "property", "properties")}`
            : `Skip-trace request sent for ${plural(data.eligible, "property", "properties")}`,
          {
            description:
              data.status === "queued"
                ? "Watch progress on /jobs"
                : "Admin will approve on /jobs",
          },
        );
      }

      close();
      onFinished?.();
    });
  };

  const startCassVerification = () => {
    if (
      !preflight ||
      !hasCurrentPreflight ||
      preflight.cassVerificationPropertyIds.length === 0
    ) {
      return;
    }

    if (!confirmCass) {
      setConfirmCass(true);
      return;
    }

    startTransition(async () => {
      const result = await callAction(
        onStartCassVerification
          ? onStartCassVerification(
              preflight.cassVerificationPropertyIds,
              (cassRequestKeyRef.current ??= crypto.randomUUID()),
            )
          : verifyPropertiesBulk(
              preflight.cassVerificationPropertyIds,
              (cassRequestKeyRef.current ??= crypto.randomUUID()),
            ),
        { fallbackMessage: "Could not start CASS verification" },
      );
      if (!result.ok) return;
      cassRequestKeyRef.current = null;
      const verificationCount = preflight.cassVerificationPropertyIds.length;
      toast.success(
        `CASS verification started for ${plural(verificationCount, "address", "addresses")}`,
        {
          description:
            "No skip trace will launch automatically. Refresh counts after the CASS job completes.",
        },
      );
      setCassStarted(true);
      setConfirmCass(false);
      loadPreflight();
      onFinished?.();
    });
  };

  const hasCurrentPreflight = preflight !== null && loadedIdsKey === idsKey;
  const launchDisabledReason = (() => {
    if (!preflight) return "Preflight has not loaded.";
    if (!hasCurrentPreflight) return "Preflight is refreshing.";
    if (preflight.eligible === 0) return "No CASS-verified eligible records.";
    if (mode === "approve" && preflight.eligible !== preflight.requested) {
      return "Pending job must be fully CASS-verified and eligible before approval.";
    }
    if (preflight.tracefyCreditStatus === "insufficient") {
      return "Tracefy credits are insufficient.";
    }
    if (preflight.tracefyCreditStatus === "unavailable") {
      return "Tracefy credits could not be confirmed.";
    }
    return null;
  })();
  const canLaunchSkipTrace =
    hasCurrentPreflight &&
    preflight?.canLaunchSkipTrace === true &&
    launchDisabledReason === null;
  const cassVerificationCount = preflight?.cassVerificationPropertyIds.length ?? 0;
  const hasCassCandidates = hasCurrentPreflight && cassVerificationCount > 0;
  const hasCassFirstAction = hasCassCandidates && !cassStarted;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {title ??
              (mode === "approve"
                ? "Approve skip-trace?"
                : "Confirm skip-trace preflight")}
          </DialogTitle>
          <DialogDescription>
            Review CASS readiness and Tracefy credits before provider spend.
          </DialogDescription>
        </DialogHeader>

        {loading || pending ? (
          <div className="text-muted-foreground py-6 text-sm">
            Checking selected records...
          </div>
        ) : error ? (
          <div className="text-destructive py-4 text-sm">{error}</div>
        ) : preflight ? (
          <div className="min-w-0 space-y-4 text-sm">
            <div className="grid min-w-0 grid-cols-2 gap-3">
              <Metric label="Selected" value={preflight.requested} />
              <Metric label="Skip-trace eligible" value={preflight.eligible} />
              <Metric label="CASS verified" value={preflight.cassVerified} />
              <Metric label="CASS not verified" value={preflight.cassUnverified} />
              <Metric label="Can CASS now" value={cassVerificationCount} />
              <Metric label="Not eligible" value={preflight.notEligible} />
              <Metric
                label="Skip-trace disabled"
                value={preflight.killSwitchSkipped}
              />
            </div>

            <div className="rounded-md border p-3">
              <div className="font-medium">Tracefy credits</div>
              <div className="text-muted-foreground mt-1">
                {creditCopy(preflight)}
              </div>
            </div>

            {cassVerificationCount > 0 ? (
              <div className="rounded-md border p-3">
                <div className="font-medium">CASS verification</div>
                <div className="text-muted-foreground mt-1">
                  {plural(cassVerificationCount, "address", "addresses")} can be
                  verified first. Estimated cost:{" "}
                  {formatUsd(preflight.estimatedCassVerificationCostUsd)}.
                </div>
                {confirmCass ? (
                  <div className="mt-2 rounded-md bg-muted p-2 text-xs">
                    Confirm CASS verification before spend. Skip trace will not
                    launch automatically afterward.
                  </div>
                ) : null}
                {cassStarted ? (
                  <div className="mt-3 flex flex-col gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      CASS verification has started. Refresh counts after the job
                      finishes.
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={loadPreflight}
                      disabled={pending || loading}
                      className="self-start sm:self-auto"
                    >
                      <RefreshCwIcon className="mr-2 size-3.5" />
                      Refresh counts
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {launchDisabledReason ? (
              <div className="text-muted-foreground text-xs">
                Skip trace disabled: {launchDisabledReason}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="flex-col sm:flex-row sm:flex-nowrap">
          <Button
            variant="outline"
            size="sm"
            onClick={close}
            disabled={pending}
            className="order-4 sm:order-none"
          >
            Cancel
          </Button>
          {hasCassFirstAction ? (
            <Button
              autoFocus
              variant="default"
              size="sm"
              onClick={startCassVerification}
              disabled={pending}
              className="order-1 sm:order-none"
            >
              {confirmCass
                ? "Start CASS verification"
                : "Verify unverified addresses"}
            </Button>
          ) : null}
          <Button
            variant={hasCassCandidates ? "outline" : "default"}
            size="sm"
            onClick={launchSkipTrace}
            disabled={pending || !canLaunchSkipTrace}
            className="order-2 sm:order-none"
          >
            {launchButtonLabel ??
              (mode === "approve" ? "Approve skip-trace" : "Skip trace verified only")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-md border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-lg font-medium">{value.toLocaleString()}</div>
    </div>
  );
}
