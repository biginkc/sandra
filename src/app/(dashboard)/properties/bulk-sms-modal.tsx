"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";

import {
  bulkQueueSms,
  countAlreadyContacted,
  listSmsTemplateCategories,
} from "./actions";

type Category = { category: string; count: number };

type Props = {
  open: boolean;
  propertyIds: string[];
  onClose: () => void;
  onQueued: (succeeded: number) => void;
};

type PaceUnit = "seconds" | "minutes";

/** Convert a {value, unit} pacing pair into raw seconds. */
export function resolvePaceSeconds(value: number, unit: PaceUnit): number {
  return value * (unit === "minutes" ? 60 : 1);
}

const PACE_MIN_SECONDS = 10;
const PACE_MAX_SECONDS = 600;
const SKIP_DEFAULT_THRESHOLD = 50;

export function BulkSmsModal({ open, propertyIds, onClose, onQueued }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [customBody, setCustomBody] = useState("");
  const [mode, setMode] = useState<"category" | "custom">("category");
  const [pending, startTransition] = useTransition();

  // Pacing
  const [paceValue, setPaceValue] = useState<number>(18);
  const [paceUnit, setPaceUnit] = useState<PaceUnit>("seconds");

  // Skip-contacted: defaults ON for >50 selections per the locked plan rule.
  const [skipContacted, setSkipContacted] = useState<boolean>(
    propertyIds.length > SKIP_DEFAULT_THRESHOLD,
  );
  const [contactedCount, setContactedCount] = useState<number | null>(null);

  // Stable key so the count-fetch effect doesn't re-run on every parent render
  // even if the parent passes a fresh array reference each time.
  const propertyIdsKey = useMemo(() => propertyIds.join(","), [propertyIds]);

  useEffect(() => {
    if (!open) return;
    listSmsTemplateCategories().then((result) => {
      if (result.ok) {
        setCategories(result.data);
        setSelectedCategory(result.data[0]?.category ?? "");
      }
    });
    setContactedCount(null);
    countAlreadyContacted(propertyIds).then((result) => {
      if (result.ok) setContactedCount(result.data);
    });
    // Reset the skip-contacted default whenever we open with a new selection.
    setSkipContacted(propertyIds.length > SKIP_DEFAULT_THRESHOLD);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, propertyIdsKey]);

  const resolvedPaceSeconds = resolvePaceSeconds(paceValue, paceUnit);
  const paceOutOfRange =
    !Number.isFinite(resolvedPaceSeconds) ||
    resolvedPaceSeconds < PACE_MIN_SECONDS ||
    resolvedPaceSeconds > PACE_MAX_SECONDS;

  const handleSend = () => {
    if (paceOutOfRange) {
      toast.error("Pacing must be between 10 seconds and 10 minutes.");
      return;
    }
    if (mode === "category" && !selectedCategory) {
      toast.error("Pick a template category first.");
      return;
    }
    if (mode === "custom" && !customBody.trim()) {
      toast.error("Enter a message body.");
      return;
    }

    const opts =
      mode === "category"
        ? {
            templateCategory: selectedCategory,
            paceSeconds: resolvedPaceSeconds,
            skipIfContacted: skipContacted,
          }
        : {
            body: customBody.trim(),
            paceSeconds: resolvedPaceSeconds,
            skipIfContacted: skipContacted,
          };

    startTransition(async () => {
      const result = await callAction(bulkQueueSms(propertyIds, opts), {
        fallbackMessage: "Bulk SMS failed",
      });
      if (result.ok) {
        const { succeeded, skipped, failed } = result.data;
        const parts: string[] = [];
        if (succeeded > 0)
          parts.push(`${succeeded} message${succeeded === 1 ? "" : "s"} queued`);
        if (skipped > 0) parts.push(`${skipped} skipped`);
        if (failed.length > 0) parts.push(`${failed.length} failed`);
        if (failed.length > 0) {
          toast.warning(parts.join(" · "), {
            description: failed[0].message,
          });
        } else {
          toast.success(parts.join(" · ") || "Done");
        }
        onQueued(succeeded);
        onClose();
      }
    });
  };

  const skipLabelCount =
    contactedCount === null ? "…" : String(contactedCount);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Bulk SMS — {propertyIds.length} prospect
            {propertyIds.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("category")}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                mode === "category"
                  ? "bg-primary text-primary-foreground border-transparent"
                  : "text-muted-foreground"
              }`}
            >
              Template pool
            </button>
            <button
              type="button"
              onClick={() => setMode("custom")}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                mode === "custom"
                  ? "bg-primary text-primary-foreground border-transparent"
                  : "text-muted-foreground"
              }`}
            >
              Custom message
            </button>
          </div>

          {mode === "category" ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Template category</label>
              {categories.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No SMS templates found. Add some in Settings.
                </p>
              ) : (
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                >
                  {categories.map((c) => (
                    <option key={c.category} value={c.category}>
                      {c.category} ({c.count} template{c.count === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Message body</label>
              <textarea
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                rows={4}
                placeholder="Hi {first_name}, I'm interested in your property…"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
          )}

          {/* Pacing — number + unit dropdown (human-readable UI). */}
          <div className="space-y-1.5">
            <label htmlFor="bulk-sms-pace" className="text-sm font-medium">
              Pacing
            </label>
            <div className="flex gap-2">
              <input
                id="bulk-sms-pace"
                type="number"
                min={1}
                value={paceValue}
                onChange={(e) => setPaceValue(Number(e.target.value))}
                aria-label="Pacing"
                className="border-input bg-background w-24 rounded-md border px-3 py-2 text-sm"
              />
              <select
                value={paceUnit}
                onChange={(e) => setPaceUnit(e.target.value as PaceUnit)}
                aria-label="Pacing unit"
                className="border-input bg-background rounded-md border px-3 py-2 text-sm"
              >
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
              </select>
            </div>
            {paceOutOfRange ? (
              <p className="text-destructive text-xs" role="alert">
                Pacing must be between 10 seconds and 10 minutes.
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Messages release at {resolvedPaceSeconds}-second intervals.
                Cron drains the queue honoring quiet hours.
              </p>
            )}
          </div>

          {/* Skip prospects already contacted */}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={skipContacted}
                onChange={(e) => setSkipContacted(e.target.checked)}
                className="border-input rounded"
              />
              Skip prospects already contacted ({skipLabelCount})
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={pending}>
            {pending
              ? "Queuing…"
              : `Queue ${propertyIds.length} message${propertyIds.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
