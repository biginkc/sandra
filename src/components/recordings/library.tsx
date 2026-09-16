'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { LibraryCall, LibraryFile, LibraryResult } from '@/lib/recordings/data';
import type { RecordingScope, SearchParams } from '@/lib/recordings/filters';
import { TIME_ZONE } from '@/lib/recordings/filters';
import { PageHeader } from '@/components/page-header';

const field = 'mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm';
const button = 'rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50';
const labels: Record<string,string> = { available: 'Available', pending: 'Processing', failed: 'Failed', missing: 'Missing', external: 'External / unresolved', partial: 'Partial', all: 'All statuses' };
function label(value: string) { return ({ sandra_softphone: 'Sandra phone', jitter: 'Jitter', twilio: 'Twilio', dialpad: 'Dialpad', connected_human: 'Connected with person' } as Record<string,string>)[value] ?? value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()); }
function length(seconds: number | null) { return seconds === null ? 'Length unknown' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function Player({ file, scope }: { file: LibraryFile; scope: RecordingScope }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const resume = useRef({ time: 0, rate: 1, playing: true });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  async function play() {
    controller.current?.abort(); controller.current = new AbortController();
    if (audio.current) resume.current = { time: audio.current.currentTime, rate: audio.current.playbackRate, playing: !audio.current.paused };
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/${scope === 'owner' ? 'owner/recordings' : 'my-recordings'}/${encodeURIComponent(file.id)}/playback`, { method: 'POST', cache: 'no-store', signal: controller.current.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Recording unavailable');
      if (mounted.current) { if (data.externalUrl) setExternalUrl(data.externalUrl); else setUrl(data.signedUrl); }
    } catch (e) { if (mounted.current && !(e instanceof Error && e.name === 'AbortError')) setError(e instanceof Error ? e.message : 'Recording unavailable'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="space-y-2 rounded-lg border p-3">
    <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{length(file.duration)} · {labels[file.status] ?? file.status}</span>
      {(file.status === 'available' || file.kind === 'reference') && <button className={button} disabled={busy} onClick={play}>{busy ? 'Loading…' : url ? 'Refresh playback link' : file.kind === 'reference' ? 'Resolve external reference' : 'Play recording'}</button>}
    </div>
    {url && <audio ref={audio} key={url} controls preload="metadata" className="w-full" src={url} onLoadedMetadata={() => {
      if (!audio.current) return;
      audio.current.currentTime = Math.min(resume.current.time, Number.isFinite(audio.current.duration) ? audio.current.duration : resume.current.time);
      audio.current.playbackRate = resume.current.rate;
      if (resume.current.playing) void audio.current.play().catch(() => {});
    }} onError={() => setError('Audio could not load. Refresh the playback link to retry; the file may have expired or become unavailable.')} />}
    {externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">Open external recording reference</a>}
    {file.status === 'external' && <p className="text-sm text-muted-foreground">This reference has not been resolved to a supported audio file.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
function CallCard({ call, scope }: { call: LibraryCall; scope: RecordingScope }) {
  const date = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(call.at));
  return <article className="rounded-xl border bg-card p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-semibold">{call.contact}</h2><p className="text-sm text-muted-foreground">{call.address}</p>{call.phone && <p className="text-sm">{call.phone}</p>}</div>
      <div className="text-sm md:text-right"><p>{date} CT</p><p className="text-muted-foreground">{scope === 'owner' ? `${call.actor_name} · ` : ''}{label(call.direction)} · {label(call.source)}</p></div>
    </div>
    <div className="my-3 flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{label(call.outcome)}</span><span>· {labels[call.status]}</span><span>· {call.purpose.replaceAll('_',' ')}</span>{call.transcript && <span>· Transcript available</span>}{call.summary && <span>· Summary available</span>}</div>
    {call.conflicting && <p className="mb-3 text-sm text-amber-700">Caller attribution conflicts. This call is restricted to owners in the recording library.</p>}
    <details><summary className="cursor-pointer text-sm font-medium">{call.files.length} recording {call.files.length === 1 ? 'file' : 'files'}</summary>
      <div className="mt-3 space-y-3">{call.files.map(f => <Player key={f.id} file={f} scope={scope} />)}{!call.files.length && <p className="text-sm text-muted-foreground">No recording file is linked to this call.</p>}</div>
    </details>
  </article>;
}
export function RecordingLibrary({ result, scope, values }: { result: LibraryResult & { nextCursor: string | null; viewerId: string }; scope: RecordingScope; values: SearchParams }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [identityChanged, setIdentityChanged] = useState(false);
  useEffect(() => {
    const db = createClient();
    const { data } = db.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (session?.user.id && session.user.id !== result.viewerId)) {
        setIdentityChanged(true);
        window.location.replace(event === 'SIGNED_OUT' ? '/login' : window.location.pathname);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [result.viewerId]);
  if (identityChanged) return <p className="p-8">Refreshing recording access…</p>;
  const base = scope === 'owner' ? '/owner/recordings' : '/my-recordings';
  const value = (name: string, fallback = '') => typeof values[name] === 'string' ? values[name] as string : fallback;
  const select = (name: string, title: string, options: [string,string][], fallback = 'all') => <label className="text-sm">{title}<select className={field} name={name} defaultValue={value(name,fallback)}>{options.map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>;
  const next = new URLSearchParams();
  for (const [key,v] of Object.entries(values)) if (key !== 'cursor' && v) for (const item of Array.isArray(v) ? v : [v]) next.append(key,item);
  if (result.nextCursor) next.set('cursor',result.nextCursor);
  return <>
    <PageHeader
      breadcrumb={[{ label: 'Workspace' }, { label: scope === 'owner' ? 'Recordings' : 'My Recordings' }]}
      title={scope === 'owner' ? 'Recordings' : 'My Recordings'}
      description={<>{scope === 'owner' ? 'Browse recordings across BMH Group.' : 'Recordings from calls attributed to you.'} Dates are shown in Central time.</>}
    />
    <form key={JSON.stringify(values)} action={base} onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget); const query = new URLSearchParams();
      for (const [key,v] of data) if (typeof v === 'string' && v) query.append(key,v);
      startTransition(() => router.push(`${base}?${query}`));
    }} className="space-y-4 rounded-xl border bg-card p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm sm:col-span-2">Contact, property address or phone<input name="q" className={field} defaultValue={value('q')} maxLength={200} placeholder="Search recordings" /></label>
        {select('period','Call date',[['all','All dates'],['today','Today'],['7days','Last 7 days'],['30days','Last 30 days'],['custom','Custom dates']])}
        {select('status','Recording availability',Object.entries(labels),'available')}
        <label className="text-sm">Custom start date<input type="date" name="from" className={field} defaultValue={value('from')} /></label>
        <label className="text-sm">Custom end date<input type="date" name="to" className={field} defaultValue={value('to')} /></label>
        <label className="text-sm">Minimum file length (seconds)<input type="number" name="min" min="0" max="604800" className={field} defaultValue={value('min')} /></label>
        <label className="text-sm">Maximum file length (seconds)<input type="number" name="max" min="0" max="604800" className={field} defaultValue={value('max')} /></label>
      </div>
      <details><summary className="cursor-pointer text-sm font-medium">More filters</summary><div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {select('source','Recording source',[['','All sources'],...result.sources.map(x => [x,label(x)] as [string,string])],'')}
        {select('outcome','Call outcome / disposition',[['','All outcomes'],...result.outcomes.map(x => [x,label(x)] as [string,string])],'')}
        {select('direction','Direction',[['all','All directions'],['outbound','Outbound'],['inbound','Inbound'],['unknown','Unknown']])}
        {select('purpose','Call purpose',[['all','All calls'],['customer','Customer'],['internal_training','Training'],['unknown','Unknown']])}
        {select('transcript','Transcript',[['all','Any transcript status'],['yes','Available'],['no','Unavailable']])}
        {select('summary','Summary',[['all','Any summary status'],['yes','Available'],['no','Unavailable']])}
        {scope === 'owner' && <>
          {select('group','Group',[['all','All users'],['acquisitions','Everyone currently active in acquisitions'],['former','Former / inactive users'],['unattributed','Unattributed or conflicting']])}
          {select('association','Associations',[['all','All associations'],['missing','Missing recording or lead association']])}
          <label className="text-sm sm:col-span-2">Users (select one or more)<select multiple name="user" className={field} defaultValue={Array.isArray(values.user) ? values.user : values.user ? [values.user] : []}>{result.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select><span className="text-xs text-muted-foreground">No selection means all users. Hold Command or Control to select several.</span></label>
        </>}
      </div></details>
      <div className="flex items-center gap-3"><button type="submit" className={button} disabled={pending}>{pending ? 'Applying…' : 'Apply filters'}</button><Link href={base} className="text-sm underline">Reset filters</Link><span className="text-xs text-muted-foreground">Length matches each file separately.</span></div>
    </form>
    <section aria-label="Recording availability" className="rounded-xl bg-muted/50 p-4"><p className="mb-2 text-sm font-medium">Availability across the current filters, before the status filter</p><div className="flex flex-wrap gap-4 text-sm">{Object.entries(result.availability).map(([status,n]) => <span key={status}>{labels[status] ?? status}: <strong>{n}</strong></span>)}</div><p className="mt-2 text-xs text-muted-foreground">Audio availability can change. Playback checks the selected file when requested.</p></section>
    <p role="status" className="text-sm text-muted-foreground">{result.total} matching calls · Newest first · Up to 50 per page</p>
    <div className="space-y-4" aria-busy={pending}>{result.rows.map(call => <CallCard key={call.id} call={call} scope={scope} />)}{!result.rows.length && <p className="rounded-xl border p-8 text-center text-muted-foreground">No recordings match these filters. Try All statuses or a wider date range.</p>}</div>
    {result.nextCursor && <Link className={button} href={`${base}?${next}`} prefetch={false}>Next 50 calls</Link>}
  </>;
}
