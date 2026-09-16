export type CalculatorInputs = {
  asIs: number | null; listingPercentage: number | null; profit: number | null;
  flatFee: number | null; attorney: number | null; titleInsurance: number | null;
  efile: number | null; recording: number | null; taxStamps: number | null;
  pictures: number | null; other: number | null; repairs: number | null;
  arv: number | null; rehab: number | null;
};
export type CalculatorResults = {
  commission: number; listing: number; expenses: number; equity: number;
  family: number; secure: number; rapid: number; arv70: number;
  investor: number; offers: { fee40000: number; fee30000: number; fee20000: number; fee10000: number };
};
export type CalculatorLead = { id: string; address: string; seller: string; status: string };
export type CalculatorDecision = {
  approach: 'novation' | 'wholesale';
  program: 'equity_protection' | 'family_placement' | 'secure_close' | 'rapid_relief';
  feeTier: 40000 | 30000 | 20000 | 10000;
  proposedOffer: number | null; terms: string; motivation: string;
};
export type CalculatorProvenance = { source: 'lead_calculations' | 'lead_search' | 'saved_calculation'; leadId: string };
export type CalculatorSnapshot = {
  id: string; property_id: string; org_id: string; series_id: string; version: number;
  parent_id: string | null; created_at: string; created_by: string; formula_version: string; worksheet_sha256: string;
  inputs: CalculatorInputs; results: CalculatorResults; decision: CalculatorDecision;
  provenance: CalculatorProvenance;
};
export type SaveCalculationInput = {
  leadId: string; inputs: CalculatorInputs; decision: CalculatorDecision;
  provenance: CalculatorProvenance; requestId: string; parentId: string | null;
};
export type CalculatorActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type CalculatorPageCursor = { createdAt: string; id: string };
