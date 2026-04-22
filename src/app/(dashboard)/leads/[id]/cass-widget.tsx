"use client";

import { CheckCircle2Icon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { verifyLeadAddress } from "../actions";

type Props = {
  propertyId: string;
  cassStatus: string;
};

const CASS_LABEL: Record<string, string> = {
  unverified: "Verify",
  verified: "Re-verify",
  invalid: "Re-verify",
  ambiguous: "Re-verify",
};

export function CassWidget({ propertyId, cassStatus }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      const result = await callAction(verifyLeadAddress(propertyId), {
        fallbackMessage: "Address verification failed",
      });
      if (result.ok) {
        const { cassStatus: newStatus, standardized, cacheHit } = result.data;
        if (newStatus === "verified") {
          toast.success(cacheHit ? "Address verified (cached)" : "Address verified", {
            description: standardized || undefined,
          });
        } else if (newStatus === "ambiguous") {
          toast.warning("Address ambiguous", {
            description: "USPS returned multiple matches. Add a unit or city.",
          });
        } else if (newStatus === "invalid") {
          toast.error("Address invalid", {
            description: "USPS could not deliver to this address.",
          });
        } else {
          toast.info(`CASS status: ${newStatus}`);
        }
        router.refresh();
      }
      // Failure path already toasted by callAction. Nothing else to do.
    });
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={run}
      disabled={pending}
      aria-label="Verify address with USPS CASS"
    >
      {cassStatus === "verified" ? (
        <CheckCircle2Icon className="size-3.5" />
      ) : (
        <RefreshCwIcon className={`size-3.5 ${pending ? "animate-spin" : ""}`} />
      )}
      <span>{pending ? "Verifying…" : CASS_LABEL[cassStatus] ?? "Verify"}</span>
    </Button>
  );
}
