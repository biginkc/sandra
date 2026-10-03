"use client";

import { useEffect, useRef, useState } from "react";

import { listDripChoices, type DripChoice } from "@/app/(dashboard)/sequences/actions";

export type PickResult = { status: "enrolled" | "skipped" | "failed"; reason: string; saved?: boolean };

// Nearest ancestor that clips its overflow, intersected with the viewport; falls back to the viewport itself.
function clippingBounds(el: HTMLElement | null) {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (/(hidden|auto|scroll|clip)/.test(`${style.overflow} ${style.overflowY}`)) {
      const r = node.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
      break;
    }
  }
  return { top, bottom };
}

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
  // The popup flips upward, and its list is sized, against the nearest clipping ancestor so tables and cards cannot cut it off.
  const [place, setPlace] = useState<{ up: boolean; listMax: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chromeRef = useRef(130);
  const needle = query.trim().toLowerCase();
  const visibleChoices = needle ? choices.filter((choice) => choice.name.toLowerCase().includes(needle)) : choices;

  // Dialogs can embed the same choice and preview surface without a second popup.
  useEffect(() => {
    if (inline) void openPicker();
    // The inline picker loads once when its dialog mounts.
  }, [inline]);

  async function openPicker() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect && !inline) {
      const bounds = clippingBounds(triggerRef.current);
      const below = bounds.bottom - rect.bottom;
      const above = rect.top - bounds.top;
      const up = below < 360 && above > below;
      const room = (up ? above : below) - 16;
      setPlace({ up, listMax: Math.max(48, Math.min(320, room - chromeRef.current)) });
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

  // Measure the popup's non-list height (title, search, padding, leave action) so the list can fill the rest.
  useEffect(() => {
    const popup = popupRef.current;
    const list = listRef.current;
    if (inline || !open || !popup || !list) return;
    const chrome = popup.offsetHeight - list.offsetHeight;
    if (chrome > 0) chromeRef.current = chrome;
  }, [inline, open, loading, choices.length]);

  async function choose(id: string) {
    // A parent can disable the picker while its popup is already open; the open popup must not act.
    if (disabled) return;
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
    if (!onLeave || disabled) return;
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
    <div ref={rootRef} className={inline ? "relative" : "relative inline-block"}>
      {!inline && <button ref={triggerRef} type="button" onClick={() => open ? setOpen(false) : void openPicker()} disabled={disabled || busy}
        className={`rounded-md border px-3 py-1 text-[11px] font-medium ${triggerTone === "primary" ? "min-h-9 border-primary bg-primary text-primary-foreground" : triggerTone === "outline" ? "min-h-9 border-border bg-card text-foreground" : "min-h-11 border-teal-200 bg-teal-50 text-teal-800"}`}>
        {triggerLabel}
      </button>}
      {(inline || open) && <div ref={popupRef} className={inline ? "space-y-2" : `absolute left-0 z-50 w-80 rounded-md border bg-white p-3 shadow-lg ${place?.up ? "bottom-full mb-1" : "top-full mt-1"}`} role={inline ? undefined : "dialog"} aria-label="Start follow-up drip">
        {!inline && <p className="mb-2 text-sm font-semibold">Start follow-up drip</p>}
        {!loading && choices.length > 0 && <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search drips" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } }} aria-label="Search drips" className="mb-2 w-full rounded-md border px-2 py-1 text-sm" />}
        {/* The popup can outgrow the viewport once an org has several drips, so its list scrolls. */}
        <div ref={listRef} className={inline ? undefined : "overflow-y-auto pr-1"} style={inline ? undefined : { maxHeight: place?.listMax ?? 320 }} data-testid="drip-choice-list">
        {loading ? <p className="text-xs">Loading drips…</p> : choices.length === 0 ? <p className="text-xs">No active drips with steps are available.</p> : visibleChoices.length === 0 ? <p className="text-xs">No drips match “{query.trim()}”.</p> : visibleChoices.map((choice) => (
          <button key={choice.id} type="button" disabled={busy || disabled} onClick={() => void choose(choice.id)}
            aria-pressed={selectionOnly ? (selectedSequenceId === undefined ? selectedId : selectedSequenceId) === choice.id : undefined}
            className={`mb-2 block w-full rounded-md border p-2 text-left hover:bg-stone-50 ${(selectedSequenceId === undefined ? selectedId : selectedSequenceId) === choice.id ? 'border-teal-600 bg-teal-50' : ''}`}>
            <span className="block text-sm font-medium">{choice.name}</span>
            <span className="block text-xs text-stone-600">{choice.textCount} texts · over {choice.days} days</span>
            {choice.firstSend && <span className="block text-xs text-stone-600">First text: {choice.firstSend}</span>}
            <span className="block text-xs text-stone-600">Stops when they reply</span>
          </button>
        ))}
        </div>
        {onLeave && <button type="button" disabled={busy || disabled} onClick={() => void leave()} className="text-xs underline">Leave it to the follow-up owner</button>}
      </div>}
      {message && <p role="status" className="mt-1 text-xs">{message}</p>}
    </div>
  );
}
