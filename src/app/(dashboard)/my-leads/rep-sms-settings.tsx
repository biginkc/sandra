"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { AcquisitionRoster } from "@/lib/my-leads/queries";
import type { DialpadFromOption } from "@/lib/messaging/types";
import { loadRepSmsAssignments, loadRepSmsNumbers, saveRepSmsSender } from "./sms-actions";

type Assignment = { id: string; user_id: string; phone_e164: string; label: string; is_default: boolean; active: boolean };
export function RepSmsSettings({ orgId, members }: { orgId: string; members: AcquisitionRoster["members"] }) {
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<DialpadFromOption[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [userId, setUserId] = useState("");
  const [number, setNumber] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  async function load() {
    setBusy(true); setError(null);
    try {
      const [inventory, grants] = await Promise.all([loadRepSmsNumbers(orgId), loadRepSmsAssignments(orgId)]);
      if (!inventory.ok) throw new Error(inventory.error.message);
      if (!grants.ok) throw new Error(grants.error.message);
      setNumbers(inventory.data); setAssignments(grants.data); setLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load texting settings."); }
    finally { setBusy(false); }
  }
  async function save(input: { userId: string; number: string; label: string; isDefault: boolean; active: boolean }) {
    setBusy(true); setError(null);
    try {
      const result = await saveRepSmsSender({ orgId, ...input });
      if (!result.ok) throw new Error(result.error.message);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save assignment."); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 space-y-3 border-t pt-3">
    <p className="font-medium">Rep texting numbers</p>
    <p className="text-sm text-muted-foreground">Assign each rep their company number. Add shared numbers explicitly. Their default is selected when they text a lead in their queue.</p>
    <Button variant="outline" disabled={busy} onClick={() => void load()}>{loaded ? "Refresh texting numbers" : "Manage texting numbers"}</Button>
    {error && <p role="alert">{error}</p>}
    {loaded && <>
      <ul className="space-y-2">{assignments.map(a => <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
        <span>{members.find(m => m.id === a.user_id)?.label ?? "Former member"}: {a.label} · {a.phone_e164}{a.is_default ? " (default)" : ""}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ userId: a.user_id, number: a.phone_e164, label: a.label, isDefault: false, active: false })}>Remove</Button>
      </li>)}</ul>
      <fieldset disabled={busy} className="flex flex-wrap items-center gap-3">
        <label>Rep <select className="rounded border p-2" value={userId} onChange={e => setUserId(e.target.value)}><option value="">Choose rep</option>{members.filter(m => m.active && (m.acquisitionsEnabled || m.role === "owner")).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <label>Number <select className="rounded border p-2" value={number} onChange={e => setNumber(e.target.value)}><option value="">Choose number</option>{numbers.map(n => <option key={n.number} value={n.number}>{n.ownerName} · {n.number}</option>)}</select></label>
        <label><input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} /> Default for this rep</label>
        <Button disabled={!userId || !number} onClick={() => void save({ userId, number, label: numbers.find(n => n.number === number)?.ownerName ?? number, isDefault, active: true })}>Assign texting number</Button>
      </fieldset>
    </>}
  </div>;
}
