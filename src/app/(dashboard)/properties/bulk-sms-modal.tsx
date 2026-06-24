"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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

import type { AudienceLineTypeAssessment } from "@/lib/messaging/audience-assessment";

import {
  assessBulkSmsAudience,
  bulkQueueSms,
  countAlreadyContacted,
  listSmsTemplateCategories,
} from "./actions";
import {
  SMS_PACING_JITTER_PCT,
  SMS_PACING_SECONDS,
  paceValidationMessage,
} from "@/lib/messaging/pacing";

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

const PACE_MIN_SECONDS = SMS_PACING_SECONDS.customMin;
const PACE_MAX_SECONDS = SMS_PACING_SECONDS.max;
const SKIP_DEFAULT_THRESHOLD = 50;

// Pacing presets (260506-m3a). Each preset is a pace + jitter bundle —
// NO volume caps client-side; provider credits are the only cap
// (Jarrad's standing rule). The queue drains continuously at the
// chosen pace until empty.
type PresetId = "conservative" | "steady" | "push" | "custom";
const PRESETS: Record<
  Exclude<PresetId, "custom">,
  { label: string; paceSeconds: number; tagline: string }
> = {
  conservative: {
    label: "Conservative",
    paceSeconds: SMS_PACING_SECONDS.conservative,
    tagline: "Low and slow — best for warmup or paranoid mode.",
  },
  steady: {
    label: "Steady",
    paceSeconds: SMS_PACING_SECONDS.steadyDefault,
    tagline: "Recommended. Continuous 8s pace.",
  },
  push: {
    label: "Push",
    paceSeconds: SMS_PACING_SECONDS.push,
    tagline: "Fast continuous drain.",
  },
};
const JITTER_PCT = SMS_PACING_JITTER_PCT;

/**
 * Mirror the server-side bulkQueueSms drain math so the UI shows the
 * ramp size + last-send timestamp BEFORE the operator queues. Pure
 * function; exported for test access.
 *
 * No volume caps client-side — the schedule is one continuous paced
 * ramp; provider credits are the only cap. Messages whose release time
 * lands in recipient quiet hours are deferred by the release cron, so
 * the quiet-window count is a preview of that deferral, not a cap.
 *
 * DST simplification (same as the server used to make): the 9 PM–8 AM
 * PT quiet window uses a fixed -08:00 offset.
 */
export function computeDrain(args: {
  total: number;
  paceSeconds: number;
  now: Date;
}): {
  perDay: { dayLabel: string; count: number }[];
  lastSendLocal: string | null;
  pastCutoffCount: number;
} {
  const { total, paceSeconds, now } = args;
  if (total === 0 || !Number.isFinite(paceSeconds) || paceSeconds <= 0) {
    return { perDay: [], lastSendLocal: null, pastCutoffCount: 0 };
  }
  const startMs = now.getTime();
  const lastSendMs = startMs + Math.max(0, total - 1) * paceSeconds * 1000;
  // Count messages whose scheduled slot lands inside the 9 PM – 8 AM PT
  // quiet window (federal TCPA cutoff) on ANY night the ramp crosses,
  // not just the first one. The release cron defers those to the next
  // morning; this is a preview of that deferral. Fixed -08:00 PT offset
  // (same simplification as the rest of this file), so pure arithmetic
  // per message instead of an Intl call.
  const PT_OFFSET_MS = 8 * 3_600_000;
  const DAY_MS = 86_400_000;
  let pastCutoffCount = 0;
  for (let i = 0; i < total; i++) {
    const ptMs = startMs + i * paceSeconds * 1000 - PT_OFFSET_MS;
    const timeOfDayMs = ((ptMs % DAY_MS) + DAY_MS) % DAY_MS;
    const hour = timeOfDayMs / 3_600_000;
    if (hour >= 21 || hour < 8) pastCutoffCount++;
  }
  const lastSendLocal = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    weekday: "short",
  }).format(new Date(lastSendMs));
  return {
    perDay: [{ dayLabel: "Queued", count: total }],
    lastSendLocal,
    pastCutoffCount,
  };
}

