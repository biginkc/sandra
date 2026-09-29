"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";
import { archiveSequence, restoreSequence, updateSequence } from "./actions";

export function SequenceRowActions({ sequenceId, isArchived, isActive }: { sequenceId: string; isArchived: boolean; isActive: boolean }) {
  const router = useRouter();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pending, startTransition] = useTransition();
  function setOpen(active: boolean) {
    startTransition(async () => {
      const result = await callAction(updateSequence(sequenceId, { active }), { successMessage: active ? "Drip reopened" : "Drip closed to new leads", fallbackMessage: "Could not update drip" });
      if (result.ok) router.refresh();
    });
  }
  function archive() {
    startTransition(async () => {
      const result = await callAction(archiveSequence(sequenceId), { successMessage: "Drip archived", fallbackMessage: "Could not archive drip" });
      if (result.ok) { setConfirmArchive(false); router.refresh(); }
    });
  }
  return <div className="flex items-center justify-end gap-1 whitespace-nowrap">
    <Link href={`/sequences/${sequenceId}/edit`}><Button variant="ghost" size="sm">Edit</Button></Link>
    <DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>Actions</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isArchived ? <DropdownMenuItem onClick={() => startTransition(async () => { const result = await callAction(restoreSequence(sequenceId), { successMessage: "Drip restored", fallbackMessage: "Could not restore drip" }); if (result.ok) router.refresh(); })}>Restore</DropdownMenuItem>
          : <><DropdownMenuItem onClick={() => setOpen(!isActive)}>{isActive ? "Close to new leads" : "Reopen"}</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={() => setConfirmArchive(true)}>Archive</DropdownMenuItem></>}
      </DropdownMenuContent></DropdownMenu>
    <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}><DialogContent>
      <DialogHeader><DialogTitle>Archive this drip?</DialogTitle><DialogDescription>It will close to new leads. Existing enrollments continue on schedule.</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setConfirmArchive(false)} disabled={pending}>Cancel</Button><Button onClick={archive} disabled={pending}>Archive drip</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
