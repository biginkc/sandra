import { describe,it,expect } from 'vitest';
import { validateCalculation } from './validation';
import { DEFAULT_INPUTS,DEFAULT_DECISION } from './closr-v1';
const leadId='11111111-1111-4111-8111-111111111111';
const valid=()=>({leadId,requestId:'22222222-2222-4222-8222-222222222222',parentId:null,
  inputs:{...DEFAULT_INPUTS},decision:{...DEFAULT_DECISION},provenance:{source:'lead_search',leadId}});
describe('calculator boundary validation',()=>{
  it('preserves blanks and editable listing percentage',()=>{
    const x=valid();x.inputs.listingPercentage=.9375;
    expect(validateCalculation(x).inputs).toEqual(x.inputs);
  });
  it.each(['approach','program'])('rejects array masquerading as %s',key=>{
    const x=valid(); Object.assign(x.decision,{[key]:[x.decision[key as 'approach'|'program']]});
    expect(()=>validateCalculation(x)).toThrow();
  });
  it('rejects nonprimitive provenance and foreign lead',()=>{
    const x=valid();Object.assign(x.provenance,{source:['lead_search']});expect(()=>validateCalculation(x)).toThrow();
    Object.assign(x.provenance,{source:'lead_search',leadId:'another'});expect(()=>validateCalculation(x)).toThrow();
  });
  it.each([NaN,Infinity,-1,1e20,'250000',undefined])('rejects invalid numeric input %s',value=>{
    const x=valid();Object.assign(x.inputs,{asIs:value});expect(()=>validateCalculation(x)).toThrow();
  });
  it('strips browser-supplied results, actor, and version',()=>{
    const x={...valid(),results:{equity:999999},actorId:'spoof',formulaVersion:'spoof'};
    expect(validateCalculation(x)).not.toHaveProperty('results');
    expect(validateCalculation(x)).not.toHaveProperty('actorId');
    expect(validateCalculation(x)).not.toHaveProperty('formulaVersion');
  });
});
