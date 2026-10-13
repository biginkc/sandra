"use client";

import { ListPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { NORMA_QUEUE_COPY } from "@/lib/norma/queue/copy";

import { NormaQueueDialog } from "../leads/norma-queue-dialog";

/** Messages thread action: queue this thread's lead for Norma through the same dialog and server action as the Leads board. */
export function QueueNormaAction({ propertyId, propertyAddress }: { propertyId: string | null | undefined; propertyAddress: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!propertyId) return null;
  return <>
    <Button type="button" variant="outline" size="sm" data-testid="queue-norma-action" onClick={() => setOpen(true)}>
      <ListPlus className="h-3.5 w-3.5" />{NORMA_QUEUE_COPY.dialog.button}
    </Button>
    {open ? <NormaQueueDialog open leads={[{ id: propertyId, address: propertyAddress ?? propertyId }]} onClose={() => setOpen(false)} onComplete={() => router.refresh()} /> : null}
  </>;
}
