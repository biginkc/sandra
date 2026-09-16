import { DEFAULT_INPUTS } from './closr-v1';
import type { SaveCalculationInput, CalculatorInputs, CalculatorDecision } from './types';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Check the calculation inputs.');
  return v as Record<string, unknown>;
};
export function validateCalculation(raw: unknown): SaveCalculationInput {
  const x = object(raw), input = object(x.inputs), decision = object(x.decision), provenance = object(x.provenance);
  for (const key of ['leadId', 'requestId']) if (typeof x[key] !== 'string' || !UUID.test(x[key] as string)) throw new Error('Attach a valid lead and retry.');
  if (x.parentId !== null && (typeof x.parentId !== 'string' || !UUID.test(x.parentId))) throw new Error('Invalid saved version.');
  const inputs = {} as CalculatorInputs;
  for (const key of Object.keys(DEFAULT_INPUTS) as (keyof CalculatorInputs)[]) {
    const value = input[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'listingPercentage' ? 1 : 1e12))) throw new Error(`Check ${key}: enter a valid nonnegative number.`);
    inputs[key] = value as number | null;
  }
  if (typeof decision.approach !== 'string' || !['novation','wholesale'].includes(decision.approach) ||
      typeof decision.program !== 'string' || !['equity_protection','family_placement','secure_close','rapid_relief'].includes(decision.program) ||
      ![40000,30000,20000,10000].includes(decision.feeTier as number)) throw new Error('Choose an approach, program, and fee tier.');
  if (decision.proposedOffer !== null && (typeof decision.proposedOffer !== 'number' || !Number.isFinite(decision.proposedOffer) || Math.abs(decision.proposedOffer) > 1e12)) throw new Error('Check the proposed offer.');
  for (const k of ['terms','motivation']) if (typeof decision[k] !== 'string' || decision[k].length > 10000) throw new Error('Notes must be at most 10,000 characters.');
  if (typeof provenance.source !== 'string' || !['lead_calculations','lead_search','saved_calculation'].includes(provenance.source) || provenance.leadId !== x.leadId) throw new Error('Reattach the selected lead.');
  return { leadId: x.leadId as string, requestId: x.requestId as string, parentId: x.parentId as string|null,
    inputs, decision: { approach: decision.approach, program: decision.program, feeTier: decision.feeTier,
      proposedOffer: decision.proposedOffer, terms: decision.terms, motivation: decision.motivation } as CalculatorDecision,
    provenance: { source: provenance.source, leadId: x.leadId } as SaveCalculationInput['provenance'] };
}
