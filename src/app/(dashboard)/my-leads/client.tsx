'use client';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { RepSmsSettings } from './rep-sms-settings';
import { Button } from '@/components/ui/button';
import { useOptionalSoftphone } from '@/components/softphone/softphone-provider';
import { BookAppointmentPopover } from '@/components/appointments/book-appointment-popover';
import type { Json } from '@/lib/supabase/types';
import type { AcquisitionKpis,AcquisitionRoster,QueueSnapshot,QueueRow } from '@/lib/my-leads/queries';
import type { MyLeadDripSnapshot } from '@/lib/my-leads/drip-queries';
import { WorkflowRecoveryContext, type WorkflowReconciliation } from './_components/workflow-form';
import { MyLeadsQueue } from './_components/queue';
import { AcquisitionAttemptDialog } from './_components/attempt-dialog';
import { AcquisitionReadinessDialog } from './_components/readiness-dialog';
import { AcquisitionOfferDialog } from './_components/offer-dialog';
import { AcquisitionLifecycleDialog } from './_components/lifecycle-dialog';
import { DialpadPanel,type DialpadCallRequest } from './_components/dialpad-panel';
import type { DialpadPanelBootstrap } from '@/lib/dialpad-cti/dispatch';
import type { MyLeadAction,MyLeadStage,AcquisitionLifecycleMode,MyLeadDetailPageResult,MyLeadDetailResult,MyLeadDetailState,MyLeadDetailGroupName } from './_components/types';
import { detailView,kpiTiles,stagePages } from './adapter';
import { loadMyLeadCallReferences,loadMyLeads,loadMyLeadsStage,loadMyLeadDetail,loadMyLeadQueueRow,submitMyLeadCommand,submitMyLeadHandoffDrip,changeAcquisitionDesignation,changeAcquisitionSettings } from './actions';
import { MyLeadQueueRow } from './_components/queue-row';
import { queueRow as queueRowView } from './adapter';
import { selectedLeadUnavailableMessage, type SelectedLeadResult } from './deep-link';

type Props={viewer:{userId:string;orgId:string;isOwner:boolean};roster:AcquisitionRoster;initialMemberId:string;initialSnapshot:QueueSnapshot|null;initialKpis:AcquisitionKpis|null;initialDrips?:MyLeadDripSnapshot|null;dialpad?:DialpadPanelBootstrap|null;selectedLead?:SelectedLeadResult};

const REFRESH_INTERVAL_MS = 30_000;
const refreshTime = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZone:'America/Chicago',timeZoneName:'short'});

