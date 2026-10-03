'use client';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { RepSmsSettings } from './rep-sms-settings';
import { Button } from '@/components/ui/button';
import { useOptionalSoftphone } from '@/components/softphone/softphone-provider';
import { BookAppointmentPopover } from '@/components/appointments/book-appointment-popover';
import type { AcquisitionKpis,AcquisitionRoster,QueueSnapshot,QueueRow,MyLeadRowLookup } from '@/lib/my-leads/queries';
import { MY_LEAD_ROW_REASON_COPY } from '@/lib/my-leads/row-reasons';
import type { MyLeadDripSnapshot } from '@/lib/my-leads/drip-queries';
import { WorkflowRecoveryContext } from './_components/workflow-form';
import { useAttemptWorkflow } from './_components/use-attempt-workflow';
import { MyLeadsQueue } from './_components/queue';
import { AcquisitionAttemptDialog } from './_components/attempt-dialog';
import { AcquisitionReadinessDialog } from './_components/readiness-dialog';
import { AcquisitionOfferDialog } from './_components/offer-dialog';
import { AcquisitionLifecycleDialog } from './_components/lifecycle-dialog';
import { DialpadPanel,type DialpadCallRequest } from './_components/dialpad-panel';
import type { DialpadPanelBootstrap } from '@/lib/dialpad-cti/dispatch';
import type { MyLeadAction,MyLeadStage,AcquisitionLifecycleMode } from './_components/types';
import { detailView,kpiTiles,queueRow as queueRowView,stagePages } from './adapter';
import { loadMyLeadCallReferences,loadMyLeadRow,loadMyLeads,loadMyLeadsStage,loadMyLeadDetail,changeAcquisitionDesignation,changeAcquisitionSettings } from './actions';

type Props={viewer:{userId:string;orgId:string;isOwner:boolean};roster:AcquisitionRoster;initialMemberId:string;initialSnapshot:QueueSnapshot|null;initialKpis:AcquisitionKpis|null;initialDrips?:MyLeadDripSnapshot|null;dialpad?:DialpadPanelBootstrap|null;initialSearch?:string;focus?:MyLeadsFocus|null};
/** A lead opened from a deep link (lead page or Messages). */
export type MyLeadsFocus={propertyId:string|null;memberId?:string|null;notice:string|null;pin?:QueueRow|null};
/** The latest single-row lookup for the deep-linked lead; part of the read model. */
type PinRead={id:string;lookup:MyLeadRowLookup}|null;

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Reconciles the single-row lookup for the deep-linked lead into what is rendered.
 * - Unavailable: the lead is removed from every section (stages, drips, replied pins).
 * - Found: any loaded copy that is older (other episode, lower queueVersion, other
 *   stage) is dropped. A stale stage-row copy is replaced in place when the
 *   authoritative row belongs to the same section; otherwise the caller pins it.
 * Counts are deliberately left as the server snapshot reports them until the next
 * refresh: they describe the server's view at snapshotAt, and a lookup for one lead
 * must not make them disagree with their own timestamp.
 */
function reconcileWithPin(snapshot:QueueSnapshot,drips:MyLeadDripSnapshot|null,pin:PinRead,id:string|null){
  if(!id||!pin||pin.id!==id)return {snapshot,drips};
  const lookup=pin.lookup;
  const stale=(row:QueueRow)=>lookup.status==='unavailable'||row.assignmentEpisodeId!==lookup.row.assignmentEpisodeId||row.queueVersion<lookup.row.queueVersion||row.stage!==lookup.row.stage;
  const stages={...snapshot.stages} as QueueSnapshot['stages'];
  for(const key of Object.keys(stages) as (keyof typeof stages)[]){
    const page=stages[key];if(!page)continue;
    stages[key]={...page,rows:page.rows.flatMap(row=>row.propertyId!==id||!stale(row)?[row]:lookup.status==='found'&&lookup.row.stage===row.stage?[lookup.row]:[])};
  }
  const keepDrip=(drip:MyLeadDripSnapshot['active'][number])=>drip.propertyId!==id||!drip.queueRow||!stale(drip.queueRow);
  const nextDrips=drips?{...drips,active:drips.active.filter(keepDrip),replied:drips.replied.filter(keepDrip)}:drips;
  return {snapshot:{...snapshot,stages},drips:nextDrips};
}
const refreshTime = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZone:'America/Chicago',timeZoneName:'short'});

