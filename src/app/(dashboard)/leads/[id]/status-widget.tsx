"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { callAction } from "@/lib/errors/call-action";

import {
  updatePropertyStatus,
  type PropertyStatus,
} from "../actions";

// 'prospect' intentionally omitted from the status-change dropdown —
// a VA on the lead detail has already qualified the record, going back
// to prospect is a deletion-grade rollback handled elsewhere (not in v1).
const STATUS_ORDER: readonly PropertyStatus[] = [
  "new_lead",
  "contacted",
  "offer_sent",
  "offer_declined",
  "interested",
  "under_contract",
  "closed",
  "dead",
];

const STATUS_LABEL: Record<PropertyStatus, string> = {
  prospect: "Prospect",
  new_lead: "New Lead",
  contacted: "Contacted",
  offer_sent: "Offer Sent",
  offer_declined: "Offer Declined",
  interested: "Interested",
  under_contract: "Under Contract",
  closed: "Closed",
  dead: "Dead",
};

type Props = {
  propertyId: string;
  initialStatus: PropertyStatus;
  address: string;
};

export function LeadStatusWidget({
  propertyId,
  initialStatus,
  address,
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<PropertyStatus>(initialStatus);
  const [pending, startTransition] = useTransition();

  const change = (next: PropertyStatus) => {
    if (next === status || pending) return;
    const previous = status;
    setStatus(next); // optimistic

    startTransition(async () => {
      const result = await callAction(
        updatePropertyStatus(propertyId, next),
        {
          successMessage: `Moved ${address} to ${STATUS_LABEL[next]}`,
          fallbackMessage: `Could not move ${address}`,
        },
      );
      if (!result.ok) {
        setStatus(previous); // revert
      } else {
        // Refresh server-rendered data so any derived fields stay in sync.
        router.refresh();
      }
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            aria-label="Change status"
          >
            <span>{STATUS_LABEL[status]}</span>
            <ChevronDownIcon className="ml-1 size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {STATUS_ORDER.map((s) => (
          <DropdownMenuItem
            key={s}
            onClick={() => change(s)}
            className="flex items-center justify-between gap-4"
          >
            <span>{STATUS_LABEL[s]}</span>
            {s === status ? <CheckIcon className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
