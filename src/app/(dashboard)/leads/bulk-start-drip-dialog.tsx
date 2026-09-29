"use client";

import { useState } from "react";
import { StartDripPicker } from "@/components/sequences/start-drip-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { groupBulkDripResults, startBulkDrip, type BulkDripResult } from "./bulk-start-drip";

export function BulkStartDripDialog({ open, leads, onClose, onComplete }: {
  open: boolean;
  leads: { id: string; address: string }[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<BulkDripResult[] | null>(null);

  async function choose(sequenceId: string) {
    setRunning(true);
    setResults(null);
    setDone(0);
    try {
      const settled = await startBulkDrip(sequenceId, leads, setDone);
      setResults(settled);
      onComplete();
      return { status: "enrolled" as const, reason: "" };
    } finally {
      setRunning(false);
    }
  }

  const started = results?.filter((result) => result.status === "enrolled").length ?? 0;
  return <Dialog open={open} onOpenChange={(next) => { if (!next && !running) { setResults(null); setDone(0); onClose(); } }}>
    <DialogContent showCloseButton={!running} className="sm:max-w-lg">
      <DialogHeader><DialogTitle>Start drip for {leads.length} selected leads</DialogTitle></DialogHeader>
      {running ? <p role="status" className="text-sm">Starting drips… {done} of {leads.length} processed</p> : null}
      {!running && !results ? <StartDripPicker inline onChoose={choose} /> : null}
      {results ? <div className="space-y-3 text-sm" aria-label="Drip results">
        <p role="status">{started} started · {results.length - started} skipped or failed</p>
        {groupBulkDripResults(results).map((group) => <details key={`${group.status}-${group.reason}`}>
          <summary className="cursor-pointer font-medium">{group.leads.length} {group.status}: {group.reason}</summary>
          <ul className="text-muted-foreground list-disc pl-5">{group.leads.map((lead) => <li key={lead.propertyId}>{lead.address}</li>)}</ul>
        </details>)}
        <Button variant="outline" size="sm" onClick={() => { setResults(null); onClose(); }}>Done</Button>
      </div> : null}
    </DialogContent>
  </Dialog>;
}
