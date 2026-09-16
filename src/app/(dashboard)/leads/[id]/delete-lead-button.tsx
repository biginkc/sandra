"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { deletePropertiesBulk } from "../actions";

type Props = {
  propertyId: string;
  address: string;
  redirectHref?: "/leads" | "/properties" | "/my-leads";
};

/**
 * PageHeader actions-slot button to soft-delete a lead from
 * /leads/[id]. Reuses `deletePropertiesBulk([propertyId])` (admin guard
 * inside the server action) — no new server action introduced. On
 * success, routes to the caller's detail collection since the property is
 * now soft-deleted and a refresh on this page would 404.
 */
export function DeleteLeadButton({ propertyId, address, redirectHref = "/leads" }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    if (pending) return;
    if (
      !window.confirm("Delete this lead permanently? This cannot be undone.")
    ) {
      return;
    }
    startTransition(async () => {
      const result = await callAction(deletePropertiesBulk([propertyId]), {
        successMessage: `Deleted ${address}`,
        fallbackMessage: `Could not delete ${address}`,
      });
      if (result.ok) {
        router.push(redirectHref);
      }
    });
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={pending}
      aria-label="Delete lead"
      title="Delete lead"
      className="text-destructive hover:text-destructive hover:bg-destructive/10"
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}
