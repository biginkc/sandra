'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useOptionalSoftphone } from '@/components/softphone/softphone-provider';
import { BookAppointmentPopover } from '@/components/appointments/book-appointment-popover';
import type { Json } from '@/lib/supabase/types';
import type { AcquisitionKpis,AcquisitionRoster,QueueSnapshot,QueueRow } from '@/lib/my-leads/queries';
import { MyLeadsQueue } from './_components/queue';
import { AcquisitionAttemptDialog } from './_components/attempt-dialog';
import { AcquisitionReadinessDialog } from './_components/readiness-dialog';
import { AcquisitionOfferDialog } from './_components/offer-dialog';
import { AcquisitionLifecycleDialog } from './_components/lifecycle-dialog';
import type { MyLeadAction,MyLeadStage,MyLeadsPeriod,MyLeadDateRange,AcquisitionLifecycleMode } from './_components/types';
import { detailView,kpiTiles,stagePages } from './adapter';
import { loadMyLeadCallReferences,loadMyLeads,loadMyLeadsStage,loadMyLeadDetail,submitMyLeadCommand,changeAcquisitionDesignation,changeAcquisitionSettings } from './actions';

type Props={viewer:{userId:string;orgId:string;isOwner:boolean};roster:AcquisitionRoster;initialMemberId:string;initialSnapshot:QueueSnapshot|null;initialKpis:AcquisitionKpis|null};

type CustomRangeStatus = 'incomplete'|'invalid'|'ready';
const REFRESH_INTERVAL_MS = 30_000;
const refreshTime = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZone:'America/Chicago',timeZoneName:'short'});

function customRangeStatus(range:MyLeadDateRange|null):CustomRangeStatus {
  if(!range?.startDate||!range.endDate)return 'incomplete';
  const isDate=(value:string)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const parsed=new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
  };
  if(!isDate(range.startDate)||!isDate(range.endDate)||range.startDate>range.endDate)return 'invalid';
  return 'ready';
}

