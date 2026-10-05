"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { CallbackDueItem } from "@/lib/my-leads/call-state";

const STORAGE_KEY = "my-leads:callback-alerted";
const STORAGE_CAP = 50;
const memoryAlerted = new Set<string>();

export function callbackAlertKey(item: Pick<CallbackDueItem, "taskId" | "dueAt">): string {
  return `${item.taskId}:${item.dueAt}`;
}

function readAlerted(): string[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** True the first time a key is seen (persisted best-effort; the in-memory set is the fallback). */
function claimAlert(key: string): boolean {
  if (memoryAlerted.has(key)) return false;
  const stored = readAlerted();
  if (stored.includes(key)) {
    memoryAlerted.add(key);
    return false;
  }
  memoryAlerted.add(key);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...stored, key].slice(-STORAGE_CAP)));
  } catch {
    // storage unavailable: the in-memory set still dedupes this page session
  }
  return true;
}

const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });

const permission = (): NotificationPermission | null => (typeof Notification === "undefined" ? null : Notification.permission);

type Props = {
  items: readonly CallbackDueItem[];
  labelFor: (propertyId: string) => string | null;
  onCall: (propertyId: string) => void;
  callingPropertyId: string | null;
  canCall: boolean;
  now?: () => number;
};

export function CallbackDueBanner({ items, labelFor, onCall, callingPropertyId, canCall }: Props) {
  const [perm, setPerm] = useState<NotificationPermission | null>(permission);

  useEffect(() => {
    if (perm !== "granted" || typeof Notification === "undefined") return;
    for (const item of items) {
      if (!claimAlert(callbackAlertKey(item))) continue;
      try {
        new Notification("Callback due now", { body: labelFor(item.propertyId) ?? item.title });
      } catch {
        // notifications blocked at the OS level; the banner still shows
      }
    }
  }, [items, perm, labelFor]);

  if (items.length === 0) return null;

  const enableAlerts = async () => {
    if (typeof Notification === "undefined") return;
    try {
      setPerm(await Notification.requestPermission());
    } catch {
      setPerm(permission());
    }
  };

  return (
    <div data-testid="callback-due-banner" role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <ul className="space-y-1">
        {items.map((item) => {
          const calling = callingPropertyId === item.propertyId;
          const due = new Date(item.dueAt);
          return (
            <li key={item.taskId} className="flex flex-wrap items-center gap-2" data-testid={`callback-due-${item.propertyId}`}>
              <span className="font-medium">{labelFor(item.propertyId) ?? item.title}</span>
              <span>{Number.isNaN(due.getTime()) ? "" : timeFormat.format(due)}</span>
              <span>{item.minutesLate > 0 ? `${item.minutesLate} min late` : "Callback due now"}</span>
              <Button
                type="button"
                size="sm"
                data-testid={`callback-call-${item.propertyId}`}
                disabled={calling || !canCall}
                onClick={() => onCall(item.propertyId)}
              >
                Call
              </Button>
            </li>
          );
        })}
      </ul>
      {perm === "default" ? (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void enableAlerts()}>
          Enable alerts
        </Button>
      ) : null}
    </div>
  );
}
