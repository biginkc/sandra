import { getCalculatorLead, getReadableCalculatorLead, listCalculations } from '@/lib/calculators/server';
import type { CalculatorSnapshot } from '@/lib/calculators/types';
import { LeadCalculations } from './lead-calculations';
export async function LeadCalculationsSection({propertyId}:{propertyId:string}) {
  try { await getReadableCalculatorLead(propertyId); } catch { return null; }
  const canEdit=await getCalculatorLead(propertyId).then(()=>true).catch(()=>false);
  let initial:CalculatorSnapshot[]=[];
  let loadError:string|undefined;
  try { initial=await listCalculations(propertyId); }
  catch { loadError='Saved calculations could not load. Please retry.'; }
  return <LeadCalculations propertyId={propertyId} canEdit={canEdit} initial={initial} loadError={loadError}/>;
}
