"use client";

import { CheckIcon, ChevronDownIcon, FlameIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { callAction } from "@/lib/errors/call-action";

import { updateLeadMotivation, type MotivationLevel } from "../actions";

type Props = {
  propertyId: string;
  address: string;
  initial: MotivationLevel | null;
};

export const MOTIVATION_LEVELS: readonly {
  value: MotivationLevel;
  label: string;
  /** Tailwind class for the dot (kanban card + lead detail). */
  dotClass: string;
  /** Inline color for the active-chip background on the trigger button. */
  tint: string;
}[] = [
  { value: "hot", label: "Hot", dotClass: "bg-red-500", tint: "#ef4444" },
  { value: "warm", label: "Warm", dotClass: "bg-amber-500", tint: "#f59e0b" },
  { value: "cold", label: "Cold", dotClass: "bg-blue-500", tint: "#3b82f6" },
];

/**
 * Lead-header widget for setting seller motivation (hot/warm/cold/unset).
 * Separate from status — status says "where in the pipeline", motivation
 * says "how hot is the seller". Once the prospects/leads split lands,
 * the trigger gets disabled on prospect-status rows; for now it's always
 * available.
 */
export function LeadMotivationWidget({
  propertyId,
  address,
  initial,
}: Props) {
  const router = useRouter();
  const [level, setLevel] = useState<MotivationLevel | null>(initial);
  const [pending, startTransition] = useTransition();

  const change = (next: MotivationLevel | null) => {
    if (next === level || pending) return;
    const previous = level;
    setLevel(next);

    startTransition(async () => {
      const result = await callAction(updateLeadMotivation(propertyId, next), {
        successMessage: next
          ? `${address} marked ${MOTIVATION_LEVELS.find((m) => m.value === next)?.label}`
          : `Motivation cleared on ${address}`,
        fallbackMessage: "Could not update motivation",
      });
      if (!result.ok) {
        setLevel(previous);
      } else {
        router.refresh();
      }
    });
  };

  const current = MOTIVATION_LEVELS.find((m) => m.value === level) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            aria-label="Change motivation"
            style={
              current
                ? {
                    backgroundColor: `${current.tint}22`,
                    color: current.tint,
                    borderColor: `${current.tint}55`,
                  }
                : undefined
            }
          >
            {current ? (
              <FlameIcon className="mr-1 size-3.5" fill={current.tint} />
            ) : (
              <FlameIcon className="mr-1 size-3.5" />
            )}
            <span>{current ? current.label : "Motivation"}</span>
            <ChevronDownIcon className="ml-1 size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {MOTIVATION_LEVELS.map((m) => (
          <DropdownMenuItem
            key={m.value}
            onClick={() => change(m.value)}
            className="flex items-center justify-between gap-4"
          >
            <span className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${m.dotClass}`} />
              {m.label}
            </span>
            {m.value === level ? <CheckIcon className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => change(null)}
          className="flex items-center justify-between gap-4"
        >
          <span className="text-muted-foreground">Clear</span>
          {level === null ? <CheckIcon className="size-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
