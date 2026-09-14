import { Page } from '@/components/page';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { canViewMyLeads } from '@/lib/my-leads/access';
import { getAcquisitionRoster,getAcquisitionQueue,getAcquisitionKpis } from '@/lib/my-leads/queries';
import { MyLeadsClient } from './client';
export default async function MyLeadsPage() {
  const {viewer,roster}=await getAcquisitionRoster();
  if(!canViewMyLeads(roster,viewer.userId)) notFound();
  let data;
  let failure:string|null=null;
  try {
    const memberId=viewer.isOwner?roster.members.find(m=>m.active&&m.acquisitionsEnabled)?.id??viewer.userId:viewer.userId;
    const [snapshot,kpis]=roster.settings.enabled?await Promise.all([getAcquisitionQueue({memberId}),getAcquisitionKpis({memberId,period:'today'})]):[null,null];
    data={viewer,roster,memberId,snapshot,kpis};
  }catch(error){failure=error instanceof Error?error.message:'My Leads could not load.';}
  return <Page>{data?<MyLeadsClient viewer={data.viewer} roster={data.roster} initialMemberId={data.memberId} initialSnapshot={data.snapshot} initialKpis={data.kpis}/>:<><PageHeader title="My Leads"/><p role="alert">{failure}</p></>}</Page>;
}
