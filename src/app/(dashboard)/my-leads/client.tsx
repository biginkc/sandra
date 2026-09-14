'use client';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useOptionalSoftphone } from '@/components/softphone/softphone-provider';
import { BookAppointmentPopover } from '@/components/appointments/book-appointment-popover';
import type { Json } from '@/lib/supabase/types';
import type { AcquisitionKpis,AcquisitionRoster,QueueSnapshot,QueueRow } from '@/lib/my-leads/queries';
import { WorkflowRecoveryContext } from './_components/workflow-form';
import { MyLeadsQueue } from './_components/queue';
import { DialpadMemberAssignment } from './_components/dialpad-member-assignment';
import { AcquisitionAttemptDialog } from './_components/attempt-dialog';
import { AcquisitionReadinessDialog } from './_components/readiness-dialog';
import { AcquisitionOfferDialog } from './_components/offer-dialog';
import { AcquisitionLifecycleDialog } from './_components/lifecycle-dialog';
import type { MyLeadAction,MyLeadStage,AcquisitionLifecycleMode } from './_components/types';
import { detailView,kpiTiles,stagePages } from './adapter';
import { loadMyLeadCallReferences,loadMyLeads,loadMyLeadsStage,loadMyLeadDetail,submitMyLeadCommand,changeAcquisitionDesignation,changeAcquisitionSettings } from './actions';

type Props={viewer:{userId:string;orgId:string;isOwner:boolean};roster:AcquisitionRoster;initialMemberId:string;initialSnapshot:QueueSnapshot|null;initialKpis:AcquisitionKpis|null};

const REFRESH_INTERVAL_MS = 30_000;
const refreshTime = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZone:'America/Chicago',timeZoneName:'short'});

