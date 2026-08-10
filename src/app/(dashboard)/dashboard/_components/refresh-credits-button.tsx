"use client";

import { RefreshCwIcon } from "lucide-react";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { refreshSkipTraceBalanceAction } from "../credit-actions";

export function RefreshCreditsButton() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await callAction(refreshSkipTraceBalanceAction(), {
            successMessage: "Skip-trace credits refreshed",
            fallbackMessage: "Could not refresh provider credits",
          });
        })
      }
    >
      <RefreshCwIcon className={pending ? "animate-spin" : undefined} />
      {pending ? "Checking…" : "Refresh"}
    </Button>
  );
}
