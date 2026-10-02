"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { listDripChoices, type DripChoice } from "@/app/(dashboard)/sequences/actions";

export type PickResult = { status: "enrolled" | "skipped" | "failed"; reason: string; saved?: boolean };

export function StartDripPicker({
  triggerLabel = "Start follow-up drip",
  onChoose,
  onSelect,
  onLeave,
  disabled = false,
  inline = false,
  triggerTone = "teal",
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
  triggerTone?: "teal" | "outline" | "primary";
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
  const [query, setQuery] = useState("");
  // Popup placement is fixed to the viewport so overflow-clipping ancestors (tables, cards) cannot cut it off.
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; listMax: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const needle = query.trim().toLowerCase();
  const visibleChoices = needle ? choices.filter((choice) => choice.name.toLowerCase().includes(needle)) : choices;

  // Dialogs can embed the same choice and preview surface without a second popup.
  useEffect(() => {
    if (inline) void openPicker();
    // The inline picker loads once when its dialog mounts.
  }, [inline]);

  async function openPicker() {
    // Triggers near the bottom of the screen open the popup upward; the list is sized to the room that is left.
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect && !inline) {
      const below = window.innerHeight - rect.bottom;
      const up = below < 360 && rect.top > below;
      const room = (up ? rect.top : below) - 16;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 328));
      const listMax = Math.max(48, Math.min(320, room - 130));
      setPlace(up ? { left, bottom: window.innerHeight - rect.top + 4, listMax } : { left, top: rect.bottom + 4, listMax });
    } else setPlace(null);
    setOpen(true);
    setMessage("");
    setQuery("");
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

  // The popup lives on document.body, so keyboard focus moves into it on open and returns to the trigger on close.
  useEffect(() => {
    if (inline || !open) return;
    const trigger = triggerRef.current;
    popupRef.current?.focus({ preventScroll: true });
    return () => trigger?.focus({ preventScroll: true });
  }, [inline, open]);

  // A fixed popup would drift from its trigger, so any outside scroll or resize closes it.
  useEffect(() => {
    if (inline || !open) return;
    const close = (event: Event) => {
      if (event.target instanceof Node && (rootRef.current?.contains(event.target) || popupRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [inline, open]);

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

  // The popup renders on document.body so no overflow-hidden ancestor can clip it.
  const wrap = (node: ReactNode) => (inline || typeof document === "undefined" ? node : createPortal(node, document.body));

  return (
    <div ref={rootRef} className={inline ? "relative" : "relative inline-block"}>
      {!inline && <button ref={triggerRef} type="button" onClick={() => open ? setOpen(false) : void openPicker()} disabled={disabled || busy}
        className={`rounded-md border px-3 py-1 text-[11px] font-medium ${triggerTone === "primary" ? "min-h-9 border-primary bg-primary text-primary-foreground" : triggerTone === "outline" ? "min-h-9 border-border bg-card text-foreground" : "min-h-11 border-teal-200 bg-teal-50 text-teal-800"}`}>
        {triggerLabel}
      </button>}
      {(inline || open) && wrap(<div ref={popupRef} tabIndex={inline ? undefined : -1} onKeyDown={inline ? undefined : (event) => { if (event.key === "Escape") setOpen(false); }} className={inline ? "space-y-2" : "fixed z-50 w-80 rounded-md border bg-white p-3 shadow-lg"} style={inline || !place ? undefined : { left: place.left, top: place.top, bottom: place.bottom }} role={inline ? undefined : "dialog"} aria-label="Start follow-up drip">
        {!inline && <p className="mb-2 text-sm font-semibold">Start follow-up drip</p>}
        {!loading && choices.length > 0 && <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search drips" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } }} aria-label="Search drips" className="mb-2 w-full rounded-md border px-2 py-1 text-sm" />}
        {/* The popup can outgrow the viewport once an org has several drips, so its list scrolls. */}
        <div className={inline ? undefined : "overflow-y-auto pr-1"} style={inline ? undefined : { maxHeight: place?.listMax ?? 320 }} data-testid="drip-choice-list">
        {loading ? <p className="text-xs">Loading drips…</p> : choices.length === 0 ? <p className="text-xs">No active drips with steps are available.</p> : visibleChoices.length === 0 ? <p className="text-xs">No drips match “{query.trim()}”.</p> : visibleChoices.map((choice) => (
          <button key={choice.id} type="button" disabled={busy} onClick={() => void choose(choice.id)}
            aria-pressed={selectionOnly ? (selectedSequenceId === undefined ? selectedId : selectedSequenceId) === choice.id : undefined}
            className={`mb-2 block w-full rounded-md border p-2 text-left hover:bg-stone-50 ${(selectedSequenceId === undefined ? selectedId : selectedSequenceId) === choice.id ? 'border-teal-600 bg-teal-50' : ''}`}>
            <span className="block text-sm font-medium">{choice.name}</span>
            <span className="block text-xs text-stone-600">{choice.textCount} texts · over {choice.days} days</span>
            {choice.firstSend && <span className="block text-xs text-stone-600">First text: {choice.firstSend}</span>}
            <span className="block text-xs text-stone-600">Stops when they reply</span>
          </button>
        ))}
        </div>
        {onLeave && <button type="button" disabled={busy} onClick={() => void leave()} className="text-xs underline">Leave it to the follow-up owner</button>}
      </div>)}
      {message && <p role="status" className="mt-1 text-xs">{message}</p>}
    </div>
  );
}