export function MyLeadsClient({viewer,roster,initialMemberId,initialSnapshot,initialKpis}:Props) {
  const router=useRouter();const softphone=useOptionalSoftphone();
  const [member,setMember]=useState(initialMemberId);const [search,setSearch]=useState('');
  const [snapshot,setSnapshot]=useState(initialSnapshot);const [kpis,setKpis]=useState(initialKpis);
  const tiles=useMemo(()=>kpis?kpiTiles(kpis):null,[kpis]);
  const [lastCheckedAt,setLastCheckedAt]=useState(initialSnapshot?.snapshotAt??null);
  const reviewingDetails=useRef(false);
  const [reviewing,setReviewing]=useState(false);
  const onReviewingChange=useCallback((active:boolean)=>{reviewingDetails.current=active;setReviewing(active);},[]);
  const [error,setError]=useState<string|null>(null);const [loadingStages,setLoadingStages]=useState<Set<MyLeadStage>>(new Set());
  const [refreshError,setRefreshError]=useState<string|null>(null);
  const [callOptions,setCallOptions]=useState<{propertyId:string;options:{id:string;label:string;source?:'sandra'|'dialpad'}[];error:string|null}|null>(null);
  const [callRetry,setCallRetry]=useState(0);
  const [dialog,setDialog]=useState<{action:MyLeadAction;row:QueueRow}|null>(null);
  type Opening = {action:MyLeadAction;row:QueueRow;scope:string};
  type CurrentRead = Awaited<ReturnType<typeof loadMyLeads>> | null;
  const openingScope=JSON.stringify([member,search]);
  const activeScope=useRef(openingScope);activeScope.current=openingScope;
  const currentSnapshot=useRef(snapshot);currentSnapshot.current=snapshot;
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
  const activeDialog=useRef(dialog);activeDialog.current=dialog;
  const recoveredRow=useRef<{opening:NonNullable<typeof dialog>;row:QueueRow}|null>(null);
  const [recovery,setRecovery]=useState<{opening:NonNullable<typeof dialog>;message:string;blocked:boolean;busy:boolean}|null>(null);
  const recoverDialog=async()=>{
    const opening=dialog;if(!opening||recovery?.busy)return;
    setRecovery({opening,message:'Checking current lead access…',blocked:true,busy:true});
    try {
      const result=await loadMyLeads({memberId:member,search,period:'today'});
      if(activeDialog.current!==opening)return;
      if(!result.ok)throw new Error('read failed');
      const row=Object.values(result.snapshot.stages).flatMap(page=>page?.rows??[]).find(row=>row.propertyId===opening.row.propertyId);
      // Never move a retained draft into a different assignment episode.
      if(!row||row.assignmentEpisodeId!==opening.row.assignmentEpisodeId){
        setRecovery({opening,message:'This lead is unavailable in this queue or its assignment changed. Your draft is retained; copy it before closing. Reopen the lead from the current queue to start a new update.',blocked:true,busy:false});return;
      }
      recoveredRow.current={opening,row};submission.current=null;
      setRecovery({opening,message:'Lead refreshed. Your draft is retained. Review it before saving.',blocked:false,busy:false});
    }catch{
      if(activeDialog.current===opening)setRecovery({opening,message:'Could not refresh this lead. Your draft is retained. Try Refresh again.',blocked:true,busy:false});
    }
  };
  const [detailRevision,setDetailRevision]=useState(0);
  const [recipient,setRecipient]=useState(roster.settings.recipientId??'');const [settingsBusy,setSettingsBusy]=useState(false);
  const initialEffect=useRef(Boolean(initialSnapshot&&initialKpis));const request=useRef(0);const submission=useRef<{hash:string;key:string}|null>(null);
  const serverScopeKey=member;
  const previousServerScope=useRef(serverScopeKey);
  const refresh=useCallback(async(background=false)=>{
    if(!roster.settings.enabled) return null;
    const id=++request.current;
    try {
      const result=await loadMyLeads({memberId:member,search,period:'today'});
      if(id!==request.current)return null;
      if(result.ok){
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
        setKpis(result.kpis);setLastCheckedAt(result.snapshot.snapshotAt);setError(null);setRefreshError(null);
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
    if(scopeChanged){setSnapshot(null);setKpis(null);}
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
  const rawRow=(id:string)=>Object.values(snapshot?.stages??{}).flatMap(p=>p?.rows??[]).find(r=>r.propertyId===id);
  const finishOpening=async(opening:Opening,read:Promise<CurrentRead>)=>{
    pendingOpening.current=opening;
    setOpeningStatus({opening,message:'Loading current lead…',busy:true});
    const result=await read;
    if(pendingOpening.current!==opening||activeScope.current!==opening.scope)return;
    if(!result?.ok){setOpeningStatus({opening,message:'Could not load current lead details. Retry to continue.',busy:false});return;}
    const fresh=Object.values(result.snapshot.stages).flatMap(page=>page?.rows??[]).find(row=>row.propertyId===opening.row.propertyId);
    if(!fresh||fresh.assignmentEpisodeId!==opening.row.assignmentEpisodeId){
      setOpeningStatus({opening,message:'This lead is unavailable or its assignment changed. Refresh the queue and reopen it.',busy:false});return;
    }
    const latest=Object.values(currentSnapshot.current?.stages??{}).flatMap(page=>page?.rows??[]).find(row=>row.propertyId===fresh.propertyId);
    // Do not rewind an even newer rendered snapshot, or silently change episodes.
    if(!latest||latest.assignmentEpisodeId!==fresh.assignmentEpisodeId){setOpeningStatus({opening,message:'This lead assignment changed. Refresh the queue and reopen it.',busy:false});return;}
    const row=latest&&latest.queueVersion>=fresh.queueVersion?latest:fresh;
    pendingOpening.current=null;setOpeningStatus(null);submission.current=null;setCallOptions(null);
    setDialog({action:opening.action,row});
  };
  const retryOpening=()=>{
    const opening=pendingOpening.current;if(!opening||openingStatus?.busy)return;
    const read=refresh();mutationReads.current.set(opening.row.propertyId,{scope:opening.scope,episodeId:opening.row.assignmentEpisodeId,requestId:request.current,read});
    void finishOpening(opening,read);
  };
  const action=(kind:MyLeadAction,id:string)=>{
    const row=rawRow(id);if(!row)return;
    cancelOpening();
    if(kind==='start-call'){
      if(!softphone?.callingEnabled){setError('Calling is not enabled.');return;}
      softphone.openLead({id:row.propertyId,contactId:row.contactId,firstName:row.homeownerName?.split(' ')[0]??'',name:row.homeownerName??row.address,address:row.address,state:row.state,
        phones:row.phones,dncLocked:false,contactDnc:row.contactDnc,callable:row.phones.some(phone=>!!phone.trim())&&!row.contactDnc});return;
    }
    const previous=mutationReads.current.get(id);
    if(previous?.scope===openingScope&&previous.episodeId===row.assignmentEpisodeId){
      void finishOpening({action:kind,row,scope:openingScope},previous.read);return;
    }
    cancelOpening();submission.current=null;setCallOptions(null);setDialog({action:kind,row});

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
  const submit=useCallback(async(payload:object)=>{
    if(!dialog)return {ok:false as const,message:'Select a lead first.'};
    if(recovery?.opening===dialog&&(recovery.blocked||recovery.busy))return {ok:false as const,message:recovery.message};
    const row=recoveredRow.current?.opening===dialog?recoveredRow.current.row:dialog.row;
    setRecovery(null);
    const hash=JSON.stringify(payload);
    if(submission.current?.hash!==hash)submission.current={hash,key:crypto.randomUUID()};
    const input=JSON.parse(JSON.stringify({...payload,propertyId:row.propertyId,expectedEpisodeId:row.assignmentEpisodeId,
      expectedQueueVersion:row.queueVersion,expectedSharedStatus:row.sharedStatus,idempotencyKey:submission.current.key})) as Record<string,Json>;
    const result=await submitMyLeadCommand(dialog.action as Parameters<typeof submitMyLeadCommand>[0],input);
    if(!result.ok&&'code' in result&&(result.code==='FORBIDDEN'||result.code==='STALE_STATE')&&activeDialog.current===dialog)setRecovery({opening:dialog,message:result.message,blocked:true,busy:false});
    if(result.ok){
      // Publish the refresh barrier before closing so a rapid next click is retained
      // and initialized from authorized post-command metadata, never the old row.
      const read=refresh();mutationReads.current.set(dialog.row.propertyId,{scope:openingScope,episodeId:dialog.row.assignmentEpisodeId,requestId:request.current,read});
      setDialog(current=>current===dialog?null:current);setDetailRevision(revision=>revision+1);await read;router.refresh();
    }
    return result;
  },[dialog,refresh,router,recovery,openingScope]);
  const pages=snapshot?stagePages(snapshot):null;
  if(pages)for(const stage of loadingStages)pages[stage].isLoadingMore=true;
  const motivation=dialog?.row.motivationKind==='specified'?{kind:'specified' as const,text:dialog.row.motivationText??''}:dialog?.row.motivationKind==='no_motivation'?{kind:'no_motivation' as const,text:null}:null;
  // Completion callbacks belong to one opening, even when the same lead is reopened.
  // A previous form can finish after its post-save refresh and must not close a new form.
  const common=dialog?{open:true,propertyId:dialog.row.propertyId,propertyLabel:dialog.row.address,onOpenChange:(open:boolean)=>{if(!open)setDialog(current=>current===dialog?null:current);}}:null;
  return <>
    {openingStatus&&<div role="status" className="mb-4 rounded border p-3">
      {openingStatus.message}
      {!openingStatus.busy&&<Button type="button" variant="outline" onClick={retryOpening}>Retry opening</Button>}
      <Button type="button" variant="ghost" onClick={cancelOpening}>Cancel opening</Button>
    </div>}
    {viewer.isOwner&&<details className="mb-4 rounded-lg border p-4"><summary className="cursor-pointer font-medium">Manage Acquisitions</summary>
      <div className="mt-3 space-y-3">{roster.members.filter(m=>m.active).map(m=><div key={m.id}><label className="flex items-center gap-2">
        <input type="checkbox" checked={m.acquisitionsEnabled} disabled={settingsBusy} onChange={async()=>{setSettingsBusy(true);try{const result=await changeAcquisitionDesignation({orgId:viewer.orgId,userId:m.id,enabled:!m.acquisitionsEnabled,expectedEnabled:m.acquisitionsEnabled,idempotencyKey:crypto.randomUUID()});if(!result.ok)setError(result.message);else router.refresh();}finally{setSettingsBusy(false);}}}/>{m.label}
      </label>{m.acquisitionsEnabled&&<DialpadMemberAssignment memberId={m.id} memberLabel={m.label}/>}</div>)}<label className="block">Needs sequence recipient<select className="ml-2 rounded border p-2" value={recipient} onChange={e=>setRecipient(e.target.value)}><option value="">Choose recipient</option>{roster.members.filter(m=>m.active).map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      <Button disabled={!recipient||settingsBusy} onClick={async()=>{setSettingsBusy(true);try{const result=await changeAcquisitionSettings({orgId:viewer.orgId,needsSequenceOwnerId:recipient,expectedSettingsRevision:roster.settings.revision,idempotencyKey:crypto.randomUUID()});if(!result.ok)setError(result.message);else router.refresh();}finally{setSettingsBusy(false);}}}>Save recipient</Button></div>
    </details>}
    {error&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{error} <Button variant="outline" onClick={()=>void refresh()}>Refresh</Button></div>}
    {refreshError&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{refreshError} Displayed counts may be out of date. Retrying automatically. <Button variant="outline" onClick={()=>void refresh()}>Retry now</Button> <Button variant="outline" onClick={()=>window.location.reload()}>Reload and reconnect</Button></div>}
    {!roster.settings.enabled?<p>My Leads is not enabled yet.</p>:!pages||!kpis||!tiles?<p role="status">Loading My Leads…</p>:<>
      <MyLeadsQueue canSelectRep={viewer.isOwner} stages={pages} kpis={tiles} search={search} selectedRepId={member}
        onReviewingChange={onReviewingChange}
        detailRevision={detailRevision}
        repOptions={roster.members.filter(m=>m.acquisitionsEnabled||m.hasHistory||m.id===viewer.userId).map(m=>({id:m.id,label:m.label+(m.acquisitionsEnabled?'':' — Acquisitions disabled')}))}
        selectedRepLabel={roster.members.find(m=>m.id===member)?.label}
        onSearchChange={setSearch} onRepChange={setMember}
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
    <WorkflowRecoveryContext.Provider value={recovery?.opening===dialog?{...recovery,refresh:()=>void recoverDialog()}:null}>
    {common&&dialog?.action==='log-attempt'&&<AcquisitionAttemptDialog {...common} onSubmit={payload=>submit(payload)} key={dialog.row.propertyId} callReferenceOptions={callOptions?.propertyId===dialog.row.propertyId?callOptions.options:[]} callReferencesLoading={!callOptions} callReferencesError={callOptions?.error} onRetryCallReferences={()=>setCallRetry(value=>value+1)}/>}
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
