"use client";

import { PhoneCall } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { describeRequestResult, normaBlockText } from "@/lib/norma/block-copy";
import type { NormaCallPreview } from "@/lib/norma/preview";
import { formatPhoneDisplay } from "@/lib/phone-format";

import { previewNormaCall, requestNormaCall } from "./norma-actions";

const IN_FLIGHT_REFRESH_MS = 30_000;
const POLLED_STATUSES: ReadonlySet<string> = new Set(["requested", "dispatching", "dispatched"]);

export type NormaOpenRequest = { id: string; status: string };

type Props = {
  propertyId: string;
  sellerName: string | null;
  propertyAddress: string;
  /** The lead's open Norma request (any non-terminal status), if there is one. */
  openRequest?: NormaOpenRequest | null;
};

type Notice = { tone: "success" | "warning" | "error"; text: string };

/** Plain state label and explanation for a request that is still open. */
export function describeOpenNormaRequest(status: string): { label: string; detail: string } {
  switch (status) {
    case "needs_review":
      return {
        label: "Norma call needs review",
        detail: "This call did not end with a clear result. A person needs to review it. No second call can be started until it is resolved.",
      };
    case "dispatch_unknown":
      return {
        label: "Norma call unconfirmed",
        detail: "Sandra could not confirm this call went out. It is being checked automatically. No second call can be started meanwhile.",
      };
    default:
      return {
        label: "Norma call in progress",
        detail: "Norma has been asked to call this seller. The summary will appear on this lead when the call ends.",
      };
  }
}

export function HaveNormaCallButton({ propertyId, sellerName, propertyAddress, openRequest = null }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<NormaCallPreview | "loading" | null>(null);
  const [context, setContext] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const previewSeq = useRef(0);

  const inFlight = openRequest;
  const state = inFlight ? describeOpenNormaRequest(inFlight.status) : null;

  // While a request is open, re-read the lead now and then so the button
  // follows the call to its end without a manual reload.
  // needs_review waits for a person, so polling is pointless.
  const shouldPoll = inFlight !== null && POLLED_STATUSES.has(inFlight.status);
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => router.refresh(), IN_FLIGHT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, router]);

  function loadPreview() {
    const seq = ++previewSeq.current;
    setPreview("loading");
    previewNormaCall(propertyId)
      .then((result) => {
        if (seq === previewSeq.current) setPreview(result);
      })
      .catch(() => {
        if (seq === previewSeq.current) setPreview({ callable: false, block: { code: "error" } });
      });
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && !inFlight) {
      setNotice(null);
      setConfirmed(false);
      loadPreview();
    }
  }

  function confirm() {
    if (pending || confirmed || !preview || preview === "loading" || !preview.callable) return;
    startTransition(async () => {
      let result;
      try {
        result = await requestNormaCall(propertyId, context.trim() || null);
      } catch {
        setNotice({ tone: "error", text: normaBlockText({ code: "error" }) });
        return;
      }
      const described = describeRequestResult(result);
      setNotice(described);
      // An accepted request, an uncertain send and an already-open request all
      // hold the lead: never offer a second click; the refresh shows the state.
      if (result.ok || result.code === "in_flight") {
        setConfirmed(true);
        router.refresh();
      } else {
        loadPreview();
      }
    });
  }

  const callable = preview && preview !== "loading" && preview.callable ? preview : null;
  const blockText = preview && preview !== "loading" && !preview.callable ? normaBlockText(preview.block) : null;
  const previewPhone = preview && preview !== "loading" ? (preview.phoneE164 ?? null) : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="have-norma-call-trigger"
            data-state-label={state?.label}
          >
            <PhoneCall className="h-3.5 w-3.5" />
            {state ? state.label : "Have Norma call"}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 gap-3" data-testid="have-norma-call-panel">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{state ? state.label : "Have Norma call"}</p>
          <p className="text-muted-foreground text-xs">
            {sellerName?.trim() || "Unknown seller"} · {propertyAddress}
          </p>
        </div>

        {state ? (
          <p className="text-sm" data-testid="norma-call-state">
            {state.detail}
          </p>
        ) : (
          <>
            {preview === "loading" || preview === null ? (
              <p className="text-muted-foreground text-sm" data-testid="norma-call-loading">
                Checking this lead…
              </p>
            ) : (
              <>
                {previewPhone ? (
                  <p className="text-sm" data-testid="norma-call-number">
                    <span className="text-muted-foreground">Number to call: </span>
                    {formatPhoneDisplay(previewPhone)}
                  </p>
                ) : null}
                {blockText ? (
                  <p role="alert" className="text-destructive text-sm" data-testid="norma-call-blocked">
                    {blockText}
                  </p>
                ) : null}
              </>
            )}
            <div className="space-y-1">
              <label htmlFor={`norma-context-${propertyId}`} className="text-xs font-medium">
                Context for Norma (optional)
              </label>
              <Textarea
                id={`norma-context-${propertyId}`}
                value={context}
                onChange={(event) => setContext(event.target.value)}
                maxLength={2000}
                rows={3}
                disabled={pending}
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={confirm}
              disabled={pending || confirmed || !callable}
              data-testid="norma-call-confirm"
            >
              {pending ? "Requesting…" : "Confirm"}
            </Button>
          </>
        )}

        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={notice.tone === "error" ? "text-destructive text-sm" : "text-sm"}
            data-testid="norma-call-notice"
          >
            {notice.text}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
