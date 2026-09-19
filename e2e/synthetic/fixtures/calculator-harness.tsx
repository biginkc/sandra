import React from 'react';
import { createRoot } from 'react-dom/client';
import CalculatorClient from '../../../src/app/(dashboard)/calculators/client';
import { calculateClosr } from '../../../src/lib/calculators/closr-v1';
import type { CalculatorSnapshot,SaveCalculationInput } from '../../../src/lib/calculators/types';
const lead={id:'11111111-1111-4111-8111-111111111111',address:'123 Test Lane, Test City, MO',seller:'Calculator Test Seller',status:'new_lead'};
const store:CalculatorSnapshot[]=[];
let failNext=false;
let key=0;
const root=createRoot(document.getElementById('root')!);
const requests:SaveCalculationInput[]=[];
const receipts=new Map<string,CalculatorSnapshot>();
async function save(input:SaveCalculationInput) {
  requests.push(input);
  let record=receipts.get(input.requestId);
  if(!record){record={id:crypto.randomUUID(),property_id:input.leadId,org_id:'org',series_id:store[0]?.series_id??crypto.randomUUID(),version:store.length+1,parent_id:input.parentId,created_at:new Date().toISOString(),created_by:'test',worksheet_sha256:'1017cc7835ae7f41a8d32e3228b9510fe01697c4a018f22b86df7c1061a4bdf8',formula_version:'closr-worksheet-v1',inputs:input.inputs,results:calculateClosr(input.inputs),decision:input.decision,provenance:input.provenance};store.push(record);receipts.set(input.requestId,record);}
  if(failNext){failNext=false;throw new Error('Simulated lost response after commit');}
  return {ok:true as const,data:record};
}
function mount(snapshot:CalculatorSnapshot|null=null,attached=false){
  root.render(<CalculatorClient key={key++} initialLead={snapshot||attached?lead:null} initialSnapshot={snapshot} initialProvenance={attached?{source:'lead_calculations',leadId:lead.id}:null} searchLeads={async query=>({ok:true,data:!query||`${lead.address} ${lead.seller}`.toLowerCase().includes(query.toLowerCase())?[lead]:[]})} saveCalculation={save}/>);
}
Object.assign(window,{calculatorHarness:{mount,reopen:(index:number)=>mount(store[index]),store,requests,loseNextResponse:()=>{failNext=true;}}});
mount();
