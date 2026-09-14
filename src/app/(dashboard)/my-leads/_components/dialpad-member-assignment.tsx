'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { loadDialpadMemberCallerOptions, saveDialpadMemberCallerAssignment } from '@/lib/dialpad-voice/configuration';

type Caller = { identity_type: string; provider_identity_id: string; number_e164: string };
type Options = { connectionVersion: number; bindingRevision: number; providerUserId: string; callers: Caller[]; selectedCallers: Caller[] };
type Save = Parameters<typeof saveDialpadMemberCallerAssignment>[0];
const key = (caller: Caller) => JSON.stringify([caller.identity_type, caller.provider_identity_id, caller.number_e164]);
const names: Record<string, string> = { user: 'Personal', office: 'Office', department: 'Department', callcenter: 'Contact center' };

/** Lives beside acquisitions membership management. Configuration does not
 * claim that the rep's desktop is connected or that calling is ready. */
export function DialpadMemberAssignment({ memberId, memberLabel }: { memberId: string; memberLabel: string }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Save | null>(null);

  const load = async () => {
    setBusy(true); setMessage(null);
    try {
      const result = await loadDialpadMemberCallerOptions({ memberId });
      if (!result.ok) { setMessage('Unable to load Dialpad numbers. Check the organization connection and this member’s Dialpad account.'); return; }
      setOptions(result);
      setSelected(new Set(result.selectedCallers.map(key)));
      setPending(null);
    } catch { setMessage('Unable to load Dialpad numbers. Please try again.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!options) return;
    const command = pending ?? { memberId, providerUserId: options.providerUserId,
      connectionVersion: options.connectionVersion, expectedBindingRevision: options.bindingRevision,
      requestId: crypto.randomUUID(), selectedCallers: options.callers.filter(caller => selected.has(key(caller))) };
    setPending(command); setBusy(true); setMessage(null);
    try {
      const result = await saveDialpadMemberCallerAssignment(command);
      if (!result.ok) { setMessage('The save was not confirmed. Retry to check the same save, or reload the current assignments.'); return; }
      setOptions(current => current ? { ...current, bindingRevision: result.bindingRevision, selectedCallers: command.selectedCallers } : current);
      setPending(null); setMessage('Dialpad numbers assigned.');
    } catch { setMessage('The save was not confirmed. Retry to check the same save, or reload the current assignments.'); }
    finally { setBusy(false); }
  };
  return <div className="ml-6 space-y-2 rounded border p-3" aria-label={`Dialpad numbers for ${memberLabel}`}>
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium">Dialpad numbers</span>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>{busy ? 'Working…' : options ? 'Reload assignments' : 'Load numbers'}</Button>
    </div>
    {options && <>
      <p className="text-xs text-muted-foreground">Choose which numbers this member can use from Sandra.</p>
      {options.callers.length === 0 ? <p role="status" className="text-sm">No authorized Dialpad numbers were found.</p> :
        <fieldset disabled={busy || pending !== null} className="space-y-2">
          <legend className="sr-only">Assigned numbers for {memberLabel}</legend>
          {options.callers.map(caller => <label key={key(caller)} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.has(key(caller))} onChange={event => setSelected(previous => {
              const next = new Set(previous); if (event.target.checked) next.add(key(caller)); else next.delete(key(caller)); return next;
            })} />{names[caller.identity_type] ?? 'Dialpad'} · {caller.number_e164}
          </label>)}
        </fieldset>}
      <Button type="button" size="sm" disabled={busy || selected.size === 0} onClick={() => void save()}>{pending ? 'Retry saving' : 'Save Dialpad numbers'}</Button>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>;
}