export function MyLeadsClient({viewer,roster,initialMemberId,initialSnapshot,initialKpis}:Props) {
  const router=useRouter();const softphone=useOptionalSoftphone();
  const [member,setMember]=useState(initialMemberId);const [search,setSearch]=useState('');
  const [period,setPeriod]=useState<MyLeadsPeriod>('today');const [range,setRange]=useState<MyLeadDateRange|null>(null);
  const [snapshot,setSnapshot]=useState(initialSnapshot);const [kpis,setKpis]=useState(initialKpis);
  const [error,setError]=useState<string|null>(null);const [loadingStages,setLoadingStages]=useState<Set<MyLeadStage>>(new Set());
  const [refreshError,setRefreshError]=useState<string|null>(null);
  const [callOptions,setCallOptions]=useState<{propertyId:string;options:{id:string;label:string}[];error:string|null}|null>(null);
  const [callRetry,setCallRetry]=useState(0);
  const [dialog,setDialog]=useState<{action:MyLeadAction;row:QueueRow}|null>(null);
  const [detailRevision,setDetailRevision]=useState(0);
  const [recipient,setRecipient]=useState(roster.settings.recipientId??'');const [settingsBusy,setSettingsBusy]=useState(false);
  const initialEffect=useRef(Boolean(initialSnapshot&&initialKpis));const request=useRef(0);const submission=useRef<{hash:string;key:string}|null>(null);
  const selectedRangeStatus=period==='custom'?customRangeStatus(range):'ready';
  const serverScopeKey=JSON.stringify([member,period,range?.startDate,range?.endDate]);
  const previousServerScope=useRef(serverScopeKey);
  const refresh=useCallback(async()=>{
    if(!roster.settings.enabled||selectedRangeStatus!=='ready') return;
    const id=++request.current;
    try {
      const result=await loadMyLeads({memberId:member,search,period,startDate:range?.startDate,endDate:range?.endDate});
      if(id!==request.current)return;
      if(result.ok){setSnapshot(result.snapshot);setKpis(result.kpis);setError(null);setRefreshError(null);}
      else setRefreshError(result.message);
    } catch {
      if(id===request.current)setRefreshError('My Leads could not refresh.');
    }
  },[member,search,period,range,roster.settings.enabled,selectedRangeStatus]);
  useEffect(()=>{
    if(initialEffect.current){initialEffect.current=false;return;}
    const scopeChanged=previousServerScope.current!==serverScopeKey;
    previousServerScope.current=serverScopeKey;
    if(selectedRangeStatus!=='ready'){
      ++request.current;
      setError(selectedRangeStatus==='invalid'?'Choose a valid date range with the start date on or before the end date.':null);
      return;
    }
    ++request.current;
    if(scopeChanged){setSnapshot(null);setKpis(null);}
    const timer=setTimeout(()=>void refresh(),250);
    return()=>{clearTimeout(timer);};
  },[refresh,selectedRangeStatus,serverScopeKey]);
  useEffect(()=>{
    if(!roster.settings.enabled)return;
    const delay=Math.min(REFRESH_INTERVAL_MS,Math.max(1000,snapshot?.nextWarningAt?Date.parse(snapshot.nextWarningAt)-Date.now():REFRESH_INTERVAL_MS));
    let cancelled=false;
    // A failed read does not replace snapshot, so it cannot re-arm this effect.
    // Keep retrying even after transport/authentication failures or hidden tabs.
    const tick=async()=>{
      try {if(!document.hidden)await refresh();}
      finally {if(!cancelled)timer=setTimeout(()=>void tick(),REFRESH_INTERVAL_MS);}
    };
    let timer=setTimeout(()=>void tick(),delay);
    const onVisible=()=>{if(!document.hidden)void refresh();};
    document.addEventListener('visibilitychange',onVisible);window.addEventListener('focus',onVisible);
    return()=>{cancelled=true;clearTimeout(timer);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('focus',onVisible);};
  },[snapshot,refresh,roster.settings.enabled]);
  const rawRow=(id:string)=>Object.values(snapshot?.stages??{}).flatMap(p=>p?.rows??[]).find(r=>r.propertyId===id);
  const action=(kind:MyLeadAction,id:string)=>{
    const row=rawRow(id);if(!row)return;
    if(kind==='start-call'){
      if(!softphone?.callingEnabled){setError('Calling is not enabled.');return;}
      softphone.openLead({id:row.propertyId,contactId:row.contactId,firstName:row.homeownerName?.split(' ')[0]??'',name:row.homeownerName??row.address,address:row.address,state:row.state,
        phones:row.phones,dncLocked:false,contactDnc:row.contactDnc,callable:row.phones.some(phone=>!!phone.trim())&&!row.contactDnc});return;
    }
    submission.current=null;setCallOptions(null);setDialog({action:kind,row});

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
    const hash=JSON.stringify(payload);
    if(submission.current?.hash!==hash)submission.current={hash,key:crypto.randomUUID()};
    const input=JSON.parse(JSON.stringify({...payload,propertyId:dialog.row.propertyId,expectedEpisodeId:dialog.row.assignmentEpisodeId,
      expectedQueueVersion:dialog.row.queueVersion,expectedSharedStatus:dialog.row.sharedStatus,idempotencyKey:submission.current.key})) as Record<string,Json>;
    const result=await submitMyLeadCommand(dialog.action as Parameters<typeof submitMyLeadCommand>[0],input);
    if(result.ok){setDialog(null);setDetailRevision(revision=>revision+1);await refresh();router.refresh();}
    return result;
  },[dialog,refresh,router]);
  const pages=snapshot?stagePages(snapshot):null;
  if(pages)for(const stage of loadingStages)pages[stage].isLoadingMore=true;
  const motivation=dialog?.row.motivationKind==='specified'?{kind:'specified' as const,text:dialog.row.motivationText??''}:dialog?.row.motivationKind==='no_motivation'?{kind:'no_motivation' as const,text:null}:null;
  const common=dialog?{open:true,propertyId:dialog.row.propertyId,propertyLabel:dialog.row.address,onOpenChange:(open:boolean)=>{if(!open)setDialog(null);}}:null;
  return <>
    {viewer.isOwner&&<details className="mb-4 rounded-lg border p-4"><summary className="cursor-pointer font-medium">Manage Acquisitions</summary>
      <div className="mt-3 space-y-3">{roster.members.filter(m=>m.active).map(m=><label key={m.id} className="flex items-center gap-2">
        <input type="checkbox" checked={m.acquisitionsEnabled} disabled={settingsBusy} onChange={async()=>{setSettingsBusy(true);try{const result=await changeAcquisitionDesignation({orgId:viewer.orgId,userId:m.id,enabled:!m.acquisitionsEnabled,expectedEnabled:m.acquisitionsEnabled,idempotencyKey:crypto.randomUUID()});if(!result.ok)setError(result.message);else router.refresh();}finally{setSettingsBusy(false);}}}/>{m.label}
      </label>)}<label className="block">Needs sequence recipient<select className="ml-2 rounded border p-2" value={recipient} onChange={e=>setRecipient(e.target.value)}><option value="">Choose recipient</option>{roster.members.filter(m=>m.active).map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      <Button disabled={!recipient||settingsBusy} onClick={async()=>{setSettingsBusy(true);try{const result=await changeAcquisitionSettings({orgId:viewer.orgId,needsSequenceOwnerId:recipient,expectedSettingsRevision:roster.settings.revision,idempotencyKey:crypto.randomUUID()});if(!result.ok)setError(result.message);else router.refresh();}finally{setSettingsBusy(false);}}}>Save recipient</Button></div>
    </details>}
    {error&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{error} <Button variant="outline" onClick={()=>void refresh()}>Refresh</Button></div>}
    {refreshError&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{refreshError} Displayed counts may be out of date. Retrying automatically. <Button variant="outline" onClick={()=>void refresh()}>Retry now</Button> <Button variant="outline" onClick={()=>window.location.reload()}>Reload and reconnect</Button></div>}
    {!roster.settings.enabled?<p>My Leads is not enabled yet.</p>:!pages||!kpis?<p role="status">Loading My Leads…</p>:<>
      {snapshot&&<p className="mb-2 text-sm text-muted-foreground">Checks for updates every 30 seconds while this page is visible. Last successful check: <time dateTime={snapshot.snapshotAt}>{refreshTime.format(new Date(snapshot.snapshotAt))}</time>.</p>}
      {search&&<p className="mb-2 text-sm text-muted-foreground">Section counts match your search. KPIs cover the selected rep.</p>}
      <MyLeadsQueue canSelectRep={viewer.isOwner} stages={pages} kpis={kpiTiles(kpis)} search={search} selectedRepId={member} selectedPeriod={period} selectedDateRange={range}
        detailRevision={detailRevision}
        repOptions={roster.members.filter(m=>m.acquisitionsEnabled||m.hasHistory||m.id===viewer.userId).map(m=>({id:m.id,label:m.label+(m.acquisitionsEnabled?'':' — Acquisitions disabled')}))}
        selectedRepLabel={roster.members.find(m=>m.id===member)?.label}
        onSearchChange={setSearch} onRepChange={setMember} onPeriodChange={setPeriod} onDateRangeChange={setRange}
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
          switch(group){case 'notes':return {ok:true,group,page:detail.notes};case 'attempts':return {ok:true,group,page:detail.attempts};case 'appointments':return {ok:true,group,page:detail.appointments};case 'offers':return {ok:true,group,page:detail.offers};case 'history':return {ok:true,group,page:detail.history};}
        }}
        onLeadChanged={()=>{void refresh();router.refresh();}} onStageAction={(kind,row)=>action(kind,row.propertyId)}/>

      <p className="mt-3 text-xs text-muted-foreground">{kpis.firstCallPending} first calls pending · {kpis.pendingOutcomes} call outcomes pending{kpis.orgAppointmentsUnattributed?` · ${kpis.orgAppointmentsUnattributed} appointments in this organization have unknown historical attribution`:''}</p>
    </>}
    {common&&dialog?.action==='log-attempt'&&<AcquisitionAttemptDialog {...common} onSubmit={payload=>submit(payload)} key={dialog.row.propertyId} callReferenceOptions={callOptions?.propertyId===dialog.row.propertyId?callOptions.options:[]} callReferencesLoading={!callOptions} callReferencesError={callOptions?.error} onRetryCallReferences={()=>setCallRetry(value=>value+1)}/>}
    {common&&dialog?.action==='ready-for-offer'&&<AcquisitionReadinessDialog {...common} onSubmit={payload=>submit(payload)} initialTemperature={dialog.row.temperature} initialMotivationResponse={motivation}/>}
    {common&&dialog?.action==='log-offer'&&<AcquisitionOfferDialog {...common} onSubmit={payload=>submit(payload)} motivationRequired={!motivation} initialTemperature={dialog.row.temperature} initialMotivationResponse={motivation}/>}
    {common&&dialog&&['contract-signed','decline-offer','handoff','archive'].includes(dialog.action)&&<AcquisitionLifecycleDialog {...common} onSubmit={payload=>submit(payload)} mode={dialog.action as AcquisitionLifecycleMode}
      pendingOfferId={dialog.row.offer?.outcome==='pending'?dialog.row.offer.id:null}
      recipientOptions={roster.settings.recipient?[roster.settings.recipient]:roster.settings.recipientId?roster.members.filter(m=>m.id===roster.settings.recipientId).map(m=>({id:m.id,label:m.label})):[]}
      initialRecipientUserId={roster.settings.recipient?.id??roster.settings.recipientId??''}/>}
    {dialog?.action==='schedule-next-step'&&<div className="fixed bottom-6 right-6 z-50 rounded-xl border bg-background p-5 shadow-lg"><p className="mb-3 font-medium">{dialog.row.address}</p>
      <BookAppointmentPopover propertyId={dialog.row.propertyId} subjectLabel={dialog.row.address} currentUserId={member} onBooked={()=>{setDialog(null);setDetailRevision(revision=>revision+1);void refresh();}}/>
      <Button variant="ghost" onClick={()=>setDialog(null)}>Close</Button></div>}
  </>;
}