export function MyLeadsClient({viewer,roster,initialMemberId,initialSnapshot,initialKpis,initialDrips=null,dialpad=null,selectedLead={status:'none'}}:Props) {
  const router=useRouter();const softphone=useOptionalSoftphone();
  const [member,setMember]=useState(initialMemberId);const [search,setSearch]=useState('');
  const [snapshot,setSnapshot]=useState(initialSnapshot);const [kpis,setKpis]=useState(initialKpis);
  const [drips,setDrips]=useState(initialDrips);
  // Keep the server-authorized link target independent from the filtered and
  // paginated queue snapshot. A linked lead may be outside every loaded page.
  const [linkedLead,setLinkedLead]=useState(selectedLead);
  const linkedLeadRef=useRef(linkedLead);
  const linkedReadRequest=useRef(0);
  useEffect(()=>{linkedLeadRef.current=linkedLead;},[linkedLead]);
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
  type QueueRead = Awaited<ReturnType<typeof loadMyLeads>>;
  type LinkedRead = Awaited<ReturnType<typeof loadMyLeadQueueRow>>;
  type LinkedReadResult = LinkedRead;
  type CurrentRead = QueueRead | LinkedRead | null;
  const openingScope=JSON.stringify([member,search]);
  const activeScope=useRef(openingScope);activeScope.current=openingScope;
  const currentSnapshot=useRef(snapshot);currentSnapshot.current=snapshot;
  const currentDrips=useRef(drips);
  useEffect(()=>{currentDrips.current=drips;},[drips]);
  const findRow=(readSnapshot:QueueSnapshot|null,readDrips:MyLeadDripSnapshot|null|undefined,id:string)=>
    Object.values(readSnapshot?.stages??{}).flatMap(page=>page?.rows??[]).find(row=>row.propertyId===id)??
    [...(readDrips?.replied??[]),...(readDrips?.active??[])].find(row=>row.propertyId===id)?.queueRow??null;
  const linkedRow=useCallback((id:string)=>linkedLeadRef.current.status==='found'&&linkedLeadRef.current.propertyId.toLowerCase()===id.toLowerCase()&&member===initialMemberId?linkedLeadRef.current.row:null,[initialMemberId,member]);
  const refreshLinkedLead=useCallback(async(propertyId:string):Promise<LinkedReadResult>=>{
    if(member!==initialMemberId)return {ok:false as const,message:'Switch back to your own queue to continue.'};
    const readRequest=++linkedReadRequest.current;
    const result=await loadMyLeadQueueRow({memberId:initialMemberId,propertyId});
    // The request epoch only protects the rendered linked card. Callers that
    // are opening or recovering an action still need the actual result from
    // their own authorized read; turning an older response into a synthetic
    // failure can incorrectly block a valid opening.
    if(readRequest!==linkedReadRequest.current)return result;
    if(!result.ok)return result;
    const lookup=result.lookup;
    if(lookup.status!=='found'||lookup.row.propertyId.toLowerCase()!==propertyId.toLowerCase())return result;
    setLinkedLead(current=>current.status==='found'&&current.propertyId.toLowerCase()===propertyId.toLowerCase()
      ? {...current,row:lookup.row,snapshotAt:lookup.snapshotAt}
      : current);
    return result;
  },[initialMemberId,member]);
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
  const [recovery,setRecovery]=useState<{opening:NonNullable<typeof dialog>;message:string;blocked:boolean;busy:boolean;reconciliation?:WorkflowReconciliation}|null>(null);
  const recoverDialog=async()=>{
    const opening=dialog;if(!opening||recovery?.busy)return;
    setRecovery({opening,message:'Checking current lead access…',blocked:true,busy:true});
    try {
      if(linkedRow(opening.row.propertyId)){
        const linked=await refreshLinkedLead(opening.row.propertyId);
        if(activeDialog.current!==opening)return;
        if(!linkedRow(opening.row.propertyId)){
          setRecovery({opening,message:'This lead is no longer available in this queue. Your draft is retained; copy it before closing.',blocked:true,busy:false});
          return;
        }
        if(!linked.ok||linked.lookup.status!=='found'||linked.lookup.row.assignmentEpisodeId!==opening.row.assignmentEpisodeId){
          setRecovery({opening,message:'This lead is unavailable in this queue or its assignment changed. Your draft is retained; copy it before closing. Reopen the lead from the current link to start a new update.',blocked:true,busy:false});return;
        }
        recoveredRow.current={opening,row:linked.lookup.row};
        setRecovery({opening,message:'Lead refreshed. Your draft is retained. Review it before saving.',blocked:false,busy:false});
        return;
      }
      const result=await loadMyLeads({memberId:member,search,period:'today'});
      if(activeDialog.current!==opening)return;
      if(!result.ok)throw new Error('read failed');
      const row=findRow(result.snapshot,result.drips,opening.row.propertyId);
      // Never move a retained draft into a different assignment episode.
      if(!row||row.assignmentEpisodeId!==opening.row.assignmentEpisodeId){
        setRecovery({opening,message:'This lead is unavailable in this queue or its assignment changed. Your draft is retained; copy it before closing. Reopen the lead from the current queue to start a new update.',blocked:true,busy:false});return;
      }
      // Refreshing an opening after a stale response does not start a new
      // submission. Keep its idempotency key so retrying the same command is
      // safe even when the draft was edited while the dialog was blocked.
      recoveredRow.current={opening,row};
      setRecovery({opening,message:'Lead refreshed. Your draft is retained. Review it before saving.',blocked:false,busy:false});
    }catch{
      if(activeDialog.current===opening)setRecovery({opening,message:'Could not refresh this lead. Your draft is retained. Try Refresh again.',blocked:true,busy:false});
    }
  };
  const [detailRevision,setDetailRevision]=useState(0);
  const [recipient,setRecipient]=useState(roster.settings.recipientId??'');const [settingsBusy,setSettingsBusy]=useState(false);
  type OpeningSubmission = {
    key: string;
    // Once the request may have crossed the RPC boundary, keep the exact
    // payload that was sent with the key. A retry must replay this pair even
    // if the form was edited while the response was unavailable.
    payload: Record<string, Json> | null;
    uncertain: boolean;
  };
  const initialEffect=useRef(Boolean(initialSnapshot&&initialKpis));const request=useRef(0);const submission=useRef<OpeningSubmission|null>(null);
  useEffect(()=>{
    const current=linkedLeadRef.current;
    const sameStatus=current.status===selectedLead.status;
    const sameSelection=sameStatus&&(
      selectedLead.status==='none' ||
      selectedLead.status==='invalid'&&current.status==='invalid'&&selectedLead.reason===current.reason ||
      selectedLead.status==='found'&&current.status==='found'&&selectedLead.propertyId.toLowerCase()===current.propertyId.toLowerCase()&&selectedLead.row===current.row&&selectedLead.snapshotAt===current.snapshotAt ||
      selectedLead.status==='unavailable'&&current.status==='unavailable'&&selectedLead.message===current.message&&selectedLead.retryHref===current.retryHref ||
      selectedLead.status==='error'&&current.status==='error'&&selectedLead.message===current.message&&selectedLead.retryHref===current.retryHref ||
      selectedLead.status==='terminal'&&current.status==='terminal'&&selectedLead.message===current.message
    );
    if(sameSelection)return;
    const sameLead=current.status==='found'&&selectedLead.status==='found'&&current.propertyId.toLowerCase()===selectedLead.propertyId.toLowerCase();
    // Server props are authoritative for selection and access. Invalidate
    // older single-row reads immediately, while deferring the state update so
    // the same-lead detail panel remains mounted through a refresh.
    ++linkedReadRequest.current;
    linkedLeadRef.current=selectedLead;
    let cancelled=false;
    queueMicrotask(()=>{
      if(cancelled)return;
      if(!sameLead){
        pendingOpening.current=null;setOpeningStatus(null);
        setDialog(null);setRecovery(null);setCallOptions(null);
        recoveredRow.current=null;submission.current=null;
      }
      setLinkedLead(selectedLead);
    });
    return()=>{cancelled=true;};
  },[selectedLead]);
  useEffect(()=>{
    if(member===initialMemberId)return;
    ++linkedReadRequest.current;
    let cancelled=false;
    queueMicrotask(()=>{
      if(cancelled)return;
      cancelOpening();
      setDialog(null);setRecovery(null);setCallOptions(null);recoveredRow.current=null;submission.current=null;
    });
    return()=>{cancelled=true;};
  },[initialMemberId,member]);
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
  const rawRow=(id:string)=>findRow(snapshot,drips,id);
  const finishOpening=async(opening:Opening,read:Promise<CurrentRead>)=>{
    pendingOpening.current=opening;
    setOpeningStatus({opening,message:'Loading current lead…',busy:true});
    if(linkedRow(opening.row.propertyId)){
      const linked=await refreshLinkedLead(opening.row.propertyId);
      if(pendingOpening.current!==opening||activeScope.current!==opening.scope)return;
      if(!linkedRow(opening.row.propertyId)){
        setOpeningStatus({opening,message:'This lead is no longer available in this queue. Refresh the link to continue.',busy:false});
        return;
      }
      if(!linked.ok||linked.lookup.status!=='found'||linked.lookup.row.assignmentEpisodeId!==opening.row.assignmentEpisodeId){
        setOpeningStatus({opening,message:'This lead is unavailable or its assignment changed. Refresh the link to continue.',busy:false});return;
      }
      pendingOpening.current=null;setOpeningStatus(null);submission.current=null;setCallOptions(null);
      setDialog({action:opening.action,row:linked.lookup.row,callActivityId:opening.callActivityId});
      return;
    }
    const result=await read;
    if(pendingOpening.current!==opening||activeScope.current!==opening.scope)return;
    if(!result?.ok||!('snapshot' in result)){setOpeningStatus({opening,message:'Could not load current lead details. Retry to continue.',busy:false});return;}
    const fresh=findRow(result.snapshot,result.drips,opening.row.propertyId);
    if(!fresh||fresh.assignmentEpisodeId!==opening.row.assignmentEpisodeId){
      setOpeningStatus({opening,message:'This lead is unavailable or its assignment changed. Refresh the queue and reopen it.',busy:false});return;
    }
    const latest=findRow(currentSnapshot.current,currentDrips.current,fresh.propertyId);
    // Do not rewind an even newer rendered snapshot, or silently change episodes.
    if(!latest||latest.assignmentEpisodeId!==fresh.assignmentEpisodeId){setOpeningStatus({opening,message:'This lead assignment changed. Refresh the queue and reopen it.',busy:false});return;}
    const row=latest&&latest.queueVersion>=fresh.queueVersion?latest:fresh;
    pendingOpening.current=null;setOpeningStatus(null);submission.current=null;setCallOptions(null);
    setDialog({action:opening.action,row,callActivityId:opening.callActivityId});
  };
  const retryOpening=()=>{
    const opening=pendingOpening.current;if(!opening||openingStatus?.busy)return;
    const read=linkedRow(opening.row.propertyId)?Promise.resolve(null):refresh();
    mutationReads.current.set(opening.row.propertyId,{scope:opening.scope,episodeId:opening.row.assignmentEpisodeId,requestId:request.current,read});
    void finishOpening(opening,read);
  };
  const action=(kind:MyLeadAction,id:string,callActivityId?:string|null,rowOverride?:QueueRow)=>{
    const row=rowOverride??rawRow(id)??linkedRow(id);if(!row)return;
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
    if(rowOverride&&linkedRow(id)){
      void finishOpening({action:kind,row,scope:openingScope,callActivityId},Promise.resolve(null));return;
    }
    const previous=mutationReads.current.get(id);
    if(previous?.scope===openingScope&&previous.episodeId===row.assignmentEpisodeId){
      void finishOpening({action:kind,row,scope:openingScope,callActivityId},previous.read);return;
    }
    cancelOpening();submission.current=null;setCallOptions(null);setDialog({action:kind,row,callActivityId});

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
    // Keep the reconciliation receipt mounted while the exact original
    // request is being replayed. Clearing it before the server action returns
    // would briefly re-enable edited controls and make the replay ambiguous.
    if(!(recovery?.opening===dialog&&recovery.reconciliation))setRecovery(null);
    // A command's idempotency key belongs to the opened submission, not to
    // the current draft contents. Before the RPC is known to have crossed its
    // boundary, a deterministic rejection may be retried with refreshed
    // queue metadata. Once transport or confirmation is uncertain, however,
    // the original payload and key become one immutable replay pair. This is
    // what prevents an edited draft from producing SQL IDEMPOTENCY_CONFLICT.
    if(!submission.current)submission.current={key:crypto.randomUUID(),payload:null,uncertain:false};
    const command=dialog.action as Parameters<typeof submitMyLeadCommand>[0];
    const nextInput=JSON.parse(JSON.stringify({...payload,propertyId:row.propertyId,expectedEpisodeId:row.assignmentEpisodeId,
      expectedQueueVersion:row.queueVersion,expectedSharedStatus:row.sharedStatus,idempotencyKey:submission.current.key})) as Record<string,Json>;
    const input=submission.current.uncertain&&submission.current.payload
      ? submission.current.payload
      : nextInput;
    submission.current.payload=input;
    let result: Awaited<ReturnType<typeof submitMyLeadCommand>>;
    try {
      result=command==='handoff'&&typeof input.sequenceId==='string'&&input.sequenceId
        ? await submitMyLeadHandoffDrip({memberId:member,propertyId:row.propertyId,sequenceId:input.sequenceId,
            reason:'not_interested',expectedEpisodeId:typeof input.expectedEpisodeId==='string'?input.expectedEpisodeId:row.assignmentEpisodeId,
            expectedQueueVersion:typeof input.expectedQueueVersion==='number'?input.expectedQueueVersion:row.queueVersion,
            expectedSharedStatus:typeof input.expectedSharedStatus==='string'?input.expectedSharedStatus:row.sharedStatus,
            idempotencyKey:submission.current.key})
        : await submitMyLeadCommand(command,input);
    } catch(error) {
      // A rejected server action can mean the request reached Postgres but its
      // response did not reach the browser. Retain the exact request so the
      // next click is a server-side replay instead of a second mutation.
      submission.current.uncertain=true;
      if(activeDialog.current===dialog)setRecovery({opening:dialog,message:'Sandra could not confirm this save. The original request is preserved for reconciliation.',blocked:false,busy:false,reconciliation:{command,payload:submission.current.payload??input}});
      throw error;
    }
    if(!result.ok&&result.message==='The update was not confirmed. Retry with the same form.') {
      submission.current.uncertain=true;
      if(activeDialog.current===dialog)setRecovery({opening:dialog,message:'Sandra could not confirm this save. The original request is preserved for reconciliation.',blocked:false,busy:false,reconciliation:{command,payload:submission.current.payload??input}});
    }
    if(!result.ok){
      const failure=result as {message:string;code?:string};
      if((failure.code==='FORBIDDEN'||failure.code==='STALE_STATE')&&activeDialog.current===dialog)
        setRecovery({opening:dialog,message:failure.message,blocked:true,busy:false});
    }
    if(result.ok){
      const dripFailure='dripFailure' in result && result.dripFailure ? `Outcome saved. Drip not started: ${result.dripFailure}` : null;
      setRecovery(null);
      // Publish the refresh barrier before closing so a rapid next click is retained
      // and initialized from authorized post-command metadata, never the old row.
      const linkedTarget=linkedRow(dialog.row.propertyId);
      const queueRead=refresh();
      const read=linkedTarget
        ? Promise.all([refreshLinkedLead(dialog.row.propertyId),queueRead]).then(([linked,queue])=>{
            if(!linked.ok){if(!('stale' in linked))setError(linked.message);return queue;}
            if(linked.lookup.status==='unavailable'){
              setLinkedLead({status:'terminal',message:selectedLeadUnavailableMessage(linked.lookup.reason)});
              setDialog(current=>current===dialog?null:current);
              submission.current=null;
            }
            return queue;
          })
        : queueRead;
      mutationReads.current.set(dialog.row.propertyId,{scope:openingScope,episodeId:dialog.row.assignmentEpisodeId,requestId:request.current,read});
      const followUpPending = dialog.action === 'log-attempt' && input.outcome === 'no_answer' &&
        (!result.followUp || !['accepted','delivered'].includes(result.followUp.status));
      if(!followUpPending && dialog.action!=='log-attempt' && dialog.action!=='handoff'){
        setDialog(current=>current===dialog?null:current);
        // This result is the confirmed terminal outcome for the opening.
        // A subsequent dialog gets a fresh idempotency key.
        submission.current=null;
      }
      setDetailRevision(revision=>revision+1);
      if(dialog.action==='log-attempt'||dialog.action==='handoff') void read.then(()=>{if(dripFailure)setError(dripFailure);router.refresh();});
      else {await read;router.refresh();}
    }
    return result;
  },[dialog,refresh,router,recovery,openingScope,member,linkedRow,refreshLinkedLead]);
  const pages=snapshot?stagePages(snapshot,drips):null;
  const loadSelectedDetail=useCallback(async(propertyId:string):Promise<MyLeadDetailResult>=>{
    if(member!==initialMemberId)return {ok:false as const,message:'This lead is opened in your own My Leads queue. Switch back to your queue to continue.'};
    const result=await loadMyLeadDetail({memberId:initialMemberId,propertyId});
    return result.ok?{ok:true as const,detail:detailView(result.detail,roster)}:result;
  },[initialMemberId,member,roster]);
  const loadSelectedDetailPage=useCallback(async(propertyId:string,group:MyLeadDetailGroupName,cursor:string|null):Promise<MyLeadDetailPageResult>=>{
    if(member!==initialMemberId)return {ok:false as const,message:'This lead is opened in your own My Leads queue. Switch back to your queue to continue.'};
    const result=await loadMyLeadDetail({memberId:initialMemberId,propertyId,group,cursor});if(!result.ok)return result;
    const detail=detailView(result.detail,roster);
    switch(group){case 'messages':return {ok:true,group,page:detail.messages};case 'notes':return {ok:true,group,page:detail.notes};case 'attempts':return {ok:true,group,page:detail.attempts};case 'appointments':return {ok:true,group,page:detail.appointments};case 'offers':return {ok:true,group,page:detail.offers};case 'history':return {ok:true,group,page:detail.history};}
  },[initialMemberId,member,roster]);
  if(pages)for(const stage of loadingStages)pages[stage].isLoadingMore=true;
  const motivation=dialog?.row.motivationKind==='specified'?{kind:'specified' as const,text:dialog.row.motivationText??''}:dialog?.row.motivationKind==='no_motivation'?{kind:'no_motivation' as const,text:null}:null;
  // Completion callbacks belong to one opening, even when the same lead is reopened.
  // A previous form can finish after its post-save refresh and must not close a new form.
  const common=dialog?{open:true,propertyId:dialog.row.propertyId,propertyLabel:dialog.row.address,onOpenChange:(open:boolean)=>{if(!open){submission.current=null;setDialog(current=>current===dialog?null:current);}}}:null;
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
    {error&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{error} <Button variant="outline" onClick={()=>void refresh()}>Refresh</Button></div>}
    {refreshError&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{refreshError} Displayed counts may be out of date. Retrying automatically. <Button variant="outline" onClick={()=>void refresh()}>Retry now</Button> <Button variant="outline" onClick={()=>window.location.reload()}>Reload and reconnect</Button></div>}
    {dialpad&&roster.settings.enabled&&<DialpadPanel bootstrap={dialpad} callRequest={dialpadRequest}
      onCallRequestHandled={onCallRequestHandled}
      onRecordingFinalResult={()=>{void refresh(true);}}
      onLogOutcome={(propertyId,callActivityId)=>{const row=rawRow(propertyId)??linkedRow(propertyId);if(!row){setError('This lead is no longer in your queue.');return;}action('log-attempt',propertyId,callActivityId,row);}}/>}
    {linkedLead.status==='invalid'&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">
      {linkedLead.reason==='duplicate'?'This My Leads link contains more than one lead. Open a link with exactly one lead.':'This My Leads link is invalid. Open a link with a valid lead id.'}
    </div>}
    {linkedLead.status==='unavailable'&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{linkedLead.message}{linkedLead.retryHref&&<> <a href={linkedLead.retryHref} className="font-bold underline underline-offset-4">Retry</a></>}</div>}
    {linkedLead.status==='error'&&<div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">{linkedLead.message} <a href={linkedLead.retryHref} className="font-bold underline underline-offset-4">Retry</a></div>}
    {linkedLead.status==='terminal'&&<div role="status" className="mb-4 rounded border p-3 text-muted-foreground">{linkedLead.message}</div>}
    {linkedLead.status==='found'&&<SelectedLeadView
      lead={linkedLead}
      active={member===initialMemberId}
      onLoadDetail={loadSelectedDetail}
      onLoadDetailPage={loadSelectedDetailPage}
      onStageAction={kind=>action(kind,linkedLead.propertyId,undefined,linkedLead.row)}
      onLeadChanged={()=>{void refreshLinkedLead(linkedLead.propertyId);void refresh();router.refresh();}}
    />}
    {!roster.settings.enabled?<p>My Leads is not enabled yet.</p>:!pages||!kpis||!tiles?<p role="status">Loading My Leads…</p>:<>
      <MyLeadsQueue canSelectRep={viewer.isOwner} stages={pages} drips={drips} kpis={tiles} search={search} selectedRepId={member}
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
    {common&&dialog?.action==='log-attempt'&&<AcquisitionAttemptDialog {...common} onSubmit={payload=>submit(payload)} onDripChanged={()=>{void refresh();router.refresh();}} key={`${dialog.row.propertyId}:${dialog.callActivityId??''}`} initialCallActivityId={dialog.callActivityId??null} callReferenceOptions={callOptions?.propertyId===dialog.row.propertyId?callOptions.options:[]} callReferencesLoading={!callOptions} callReferencesError={callOptions?.error} onRetryCallReferences={()=>setCallRetry(value=>value+1)}/>}
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

type SelectedLeadViewProps={
  lead:Extract<SelectedLeadResult,{status:'found'}>;
  active:boolean;
  onLoadDetail:(propertyId:string)=>Promise<MyLeadDetailResult>;
  onLoadDetailPage:(propertyId:string,group:MyLeadDetailGroupName,cursor:string|null)=>Promise<MyLeadDetailPageResult>;
  onStageAction:(action:MyLeadAction)=>void;
  onLeadChanged:()=>void;
};

/**
 * Render the server-authorized link target through the same row/detail surface
 * as the queue. This keeps deep links useful when the lead is outside the
 * first page or current filter without changing the owner's selected queue.
 */
function SelectedLeadView({lead,active,onLoadDetail,onLoadDetailPage,onStageAction,onLeadChanged}:SelectedLeadViewProps){
  const [detailsOpen,setDetailsOpen]=useState(true);
  const [detailState,setDetailState]=useState<MyLeadDetailState>({status:'loading'});
  const detailRequest=useRef(0);
  const view=useMemo(()=>queueRowView(lead.row,lead.snapshotAt),[lead.row,lead.snapshotAt]);
  const load=useCallback(async(requestId=++detailRequest.current)=>{
    if(!active){setDetailState({status:'error',message:'This lead is opened in your own My Leads queue. Switch back to your queue to continue.'});return;}
    setDetailState(current=>current.status==='ready'?current:{status:'loading'});
    try{
      const result=await onLoadDetail(lead.propertyId);
      if(detailRequest.current!==requestId)return;
      setDetailState(result.ok?{status:'ready',detail:result.detail}:{status:'error',message:result.message});
    }catch{if(detailRequest.current===requestId)setDetailState({status:'error',message:'This lead is unavailable in your My Leads queue.'});}
  },[active,lead.propertyId,onLoadDetail]);
  useEffect(()=>{
    const requestId=++detailRequest.current;
    let cancelled=false;
    queueMicrotask(()=>{if(!cancelled)void load(requestId);});
    return()=>{cancelled=true;};
  },[load]);

  if(!active)return <div role="alert" className="mb-4 rounded border border-destructive p-3 text-destructive">This lead is opened in your own My Leads queue. Switch back to your queue to continue.</div>;
  return <section aria-label="Selected lead from link" className="mb-6 space-y-2">
    <p className="text-sm font-semibold text-muted-foreground">Opened from a My Leads link</p>
    <MyLeadQueueRow
      row={view}
      idSuffix="-linked"
      detailsOpen={detailsOpen}
      detailState={detailState}
      onToggleDetails={()=>setDetailsOpen(open=>!open)}
      onRetryDetails={()=>{void load();}}
      onDetailChanged={onLeadChanged}
      onLoadDetailPage={(group,cursor)=>onLoadDetailPage(lead.propertyId,group,cursor)}
      onStageAction={(action)=>onStageAction(action)}
    />
  </section>;
}