export function MyLeadsClient({viewer,roster,initialMemberId,initialSnapshot,initialKpis,initialDrips=null,dialpad=null,initialSearch='',focus=null}:Props) {
  const router=useRouter();const softphone=useOptionalSoftphone();
  const [member,setMember]=useState(initialMemberId);const [search,setSearch]=useState(initialSearch);
  const [snapshot,setSnapshot]=useState(initialSnapshot);const [kpis,setKpis]=useState(initialKpis);
  const [drips,setDrips]=useState(initialDrips);
  const tiles=useMemo(()=>kpis?kpiTiles(kpis):null,[kpis]);
  const [lastCheckedAt,setLastCheckedAt]=useState(initialSnapshot?.snapshotAt??null);
  const reviewingDetails=useRef(false);
  const [reviewing,setReviewing]=useState(false);
  const onReviewingChange=useCallback((active:boolean)=>{reviewingDetails.current=active;setReviewing(active);},[]);
  const [error,setError]=useState<string|null>(null);const [loadingStages,setLoadingStages]=useState<Set<MyLeadStage>>(new Set());
  const [refreshError,setRefreshError]=useState<string|null>(null);
  const [callOptions,setCallOptions]=useState<{propertyId:string;options:{id:string;label:string}[];error:string|null}|null>(null);
  const [callRetry,setCallRetry]=useState(0);
  const [dialpadRequest,setDialpadRequest]=useState<DialpadCallRequest|null>(null);
  const dialpadNonce=useRef(0);
  const onCallRequestHandled=useCallback((nonce:number)=>{
    setDialpadRequest(current=>current?.nonce===nonce?null:current);
  },[]);
  const [dialog,setDialog]=useState<{action:MyLeadAction;row:QueueRow;callActivityId?:string|null}|null>(null);
  type Opening = {action:MyLeadAction;row:QueueRow;scope:string;callActivityId?:string|null};
  type CurrentRead = (Awaited<ReturnType<typeof loadMyLeads>> & {pin?:PinRead}) | null;
  const openingScope=JSON.stringify([member,search]);
  const activeScope=useRef(openingScope);activeScope.current=openingScope;
  const currentSnapshot=useRef(snapshot);currentSnapshot.current=snapshot;
  const currentDrips=useRef(drips);
  useEffect(()=>{currentDrips.current=drips;},[drips]);
  const [pinRead,setPinRead]=useState<PinRead>(()=>focus?.propertyId&&focus.pin?{id:focus.propertyId,lookup:{status:'found',row:focus.pin,snapshotAt:initialSnapshot?.snapshotAt??''}}:null);
  const [pinNotice,setPinNotice]=useState<string|null>(null);
  const currentPin=useRef(pinRead);
  useEffect(()=>{currentPin.current=pinRead;},[pinRead]);
  // The deep-linked lead whose single-row lookup rides along with every refresh.
  const pinWanted=useRef<string|null>(focus?.propertyId??null);
  const readPin=async(propertyId:string,memberId:string):Promise<PinRead|'error'>=>{
    try {
      const result=await loadMyLeadRow({memberId,propertyId});
      if(result.ok)return {id:propertyId,lookup:result.lookup};
      if(result.code==='NOT_FOUND')return {id:propertyId,lookup:{status:'unavailable',reason:'not_found'}};
      return 'error';
    } catch {return 'error';}
  };
  const applyPin=(pin:PinRead)=>{
    setPinRead(pin);
    setPinNotice(pin?.lookup.status==='unavailable'?MY_LEAD_ROW_REASON_COPY[pin.lookup.reason]:null);
  };
  /**
   * The authoritative row for a lead: an unavailable single-row lookup removes it
   * everywhere; otherwise the lookup's episode wins and a newer copy of that same
   * episode (higher queueVersion) from the lists may replace it. Never a stale copy
   * from another episode.
   */
  const findRow=(readSnapshot:QueueSnapshot|null,readDrips:MyLeadDripSnapshot|null|undefined,id:string,pin?:PinRead)=>{
    const forLead=pin?.id===id?pin.lookup:null;
    if(forLead?.status==='unavailable')return null;
    const candidates=[
      ...Object.values(readSnapshot?.stages??{}).flatMap(page=>page?.rows??[]).filter(row=>row.propertyId===id),
      ...[...(readDrips?.replied??[]),...(readDrips?.active??[])].filter(row=>row.propertyId===id).flatMap(row=>row.queueRow?[row.queueRow]:[]),
    ];
    if(forLead?.status==='found'){
      const pinned=forLead.row;
      return candidates.filter(row=>row.assignmentEpisodeId===pinned.assignmentEpisodeId&&row.queueVersion>pinned.queueVersion)
        .sort((a,b)=>b.queueVersion-a.queueVersion)[0]??pinned;
    }
    return candidates[0]??null;
  };
  const mutationReads=useRef(new Map<string,{scope:string;episodeId:string|null;requestId:number;read:Promise<CurrentRead>}>());
  const renderedRead=useRef<{snapshot:QueueSnapshot;requestId:number;scope:string}|null>(null);
  useEffect(()=>{
    const read=renderedRead.current;if(!read||read.snapshot!==snapshot)return;
    // A committed newer authorized read supersedes both successful and failed barriers.
    for(const [propertyId,barrier] of mutationReads.current){
      if(barrier.scope===read.scope&&barrier.requestId<=read.requestId)mutationReads.current.delete(propertyId);
    }
  },[snapshot]);
  const pendingOpening=useRef<Opening|null>(null);
  const [openingStatus,setOpeningStatus]=useState<{opening:Opening;message:string;busy:boolean}|null>(null);
  const cancelOpening=()=>{pendingOpening.current=null;setOpeningStatus(null);};
  useEffect(()=>{pendingOpening.current=null;setOpeningStatus(null);mutationReads.current.clear();},[openingScope]);
  const [detailRevision,setDetailRevision]=useState(0);
  const [recipient,setRecipient]=useState(roster.settings.recipientId??'');const [settingsBusy,setSettingsBusy]=useState(false);
  const initialEffect=useRef(Boolean(initialSnapshot&&initialKpis));const request=useRef(0);
  const serverScopeKey=member;
  const previousServerScope=useRef(serverScopeKey);
  const refresh=useCallback(async(background=false)=>{
    if(!roster.settings.enabled) return null;
    const id=++request.current;
    try {
      const pinId=pinWanted.current;
      const [loaded,pinResult]=await Promise.all([loadMyLeads({memberId:member,search,period:'today'}),pinId?readPin(pinId,member):Promise.resolve(undefined)]);
      // A newer refresh, or a cleared/changed deep-link target, supersedes this read.
      if(id!==request.current)return null;
      const pin:PinRead|undefined=pinResult==='error'?(currentPin.current?.id===pinId?currentPin.current:null):pinResult;
      const result=loaded.ok&&pin!==undefined?{...loaded,pin}:loaded;
      if(result.ok){
        if(pinResult&&pinResult!=='error'&&pinWanted.current===pinId)applyPin(pinResult);
        // Replacing a paginated/reordered queue can unmount its recording player.
        // Background checks may update KPIs, but must leave open lead details alone.
        if(!background||!reviewingDetails.current){renderedRead.current={snapshot:result.snapshot,requestId:id,scope:JSON.stringify([member,search])};setSnapshot(result.snapshot);}
        else {
          // Playback keeps the visible queue stable, but a successful read must still
          // replace a failed barrier before the next workflow opening.
          for(const [propertyId,barrier] of mutationReads.current){
            if(barrier.scope===JSON.stringify([member,search])&&barrier.requestId<=id)mutationReads.current.set(propertyId,{...barrier,requestId:id,read:Promise.resolve(result)});
          }
        }
        setKpis(result.kpis);setDrips(result.drips);setLastCheckedAt(result.snapshot.snapshotAt);setError(null);setRefreshError(null);
      }
      else setRefreshError(result.message);
      return result;
    } catch {
      if(id===request.current)setRefreshError('My Leads could not refresh.');
      return null;
    }
  },[member,search,roster.settings.enabled]);
  useEffect(()=>{
    if(initialEffect.current){initialEffect.current=false;return;}
    const scopeChanged=previousServerScope.current!==serverScopeKey;
    previousServerScope.current=serverScopeKey;
    ++request.current;
    if(scopeChanged){setSnapshot(null);setKpis(null);setDrips(null);}
    const timer=setTimeout(()=>void refresh(),250);
    return()=>{clearTimeout(timer);};
  },[refresh,serverScopeKey]);
  useEffect(()=>{
    if(!roster.settings.enabled)return;
    const delay=Math.min(REFRESH_INTERVAL_MS,Math.max(1000,snapshot?.nextWarningAt?Date.parse(snapshot.nextWarningAt)-Date.now():REFRESH_INTERVAL_MS));
    let cancelled=false;
    // A failed read does not replace snapshot, so it cannot re-arm this effect.
    // Keep retrying even after transport/authentication failures or hidden tabs.
    const tick=async()=>{
      try {if(!document.hidden)await refresh(true);}
      finally {if(!cancelled)timer=setTimeout(()=>void tick(),REFRESH_INTERVAL_MS);}
    };
    let timer=setTimeout(()=>void tick(),delay);
    const onVisible=()=>{if(!document.hidden)void refresh(true);};
    document.addEventListener('visibilitychange',onVisible);window.addEventListener('focus',onVisible);
    return()=>{cancelled=true;clearTimeout(timer);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('focus',onVisible);};
  },[snapshot,refresh,roster.settings.enabled]);
  const rawRow=(id:string)=>findRow(snapshot,drips,id,pinRead);
  const finishOpening=async(opening:Opening,read:Promise<CurrentRead>)=>{
    pendingOpening.current=opening;
    setOpeningStatus({opening,message:'Loading current lead…',busy:true});
    const result=await read;
    if(pendingOpening.current!==opening||activeScope.current!==opening.scope)return;
    if(!result?.ok){setOpeningStatus({opening,message:'Could not load current lead details. Retry to continue.',busy:false});return;}
    const fresh=findRow(result.snapshot,result.drips,opening.row.propertyId,result.pin);
    if(!fresh||fresh.assignmentEpisodeId!==opening.row.assignmentEpisodeId){
      setOpeningStatus({opening,message:'This lead is unavailable or its assignment changed. Refresh the queue and reopen it.',busy:false});return;
    }
    const latest=findRow(currentSnapshot.current,currentDrips.current,fresh.propertyId,currentPin.current);
    // Do not rewind an even newer rendered snapshot, or silently change episodes.
    if(!latest||latest.assignmentEpisodeId!==fresh.assignmentEpisodeId){setOpeningStatus({opening,message:'This lead assignment changed. Refresh the queue and reopen it.',busy:false});return;}
    const row=latest&&latest.queueVersion>=fresh.queueVersion?latest:fresh;
    pendingOpening.current=null;setOpeningStatus(null);setCallOptions(null);
    setDialog({action:opening.action,row,callActivityId:opening.callActivityId});
  };
  const retryOpening=()=>{
    const opening=pendingOpening.current;if(!opening||openingStatus?.busy)return;
    const read=refresh();mutationReads.current.set(opening.row.propertyId,{scope:opening.scope,episodeId:opening.row.assignmentEpisodeId,requestId:request.current,read});
    void finishOpening(opening,read);
  };
  const action=(kind:MyLeadAction,id:string,callActivityId?:string|null)=>{
    const row=rawRow(id);if(!row)return;
    cancelOpening();
    if(kind==='start-call'&&dialpad){
      // An active Dialpad connection routes calls through the audited CTI flow; the server re-derives org and rep and revalidates at dispatch.
      if(member!==viewer.userId){setError('Open your own queue to call with Dialpad.');return;}
      setError(null);
      setDialpadRequest({nonce:++dialpadNonce.current,propertyId:row.propertyId,contactId:row.contactId??null,label:row.homeownerName??row.address});return;
    }
    if(kind==='start-call'){
      if(!softphone?.callingEnabled){setError('Calling is not enabled.');return;}
      softphone.openLead({id:row.propertyId,contactId:row.contactId,firstName:row.homeownerName?.split(' ')[0]??'',name:row.homeownerName??row.address,address:row.address,state:row.state,
        phones:row.phones,dncLocked:false,contactDnc:row.contactDnc,callable:row.phones.some(phone=>!!phone.trim())&&!row.contactDnc});return;
    }
    const previous=mutationReads.current.get(id);
    if(previous?.scope===openingScope&&previous.episodeId===row.assignmentEpisodeId){
      void finishOpening({action:kind,row,scope:openingScope,callActivityId},previous.read);return;
    }
    cancelOpening();setCallOptions(null);setDialog({action:kind,row,callActivityId});

  };
  useEffect(()=>{
    if(dialog?.action!=='log-attempt')return;
    let cancelled=false;
    const propertyId=dialog.row.propertyId;
    setCallOptions(null);
    void loadMyLeadCallReferences(propertyId,member).then(result=>{
      if(!cancelled)setCallOptions({propertyId,options:result.ok?result.options:[],error:result.ok?null:result.message});
    }).catch(()=>{
      if(!cancelled)setCallOptions({propertyId,options:[],error:'Could not load Sandra calls.'});
    });
    return()=>{cancelled=true;};
  },[dialog,member,callRetry]);
  const readRecoveryRow=useCallback(async(opening:{row:QueueRow})=>{
    // The single-row lookup is authoritative for any lead; the list read only
    // supplies a newer copy of the same episode, or the fallback if the lookup fails.
    const [result,pin]=await Promise.all([loadMyLeads({memberId:member,search,period:'today'}),readPin(opening.row.propertyId,member)]);
    if(pin==='error'){
      if(!result.ok)throw new Error('read failed');
      return findRow(result.snapshot,result.drips,opening.row.propertyId);
    }
    if(!result.ok)return pin?.lookup.status==='found'?pin.lookup.row:null;
    return findRow(result.snapshot,result.drips,opening.row.propertyId,pin);
  },[member,search]);
  const {submit,recoveryValue,onDripChanged}=useAttemptWorkflow({
    opening:dialog,memberId:member,readRow:readRecoveryRow,
    onCommitted:({opening})=>{
      // Queue barrier: a rapid next click must read post-command metadata, never the old row.
      const read=refresh();mutationReads.current.set(opening.row.propertyId,{scope:openingScope,episodeId:opening.row.assignmentEpisodeId,requestId:request.current,read});
      setDetailRevision(revision=>revision+1);
      return read;
    },
    onSettled:({opening,dripFailure})=>{
      if(dripFailure&&(opening.action==='log-attempt'||opening.action==='handoff'))setError(dripFailure);
      router.refresh();
    },
    onClose:opening=>setDialog(current=>current===opening?null:current),
    onDripChanged:()=>{void refresh();router.refresh();},
  });
  // The deep-link target lives in client state, seeded from the URL. A user-driven
  // rep/search change clears it (and the URL, without adding history). A different
  // ?lead= value arriving later (new link, Back/Forward) is a new target; a refresh
  // that re-renders with the same value is not.
  const focusKey=`${focus?.propertyId??''}|${focus?.notice??''}|${focus?.memberId??''}`;
  const [target,setTarget]=useState(()=>({propertyId:focus?.propertyId??null,notice:focus?.notice??null,nonce:0}));
  const [seenFocusKey,setSeenFocusKey]=useState(focusKey);const [clearedForKey,setClearedForKey]=useState<string|null>(null);
  if(seenFocusKey!==focusKey){
    setSeenFocusKey(focusKey);setClearedForKey(null);
    setTarget(previous=>({propertyId:focus?.propertyId??null,notice:focus?.notice??null,nonce:previous.nonce+1}));
    setPinNotice(null);
    setPinRead(focus?.propertyId&&focus.pin?{id:focus.propertyId,lookup:{status:'found',row:focus.pin,snapshotAt:snapshot?.snapshotAt??''}}:null);
    if(focus?.propertyId){
      // A deep link always opens its rep's queue unfiltered.
      if(focus.memberId&&focus.memberId!==member)setMember(focus.memberId);
      setSearch('');
    }
  }
  useEffect(()=>{pinWanted.current=target.propertyId;},[target.propertyId]);
  const clearFocus=()=>{
    if(target.propertyId||target.notice)setTarget(previous=>({propertyId:null,notice:null,nonce:previous.nonce}));
    // Dropping the target drops the pin, and any in-flight pin read is ignored.
    pinWanted.current=null;setPinRead(null);setPinNotice(null);
    if(focusKey!=='||'&&clearedForKey!==focusKey){setClearedForKey(focusKey);router.replace('/my-leads',{scroll:false});}
  };
  const view=snapshot?reconcileWithPin(snapshot,drips,pinRead,target.propertyId):null;
  const pages=snapshot&&view?stagePages(view.snapshot,view.drips):null;
  // Show the lead in place when a loaded page has it; otherwise pin it at the top of its section.
  const pinnedLookup=target.propertyId&&pinRead?.id===target.propertyId&&pinRead.lookup.status==='found'?pinRead.lookup.row:null;
  const pinnedView=pages&&snapshot&&pinnedLookup&&!(Object.values(pages).some(page=>page.rows.some(row=>row.propertyId===pinnedLookup.propertyId))||view?.drips?.active.some(row=>row.propertyId===pinnedLookup.propertyId))
    ?{...queueRowView(findRow(snapshot,drips,pinnedLookup.propertyId,pinRead)??pinnedLookup,snapshot.snapshotAt),dripReply:drips?.replied.find(row=>row.propertyId===pinnedLookup.propertyId)??null}:null;
  if(pages)for(const stage of loadingStages)pages[stage].isLoadingMore=true;
  const motivation=dialog?.row.motivationKind==='specified'?{kind:'specified' as const,text:dialog.row.motivationText??''}:dialog?.row.motivationKind==='no_motivation'?{kind:'no_motivation' as const,text:null}:null;
  // Completion callbacks belong to one opening, even when the same lead is reopened.
  // A previous form can finish after its post-save refresh and must not close a new form.
  const common=dialog?{open:true,propertyId:dialog.row.propertyId,propertyLabel:dialog.row.address,onOpenChange:(open:boolean)=>{if(!open){setDialog(current=>current===dialog?null:current);}}}:null;
  return <>
    {openingStatus&&<div role="status" className="mb-4 rounded border p-3">
      {openingStatus.message}
      {!openingStatus.busy&&<Button type="button" variant="outline" onClick={retryOpening}>Retry opening</Button>}
      <Button type="button" variant="ghost" onClick={cancelOpening}>Cancel opening</Button>
    </div>}
    {viewer.isOwner&&<details className="mb-4 rounded-lg border p-4"><summary className="cursor-pointer font-medium">Manage Acquisitions</summary>
      <div className="mt-3 space-y-3">{roster.members.filter(m=>m.active).map(m=><label key={m.id} className="flex items-center gap-2">
        <input type="checkbox" checked={m.acquisitionsEnabled} disabled={settingsBusy} onChange={async()=>{setSettingsBusy(true);try{const result=await changeAcquisitionDesignation({orgId:viewer.orgId,userId:m.id,enabled:!m.acquisitionsEnabled,expectedEnabled:m.acquisitionsEnabled,idempotencyKey:crypto.randomUUID()});if(!result.ok)setError(result.message);else router.refresh();}finally{setSettingsBusy(false);}}}/>{m.label}
      </label>)}<label className="block">Needs drip recipient<select className="ml-2 rounded border p-2" value={recipient} onChange={e=>setRecipient(e.target.value)}><option value="">Choose recipient</option>{roster.members.filter(m=>m.active).map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      <Button disabled={!recipient||settingsBusy} onClick={async()=>{setSettingsBusy(true);try{const result=await changeAcquisitionSettings({orgId:viewer.orgId,needsSequenceOwnerId:recipient,expectedSettingsRevision:roster.settings.revision,idempotencyKey:crypto.randomUUID()});if(!result.ok)setError(result.message);else router.refresh();}finally{setSettingsBusy(false);}}}>Save recipient</Button></div>
    <RepSmsSettings orgId={viewer.orgId} members={roster.members} />
    </details>}
    {(target.notice??pinNotice)&&<div role="status" className="mb-4 rounded border p-3 text-sm">{target.notice??pinNotice}</div>}
    {error&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{error} <Button variant="outline" onClick={()=>void refresh()}>Refresh</Button></div>}
    {refreshError&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{refreshError} Displayed counts may be out of date. Retrying automatically. <Button variant="outline" onClick={()=>void refresh()}>Retry now</Button> <Button variant="outline" onClick={()=>window.location.reload()}>Reload and reconnect</Button></div>}
    {dialpad&&roster.settings.enabled&&<DialpadPanel bootstrap={dialpad} callRequest={dialpadRequest}
      onCallRequestHandled={onCallRequestHandled}
      onRecordingFinalResult={()=>{void refresh(true);}}
      onLogOutcome={(propertyId,callActivityId)=>{if(!rawRow(propertyId)){setError('This lead is no longer in your queue.');return;}action('log-attempt',propertyId,callActivityId);}}/>}
    {!roster.settings.enabled?<p>My Leads is not enabled yet.</p>:!pages||!kpis||!tiles?<p role="status">Loading My Leads…</p>:<>
      <MyLeadsQueue canSelectRep={viewer.isOwner} stages={pages} drips={view?.drips??drips} kpis={tiles} search={search} selectedRepId={member}
        onReviewingChange={onReviewingChange}
        detailRevision={detailRevision} focusPropertyId={target.propertyId} focusNonce={target.nonce} pinnedRow={pinnedView}
        repOptions={roster.members.filter(m=>m.acquisitionsEnabled||m.hasHistory||m.id===viewer.userId).map(m=>({id:m.id,label:m.label+(m.acquisitionsEnabled?'':' — Acquisitions disabled')}))}
        selectedRepLabel={roster.members.find(m=>m.id===member)?.label}
        onSearchChange={value=>{clearFocus();setSearch(value);}} onRepChange={value=>{clearFocus();setMember(value);}}
        onLoadMore={async stage=>{
          const cursor=snapshot?.stages[stage]?.cursor;if(!cursor||loadingStages.has(stage))return;
          const id=request.current;setLoadingStages(previous=>new Set(previous).add(stage));
          try{const result=await loadMyLeadsStage({memberId:member,search,stage,cursor});if(id!==request.current)return;
            if(!result.ok){setError(result.message);return;}
            const next=result.snapshot.stages[stage];if(next)setSnapshot(previous=>{
              if(!previous)return previous;const rows=previous.stages[stage]?.rows??[];const ids=new Set(rows.map(r=>r.propertyId));
              return {...previous,stages:{...previous.stages,[stage]:{...next,rows:[...rows,...next.rows.filter(r=>!ids.has(r.propertyId))]}}};
            });
          }finally{setLoadingStages(previous=>{const next=new Set(previous);next.delete(stage);return next;});}
        }}
        onLoadDetail={async propertyId=>{const result=await loadMyLeadDetail({memberId:member,propertyId});return result.ok?{ok:true,detail:detailView(result.detail,roster)}:result;}}
        onLoadDetailPage={async(propertyId,group,cursor)=>{
          const result=await loadMyLeadDetail({memberId:member,propertyId,group,cursor});if(!result.ok)return result;
          const detail=detailView(result.detail,roster);
          switch(group){case 'messages':return {ok:true,group,page:detail.messages};case 'notes':return {ok:true,group,page:detail.notes};case 'attempts':return {ok:true,group,page:detail.attempts};case 'appointments':return {ok:true,group,page:detail.appointments};case 'offers':return {ok:true,group,page:detail.offers};case 'history':return {ok:true,group,page:detail.history};}
        }}
        onLeadChanged={()=>{void refresh();router.refresh();}} onStageAction={(kind,row)=>action(kind,row.propertyId)}/>

      {lastCheckedAt&&<p className="mb-2 text-sm text-muted-foreground">Counts update every 30 seconds while this page is visible. Last successful check: <time dateTime={lastCheckedAt}>{refreshTime.format(new Date(lastCheckedAt))}</time>.{reviewing?' The lead list stays in place while details are open.':''}</p>}
      {search&&<p className="mb-2 text-sm text-muted-foreground">Section counts match your search. KPIs cover the selected rep.</p>}
      <p className="mt-3 text-xs text-muted-foreground">{kpis.firstCallPending} first calls pending · {kpis.pendingOutcomes} call outcomes pending{kpis.orgAppointmentsUnattributed?` · ${kpis.orgAppointmentsUnattributed} appointments in this organization have unknown historical attribution`:''}</p>
    </>}
    <WorkflowRecoveryContext.Provider value={recoveryValue}>
    {common&&dialog?.action==='log-attempt'&&<AcquisitionAttemptDialog {...common} onSubmit={payload=>submit(payload)} onDripChanged={onDripChanged} key={`${dialog.row.propertyId}:${dialog.callActivityId??''}`} initialCallActivityId={dialog.callActivityId??null} callReferenceOptions={callOptions?.propertyId===dialog.row.propertyId?callOptions.options:[]} callReferencesLoading={!callOptions} callReferencesError={callOptions?.error} onRetryCallReferences={()=>setCallRetry(value=>value+1)}/>}
    {common&&dialog?.action==='ready-for-offer'&&<AcquisitionReadinessDialog {...common} onSubmit={payload=>submit(payload)} initialTemperature={dialog.row.temperature} initialMotivationResponse={motivation}/>}
    {common&&dialog?.action==='log-offer'&&<AcquisitionOfferDialog {...common} onSubmit={payload=>submit(payload)} motivationRequired={!motivation} initialTemperature={dialog.row.temperature} initialMotivationResponse={motivation}/>}
    {common&&dialog&&['contract-signed','decline-offer','handoff','archive'].includes(dialog.action)&&<AcquisitionLifecycleDialog {...common} onSubmit={payload=>submit(payload)} mode={dialog.action as AcquisitionLifecycleMode}
      pendingOfferId={dialog.row.offer?.outcome==='pending'?dialog.row.offer.id:null}
      recipientOptions={roster.settings.recipient?[roster.settings.recipient]:roster.settings.recipientId?roster.members.filter(m=>m.id===roster.settings.recipientId).map(m=>({id:m.id,label:m.label})):[]}
      initialRecipientUserId={roster.settings.recipient?.id??roster.settings.recipientId??''}/>}
    </WorkflowRecoveryContext.Provider>
    {dialog?.action==='schedule-next-step'&&<div className="fixed bottom-6 right-6 z-50 rounded-xl border bg-background p-5 shadow-lg"><p className="mb-3 font-medium">{dialog.row.address}</p>
      <BookAppointmentPopover propertyId={dialog.row.propertyId} subjectLabel={dialog.row.address} currentUserId={member} onBooked={()=>{setDialog(current=>current===dialog?null:current);setDetailRevision(revision=>revision+1);void refresh();}}/>
      <Button variant="ghost" onClick={()=>setDialog(null)}>Close</Button></div>}
  </>;
}
