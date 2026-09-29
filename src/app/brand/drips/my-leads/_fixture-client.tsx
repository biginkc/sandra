'use client';

import { useState } from 'react';
import Image from 'next/image';
import { DashboardSidebar } from '@/components/dashboard-sidebar';
import { MyLeadsQueue } from '@/app/(dashboard)/my-leads/_components/queue';
import { AcquisitionAttemptDialog } from '@/app/(dashboard)/my-leads/_components/attempt-dialog';
import { AcquisitionLifecycleDialog } from '@/app/(dashboard)/my-leads/_components/lifecycle-dialog';
import type { MyLeadQueueRow, MyLeadStagePage, MyLeadsKpis } from '@/app/(dashboard)/my-leads/_components/types';
import type { MyLeadDripSnapshot } from '@/lib/my-leads/drip-queries';

const blankDetail={messages:{rows:[],hasMore:false,nextCursor:null},notes:{rows:[],hasMore:false,nextCursor:null},
  attempts:{rows:[],hasMore:false,nextCursor:null},appointments:{rows:[],hasMore:false,nextCursor:null},
  offers:{rows:[],hasMore:false,nextCursor:null},history:{rows:[],hasMore:false,nextCursor:null}};
const row=(id:string,address:string,name:string,stage:MyLeadQueueRow['queueStage']):MyLeadQueueRow=>({
  propertyId:id,queueStage:stage,address,homeownerName:name,phone:'(512) 555-0100',
  assignment:{state:'known',label:'2d ago'},firstCall:{state:'started',label:'12 min elapsed'},
  warningReasons:[],attemptsCount:2,motivation:{temperature:'warm',motivationResponseKind:'provided',text:'Considering an offer'},
  nextStep:null,offer:null,archived:false,
});
const replied={propertyId:'fixture-replied',enrollmentId:'enrollment-replied',enrollmentStatus:'paused',sequenceId:'drip-1',sequenceName:'Seller follow-up',
  step:2,totalSteps:4,nextTextAt:null,lastText:{sentAt:'2026-09-28T15:00:00Z',preview:'Checking in about your property'},
  status:'Replied' as const,reason:'Lead replied to a drip text.',stage:'contacted' as const,
  repliedAt:'2026-09-29T14:00:00Z',queueRow:null};
const drip=(id:string,name:string,address:string,step:number):MyLeadDripSnapshot['active'][number]=>({
  propertyId:id,enrollmentId:`enrollment-${id}`,enrollmentStatus:'active',sequenceId:'drip-1',sequenceName:name,step,totalSteps:4,
  nextTextAt:'2026-10-01T15:00:00Z',lastText:{sentAt:'2026-09-28T15:00:00Z',preview:'Hi, following up about your property.'},
  status:'Waiting',reason:null,stage:'contacted',repliedAt:null,queueRow:row(id,address,'Alex Morgan','contacted') as never,
});
const drips:MyLeadDripSnapshot={active:[drip('fixture-drip-1','Seller follow-up','112 Oak Street',2),
  drip('fixture-drip-2','Warm check-in','48 Elm Avenue',1),drip('fixture-drip-3','Seller follow-up','9 Willow Lane',3)],
  replied:[replied],repliedCount:1,counts:{not_contacted:0,contacted:3,needs_offer:0,offer_sent:0,under_contract:0}};
const stage=(name:MyLeadQueueRow['queueStage'],rows:MyLeadQueueRow[],totalCount=rows.length):MyLeadStagePage=>({stage:name,rows,totalCount,hasMore:false});
const stages={not_contacted:stage('not_contacted',[row('fixture-new','19 Pine Road','Jordan Lee','not_contacted')]),
  contacted:stage('contacted',[{...row('fixture-replied','27 Main Street','Riley Chen','contacted'),dripReply:replied},
    row('fixture-contacted','62 Cedar Drive','Taylor Brooks','contacted')]),
  needs_offer:stage('needs_offer',[row('fixture-offer','14 Park Place','Cameron Diaz','needs_offer')]),
  offer_sent:stage('offer_sent',[]),under_contract:stage('under_contract',[])};
const kpis:MyLeadsKpis={attempts:12,reached:6,offersSent:2,contactWithoutFollowUp:2,needsOffers:2,
  appointmentsOverdue:1,lastAttemptAt:'2026-09-29T14:00:00Z',asOf:'2026-09-29T15:00:00Z',missingRecordings:0,
  recordingExpectationUnknown:0,averageTalkSeconds:180,talkTimeSamples:6,talkTimeUnknown:0,conversationsOverFiveMinutes:2};

export function MyLeadsBrandFixture({view}:{view:'main'|'log-attempt'|'handoff'}) {
  const [open,setOpen]=useState(false);
  return <div data-testid={`drips-brand-${view}`}>
    <aside className="nav-field fixed inset-y-0 left-0 hidden w-64 flex-col md:flex">
      <div className="mb-4 flex items-center justify-center px-5 pt-5 pb-3"><Image src="/brand/sandra-logo-home.svg" alt="Sandra" width={152} height={154} priority /></div>
      <DashboardSidebar activePathname="/my-leads" showCalculators showMyLeads showMessagesAndLeads showRecordings initialAcquisitionBadge={99}/>
    </aside>
    <header className="nav-field fixed inset-x-0 top-0 z-20 hidden h-16 items-center px-7 text-sm text-white md:left-64 md:flex">Team　　Webhooks　　AI responder</header>
    <main className="mx-auto max-w-[1600px] p-8 pt-24 md:pl-[288px]">
    <MyLeadsQueue stages={stages} drips={drips} kpis={kpis} search="" selectedRepId="fixture-rep"
      selectedRepLabel="Andrea" repOptions={[{id:'fixture-rep',label:'Andrea'}]}
      onSearchChange={()=>{}} onRepChange={()=>{}} onLoadMore={()=>{}}
      onLoadDetail={async()=>({ok:true,detail:blankDetail})} onStageAction={()=>{}} />
    {view!=='main'&&<button type="button" onClick={()=>setOpen(true)} className="mt-4 rounded border px-3 py-2">Open fixture dialog</button>}
    {view==='log-attempt'&&<AcquisitionAttemptDialog open={open} onOpenChange={setOpen}
      propertyId="fixture-new" propertyLabel="19 Pine Road" callReferenceOptions={[]}
      previewDripChoices={[{id:'drip-1',name:'Seller follow-up',textCount:4,days:90,firstSend:'Today'}]}
      onSubmit={async()=>({ok:true})}/>}
    {view==='handoff'&&<AcquisitionLifecycleDialog open={open} onOpenChange={setOpen} mode="handoff"
      propertyId="fixture-new" propertyLabel="19 Pine Road" recipientOptions={[{id:'fixture-recipient',label:'Follow-up owner'}]}
      initialRecipientUserId="fixture-recipient" previewDripChoices={[{id:'drip-1',name:'Seller follow-up',textCount:4,days:90,firstSend:'Today'},
        {id:'drip-2',name:'Warm check-in',textCount:3,days:30,firstSend:'Tomorrow'}]} onSubmit={async()=>({ok:true})}/>}
    </main>
  </div>;
}
