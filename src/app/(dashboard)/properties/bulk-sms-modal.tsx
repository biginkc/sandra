"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
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

// Carrier-safe pacing presets (260506-m3a). Each preset bundles
// pace + daily cap + jitter into a single radio choice so Jarrad
// doesn't have to remember the rules every time.
type PresetId = "conservative" | "steady" | "push" | "custom";
const PRESETS: Record<
  Exclude<PresetId, "custom">,
  { label: string; dailyCap: number; paceSeconds: number; tagline: string }
> = {
  conservative: {
    label: "Conservative",
    dailyCap: 250,
    paceSeconds: 14,
    tagline: "Low and slow — best for warmup or paranoid mode.",
  },
  steady: {
    label: "Steady",
    dailyCap: 1000,
    paceSeconds: 8,
    tagline: "Recommended. ~50% of T-Mobile Standard ceiling.",
  },
  push: {
    label: "Push",
    dailyCap: 1800,
    paceSeconds: 4,
    tagline: "Short-burst sprint, not for sustained use.",
  },
};
const JITTER_PCT = 0.2;

/**
 * Mirror the server-side bulkQueueSms drain math so the UI shows the
 * preset's per-day breakdown + last-send timestamp BEFORE the operator
 * queues. Pure function; exported for test access.
 *
 * Same DST simplification as the server: daily-cap rollover anchors at
 * 8 AM PT using a fixed -08:00 offset, drifting to 9 AM PT during DST.
 */
export function computeDrain(args: {
  total: number;
  paceSeconds: number;
  dailyCap: number | undefined;
  now: Date;
}): {
  perDay: { dayLabel: string; count: number }[];
  lastSendLocal: string | null;
  pastCutoffCount: number;
} {
  const { total, paceSeconds, dailyCap, now } = args;
  if (total === 0 || !Number.isFinite(paceSeconds) || paceSeconds <= 0) {
    return { perDay: [], lastSendLocal: null, pastCutoffCount: 0 };
  }
  const perDay: { dayLabel: string; count: number }[] = [];
  let remaining = total;
  let dayStart = now.getTime();
  let pastCutoffCount = 0;
  let lastSendMs = dayStart;
  const dayLabelFor = (ms: number, idx: number): string => {
    if (idx === 0) return "Today";
    if (idx === 1) return "Tomorrow";
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "America/Los_Angeles",
    }).format(new Date(ms));
  };
  let dayIdx = 0;
  while (remaining > 0) {
    const cap = dailyCap ?? remaining;
    const inThisDay = Math.min(remaining, cap);
    perDay.push({ dayLabel: dayLabelFor(dayStart, dayIdx), count: inThisDay });
    lastSendMs = dayStart + Math.max(0, inThisDay - 1) * paceSeconds * 1000;
    // Count any that would land past 9 PM PT same calendar day (federal
    // TCPA cutoff). The server defers them on release; we surface the
    // count so the UI shows the rollover ahead of time.
    const ptNinePm = (() => {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = fmt.formatToParts(new Date(dayStart));
      const y = Number(parts.find((p) => p.type === "year")!.value);
      const m = Number(parts.find((p) => p.type === "month")!.value);
      const day = Number(parts.find((p) => p.type === "day")!.value);
      // 21:00 PT == 05:00 UTC next day at -08:00.
      return Date.UTC(y, m - 1, day + 1, 5, 0, 0);
    })();
    if (lastSendMs > ptNinePm) {
      const overflowStart = Math.max(
        0,
        Math.ceil((ptNinePm - dayStart) / (paceSeconds * 1000)),
      );
      pastCutoffCount += Math.max(0, inThisDay - overflowStart);
    }
    remaining -= inThisDay;
    dayIdx += 1;
    // Next bucket starts at 08:00 PT == 16:00 UTC at -08:00 offset.
    const nextDay = new Date(dayStart);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(nextDay);
    const y = Number(parts.find((p) => p.type === "year")!.value);
    const m = Number(parts.find((p) => p.type === "month")!.value);
    const day = Number(parts.find((p) => p.type === "day")!.value);
    dayStart = Date.UTC(y, m - 1, day, 16, 0, 0);
  }
  const lastSendLocal = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    weekday: "short",
  }).format(new Date(lastSendMs));
  return { perDay, lastSendLocal, pastCutoffCount };
}

export function BulkSmsModal({ open, propertyIds, onClose, onQueued }: Props) {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [customBody, setCustomBody] = useState("");
  const [mode, setMode] = useState<"category" | "custom">("category");
  const [pending, startTransition] = useTransition();

  // Pacing — preset selector replaces the raw inputs (260506-m3a).
  // Steady is the default. Custom-mode raw inputs are only consulted
  // when presetId === "custom".
  const [presetId, setPresetId] = useState<PresetId>("steady");
  const [paceValue, setPaceValue] = useState<number>(18);
  const [paceUnit, setPaceUnit] = useState<PaceUnit>("seconds");
  const [customDailyCap, setCustomDailyCap] = useState<number | "">("");

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, propertyIdsKey]);

  // Resolve the active preset's pace + daily cap. Custom mode reads
  // from the raw inputs; the other 3 presets pull from PRESETS.
  const resolvedPaceSeconds =
    presetId === "custom"
      ? resolvePaceSeconds(paceValue, paceUnit)
      : PRESETS[presetId].paceSeconds;
  const resolvedDailyCap: number | undefined =
    presetId === "custom"
      ? typeof customDailyCap === "number" && customDailyCap > 0
        ? customDailyCap
        : undefined
      : PRESETS[presetId].dailyCap;
  // Out-of-range is a Custom-mode concern only; the locked presets are
  // always within bounds by definition.
  const paceOutOfRange =
    presetId === "custom" &&
    (!Number.isFinite(resolvedPaceSeconds) ||
      resolvedPaceSeconds < PACE_MIN_SECONDS ||
      resolvedPaceSeconds > PACE_MAX_SECONDS);

  const drain = useMemo(
    () =>
      computeDrain({
        total: propertyIds.length,
        paceSeconds: resolvedPaceSeconds,
        dailyCap: resolvedDailyCap,
        now: new Date(),
      }),
    [propertyIds.length, resolvedPaceSeconds, resolvedDailyCap],
  );

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

    const baseOpts = {
      paceSeconds: resolvedPaceSeconds,
      skipIfContacted: skipContacted,
      dailyCap: resolvedDailyCap,
      jitterPct: JITTER_PCT,
    };
    const opts =
      mode === "category"
        ? { ...baseOpts, templateCategory: selectedCategory }
        : { ...baseOpts, body: customBody.trim() };

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
        router.push("/messages?tab=outbox");
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
                          tagline: "Set your own pace and daily cap.",
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
                          {PRESETS[
                            id as Exclude<PresetId, "custom">
                          ].dailyCap.toLocaleString()}
                          /day ·{" "}
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
                      Pacing must be between 10 seconds and 10 minutes.
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="bulk-sms-daily-cap"
                    className="text-sm font-medium"
                  >
                    Daily cap
                  </label>
                  <input
                    id="bulk-sms-daily-cap"
                    type="number"
                    min={1}
                    value={customDailyCap}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCustomDailyCap(
                        v === "" ? "" : Math.max(1, Number(v)),
                      );
                    }}
                    aria-label="Daily cap"
                    placeholder="No cap"
                    className="border-input bg-background w-32 rounded-md border px-3 py-2 text-sm"
                  />
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
                    {drain.pastCutoffCount.toLocaleString()} would land past
                    9 PM cutoff — released next morning.
                  </p>
                ) : null}
              </div>
            ) : null}
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