export function BulkSmsModal({ open, propertyIds, onClose, onQueued }: Props) {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [customBody, setCustomBody] = useState("");
  const [mode, setMode] = useState<"category" | "custom">("category");
  const [pending, startTransition] = useTransition();
  const [campaignName, setCampaignName] = useState("");
  const [campaignNameError, setCampaignNameError] = useState<string | null>(
    null,
  );
  const campaignNameRef = useRef<HTMLInputElement>(null);

  // Pacing — preset selector replaces the raw inputs (260506-m3a).
  // Steady is the default. Custom-mode raw inputs are only consulted
  // when presetId === "custom".
  const [presetId, setPresetId] = useState<PresetId>("steady");
  const [paceValue, setPaceValue] = useState<number>(18);
  const [paceUnit, setPaceUnit] = useState<PaceUnit>("seconds");

  // Stable key so the count-fetch effect doesn't re-run on every parent render
  // even if the parent passes a fresh array reference each time.
  const propertyIdsKey = useMemo(() => propertyIds.join(","), [propertyIds]);

  // Skip-contacted defaults ON for >50 selections per the locked plan rule.
  // Re-derive the default whenever the selection identity changes — render
  // path, no synchronous setState-in-effect (which the project's lint rule
  // flags as cascading-render risk).
  const [skipContacted, setSkipContacted] = useState<boolean>(
    propertyIds.length > SKIP_DEFAULT_THRESHOLD,
  );
  const [skipContactedKey, setSkipContactedKey] = useState<string>(propertyIdsKey);
  if (skipContactedKey !== propertyIdsKey) {
    setSkipContactedKey(propertyIdsKey);
    setSkipContacted(propertyIds.length > SKIP_DEFAULT_THRESHOLD);
  }

  // Contacted-count: fetched on open. We reset to `null` inside the async
  // .then() callback (not synchronously in the effect body) so the lint
  // rule against cascading renders stays satisfied.
  const [contactedCount, setContactedCount] = useState<number | null>(null);

  // Line-type assessment: who in this selection can actually receive a
  // text. Landlines are always excluded server-side; unknowns need the
  // opt-in toggle below. Re-defaults to OFF per selection, same pattern
  // as skipContacted.
  const [assessment, setAssessment] =
    useState<AudienceLineTypeAssessment | null>(null);
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [assessmentKey, setAssessmentKey] = useState(propertyIdsKey);
  if (assessmentKey !== propertyIdsKey) {
    setAssessmentKey(propertyIdsKey);
    setAssessment(null);
    setIncludeUnknown(false);
  }

  useEffect(() => {
    if (!open) return;
    listSmsTemplateCategories().then((result) => {
      if (result.ok) {
        setCategories(result.data);
        setSelectedCategory(result.data[0]?.category ?? "");
      }
    });
    countAlreadyContacted(propertyIds).then((result) => {
      if (result.ok) setContactedCount(result.data);
    });
    assessBulkSmsAudience(propertyIds).then((result) => {
      if (result.ok) setAssessment(result.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, propertyIdsKey]);

  // Resolve the active preset's pace. Custom mode reads from the raw
  // inputs; the other 3 presets pull from PRESETS.
  const resolvedPaceSeconds =
    presetId === "custom"
      ? resolvePaceSeconds(paceValue, paceUnit)
      : PRESETS[presetId].paceSeconds;
  // Out-of-range is a Custom-mode concern only; the locked presets are
  // always within bounds by definition.
  const paceOutOfRange =
    presetId === "custom" &&
    (!Number.isFinite(resolvedPaceSeconds) ||
      resolvedPaceSeconds < PACE_MIN_SECONDS ||
      resolvedPaceSeconds > PACE_MAX_SECONDS);

  // How many will actually queue: confirmed mobiles, plus unknowns when
  // opted in. Until the assessment loads, fall back to the selection
  // size so the button isn't disabled by a slow fetch.
  const textableCount =
    assessment === null
      ? propertyIds.length
      : assessment.mobile + (includeUnknown ? assessment.unknown : 0);

  const drain = useMemo(
    () =>
      computeDrain({
        total: textableCount,
        paceSeconds: resolvedPaceSeconds,
        now: new Date(),
      }),
    [textableCount, resolvedPaceSeconds],
  );

  const handleSend = () => {
    const trimmedCampaignName = campaignName.trim();
    if (!trimmedCampaignName) {
      setCampaignNameError("Campaign name is required.");
      campaignNameRef.current?.focus();
      return;
    }
    if (paceOutOfRange) {
      toast.error(paceValidationMessage("bulk"));
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

    const baseOpts = {
      paceSeconds: resolvedPaceSeconds,
      skipIfContacted: skipContacted,
      jitterPct: JITTER_PCT,
      includeUnknown,
      campaignName: trimmedCampaignName,
    };
    const opts =
      mode === "category"
        ? { ...baseOpts, templateCategory: selectedCategory }
        : { ...baseOpts, body: customBody.trim() };

    startTransition(async () => {
      const result = await callAction(bulkQueueSms(propertyIds, opts), {
        fallbackMessage: "Bulk SMS failed",
      });
      if (!result.ok) {
        if (
          result.error.code === "VALIDATION" ||
          result.error.code === "DUPLICATE_NAME"
        ) {
          setCampaignNameError(result.error.message);
          campaignNameRef.current?.focus();
        }
        return;
      }
      if (result.ok) {
        if (result.data.deferred) {
          toast.success(
            `Queueing ${result.data.deferred.total.toLocaleString()} messages in the background`,
            {
              description:
                "Track progress on /jobs — messages appear in the Outbox as they're scheduled.",
            },
          );
          onQueued(result.data.deferred.total);
          handleClose();
          router.push(`/jobs/${result.data.deferred.jobId}`);
          return;
        }
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
        handleClose();
        router.push("/messages?tab=outbox");
      }
    });
  };

  const skipLabelCount =
    contactedCount === null ? "…" : String(contactedCount);
  const handleClose = () => {
    setCampaignName("");
    setCampaignNameError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Bulk SMS — {propertyIds.length} prospect
            {propertyIds.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label htmlFor="bulk-sms-campaign-name" className="text-sm font-medium">
              Campaign name
            </label>
            <input
              ref={campaignNameRef}
              id="bulk-sms-campaign-name"
              value={campaignName}
              maxLength={80}
              onChange={(event) => {
                setCampaignName(event.target.value);
                if (campaignNameError && event.target.value.trim()) {
                  setCampaignNameError(null);
                }
              }}
              placeholder="e.g. June Vacant Homes"
              aria-invalid={campaignNameError ? "true" : "false"}
              aria-describedby={
                campaignNameError ? "bulk-sms-campaign-name-error" : undefined
              }
              className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            />
            {campaignNameError ? (
              <p
                id="bulk-sms-campaign-name-error"
                className="text-destructive text-xs"
                role="alert"
              >
                {campaignNameError}
              </p>
            ) : null}
          </div>

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

          {/* Sending speed — carrier-safe presets (260506-m3a). */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Sending speed</label>
            <div className="grid grid-cols-2 gap-2">
              {(["conservative", "steady", "push", "custom"] as const).map(
                (id) => {
                  const checked = presetId === id;
                  const meta =
                    id === "custom"
                      ? {
                          label: "Custom",
                          tagline: "Set your own pace.",
                        }
                      : PRESETS[id];
                  return (
                    <label
                      key={id}
                      className={`cursor-pointer rounded-md border px-3 py-2 text-sm ${
                        checked
                          ? "border-primary bg-primary/5"
                          : "border-input"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="bulk-sms-preset"
                          value={id}
                          checked={checked}
                          onChange={() => setPresetId(id)}
                          aria-label={meta.label}
                        />
                        <span className="font-medium">{meta.label}</span>
                        {id === "steady" ? (
                          <span className="text-muted-foreground text-xs">
                            (recommended)
                          </span>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {meta.tagline}
                      </p>
                      {id !== "custom" ? (
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {
                            PRESETS[id as Exclude<PresetId, "custom">]
                              .paceSeconds
                          }
                          s ±20%
                        </p>
                      ) : null}
                    </label>
                  );
                },
              )}
            </div>

            {presetId === "custom" ? (
              <div className="border-input space-y-2 rounded-md border border-dashed p-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="bulk-sms-pace"
                    className="text-sm font-medium"
                  >
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
                      {paceValidationMessage("bulk")}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Drain estimate */}
            {drain.perDay.length > 0 ? (
              <div
                className="bg-muted/40 rounded-md p-3 text-xs"
                data-testid="drain-estimate"
              >
                <p className="font-medium">Drain estimate</p>
                <p className="text-muted-foreground mt-1">
                  {drain.perDay
                    .map((d) => `${d.dayLabel} ${d.count.toLocaleString()}`)
                    .join(" · ")}
                </p>
                {drain.lastSendLocal ? (
                  <p className="text-muted-foreground">
                    Last send: {drain.lastSendLocal} PT
                  </p>
                ) : null}
                {drain.pastCutoffCount > 0 ? (
                  <p className="text-amber-700 dark:text-amber-400">
                    {drain.pastCutoffCount.toLocaleString()} would land in
                    the 9 PM – 8 AM quiet window — released next morning.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Audience line-type assessment — who can actually get a text. */}
          <div
            className="bg-muted/40 space-y-2 rounded-md p-3 text-xs"
            data-testid="line-type-assessment"
          >
            <p className="font-medium">Who gets texted</p>
            {assessment === null ? (
              <p className="text-muted-foreground">Checking line types…</p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  {assessment.mobile.toLocaleString()} mobile ·{" "}
                  {assessment.landline.toLocaleString()} landline (always
                  excluded) · {assessment.unknown.toLocaleString()} unknown
                  {assessment.noPhone > 0
                    ? ` · ${assessment.noPhone.toLocaleString()} no phone`
                    : ""}
                </p>
                {assessment.unknown > 0 ? (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={includeUnknown}
                      onChange={(e) => setIncludeUnknown(e.target.checked)}
                      className="border-input rounded"
                    />
                    Also text {assessment.unknown.toLocaleString()} unknown
                    line type{assessment.unknown === 1 ? "" : "s"} (may
                    include landlines)
                  </label>
                ) : null}
              </>
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
          <Button variant="outline" onClick={handleClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={pending || textableCount === 0}>
            {pending
              ? "Queuing…"
              : `Queue ${textableCount.toLocaleString()} message${textableCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
