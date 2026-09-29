"use client";

import { useEffect, useState } from "react";

import { listDripChoices, type DripChoice } from "@/app/(dashboard)/sequences/actions";

export type PickResult = { status: "enrolled" | "skipped" | "failed"; reason: string; saved?: boolean };

export function StartDripPicker({
  triggerLabel = "Start follow-up drip",
  onChoose,
  onSelect,
  onLeave,
  disabled = false,
  inline = false,
  selectionOnly = false,
  selectedSequenceId,
  previewChoices,
  onResult,
}: {
  triggerLabel?: string;
  onChoose?: (sequenceId: string) => Promise<PickResult>;
  onSelect?: (sequenceId: string) => void;
  onLeave?: () => Promise<void>;
  disabled?: boolean;
  inline?: boolean;
  selectionOnly?: boolean;
  selectedSequenceId?: string | null;
  previewChoices?: DripChoice[];
  onResult?: (result: PickResult, sequenceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<DripChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Dialogs can embed the same choice and preview surface without a second popup.
  useEffect(() => {
    if (inline) void openPicker();
    // The inline picker loads once when its dialog mounts.
  }, [inline]);

  async function openPicker() {
    setOpen(true);
    setMessage("");
    if (previewChoices) { setChoices(previewChoices); return; }
    setLoading(true);
    try {
      const result = await listDripChoices();
      if (result.ok) setChoices(result.data);
      else setMessage(result.error.message);
    } catch {
      setMessage("Could not load follow-up drips.");
    } finally {
      setLoading(false);
    }
  }

  async function choose(id: string) {
    if (selectionOnly) { setSelectedId(id); onSelect?.(id); return; }
    if (!onChoose) return;
    setBusy(true);
    try {
      const result = await onChoose(id);
      onResult?.(result, id);
      setMessage(result.status === "enrolled" ? "Drip started." : `${result.saved === false ? "Not enrolled" : "Saved. Not enrolled"}: ${result.reason}`);
      if (result.status === "enrolled") setOpen(false);
    } catch {
      setMessage("Could not start the drip.");
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!onLeave) return;
    setBusy(true);
    try {
      await onLeave();
      setOpen(false);
      setMessage("Saved for the follow-up owner.");
    } catch {
      setMessage("Could not save this outcome.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={inline ? "relative" : "relative inline-block"}>
      {!inline && <button type="button" onClick={() => open ? setOpen(false) : void openPicker()} disabled={disabled || busy}
        className="min-h-11 rounded-md border border-teal-200 bg-teal-50 px-3 py-1 text-[11px] font-medium text-teal-800">
        {triggerLabel}
      </button>}
      {(inline || open) && <div className={inline ? "space-y-2" : "absolute left-0 top-full z-50 mt-1 w-80 rounded-md border bg-white p-3 shadow-lg"} role={inline ? undefined : "dialog"} aria-label="Start follow-up drip">
        {!inline && <p className="mb-2 text-sm font-semibold">Start follow-up drip</p>}
        {loading ? <p className="text-xs">Loading drips…</p> : choices.length === 0 ? <p className="text-xs">No active drips with steps are available.</p> : choices.map((choice) => (
          <button key={choice.id} type="button" disabled={busy} onClick={() => void choose(choice.id)}
            aria-pressed={selectionOnly ? (selectedSequenceId === undefined ? selectedId : selectedSequenceId) === choice.id : undefined}
            className={`mb-2 block w-full rounded-md border p-2 text-left hover:bg-stone-50 ${(selectedSequenceId === undefined ? selectedId : selectedSequenceId) === choice.id ? 'border-teal-600 bg-teal-50' : ''}`}>
            <span className="block text-sm font-medium">{choice.name}</span>
            <span className="block text-xs text-stone-600">{choice.textCount} texts · over {choice.days} days</span>
            {choice.firstSend && <span className="block text-xs text-stone-600">First text: {choice.firstSend}</span>}
            <span className="block text-xs text-stone-600">Stops when they reply</span>
          </button>
        ))}
        {onLeave && <button type="button" disabled={busy} onClick={() => void leave()} className="text-xs underline">Leave it to the follow-up owner</button>}
      </div>}
      {message && <p role="status" className="mt-1 text-xs">{message}</p>}
    </div>
  );
}
