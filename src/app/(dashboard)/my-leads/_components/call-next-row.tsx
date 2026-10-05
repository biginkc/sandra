"use client";

import { ChevronDown, Phone } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CallNextRow } from "@/lib/my-leads/call-next";
import { reasonLabel } from "./call-next-reason";

const TEMPERATURE_CLASSES = {
  hot: "bg-red-600 dark:bg-red-500",
  warm: "bg-amber-600 dark:bg-amber-500",
  cold: "bg-blue-600 dark:bg-blue-500",
} as const;

export type CallNextRowProps = {
  item: Pick<CallNextRow, "propertyId" | "reason" | "reasonAt" | "row">;
  now: Date;
  /** False when an owner is looking at a rep's strip: they can read it but not act on it. */
  canAct: boolean;
  busy?: boolean;
  onCall: (propertyId: string) => void;
  onCallToday: (propertyId: string) => void;
  onNotToday: (propertyId: string) => void;
  onDeadNurture: (propertyId: string) => void;
  /** Replaces the ranked reason line (a client-side pin such as "Callback due now"). */
  reasonOverride?: string | null;
};

export function CallNextRowView({
  item,
  now,
  canAct,
  busy = false,
  onCall,
  onCallToday,
  onNotToday,
  onDeadNurture,
  reasonOverride = null,
}: CallNextRowProps) {
  const { propertyId, row } = item;
  const temperature = row.temperature;
  const name = row.homeownerName ?? "Unnamed owner";
  const reason = reasonOverride ?? reasonLabel(item.reason, item.reasonAt, now);
  const disabled = !canAct || busy;
  // No point offering Call on a lead that cannot be dialed (DNC contact, or no phone number).
  const callable = !row.contactDnc && row.phones.some((phone) => phone.trim() !== "");
  const callDisabled = disabled || !callable;
  return (
    <li
      data-testid={`call-next-row-${propertyId}`}
      data-property-id={propertyId}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-2 last:border-b-0"
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex items-center gap-2 truncate text-sm font-semibold">
          {temperature && (
            <span
              className={cn("size-2 shrink-0 rounded-full", TEMPERATURE_CLASSES[temperature])}
              aria-hidden="true"
            />
          )}
          <span className="truncate">{name}</span>
          {temperature && <span className="sr-only">{`${temperature} lead`}</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">{row.address}</p>
      </div>
      <p
        data-testid={`call-next-reason-${propertyId}`}
        className="basis-52 text-xs font-medium text-foreground"
      >
        {reason}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={callDisabled}
          title={callable ? undefined : "No callable phone number"}
          data-testid={`call-next-action-call-${propertyId}`}
          aria-label={`Call ${name}`}
          onClick={() => onCall(propertyId)}
        >
          <Phone aria-hidden="true" />
          Call
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                data-testid={`call-next-menu-${propertyId}`}
                aria-label={`More actions for ${name}`}
              >
                More
                <ChevronDown aria-hidden="true" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem
              data-testid={`call-next-action-call-today-${propertyId}`}
              onClick={() => onCallToday(propertyId)}
            >
              Call today
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={`call-next-action-not-today-${propertyId}`}
              onClick={() => onNotToday(propertyId)}
            >
              Not today
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={`call-next-action-dead-nurture-${propertyId}`}
              variant="destructive"
              onClick={() => onDeadNurture(propertyId)}
            >
              Dead / Nurture
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
