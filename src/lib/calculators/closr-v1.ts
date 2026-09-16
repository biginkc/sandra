import type { CalculatorDecision, CalculatorInputs, CalculatorResults } from './types';

export const FORMULA_VERSION = 'closr-worksheet-v1';
export const WORKSHEET_SHA256 = '1017cc7835ae7f41a8d32e3228b9510fe01697c4a018f22b86df7c1061a4bdf8';
export const DEFAULT_INPUTS: CalculatorInputs = {
  asIs: null, listingPercentage: .9, profit: 20000, flatFee: 150, attorney: 995,
  titleInsurance: 500, efile: 35, recording: 25, taxStamps: 200, pictures: 300,
  other: 500, repairs: 0, arv: null, rehab: null,
};
export const DEFAULT_DECISION: CalculatorDecision = {
  approach: 'novation', program: 'equity_protection', feeTier: 10000,
  proposedOffer: null, terms: '', motivation: '',
};
export const EXPENSE_FIELDS = [
  ['flatFee', 'Flat-fee listing'], ['attorney', 'Attorney'], ['titleInsurance', 'Title insurance'],
  ['efile', 'E-file'], ['recording', 'Recording'], ['taxStamps', 'Tax / stamps'],
  ['pictures', 'Pictures'], ['other', 'Other expenses'], ['repairs', 'Buyer-requested repairs'],
] as const;
export const REHAB_REFERENCE = [
  { condition: 'Light', values: [10,15,20,30,40] },
  { condition: 'Average', values: [25,35,45,55,70] },
  { condition: 'Heavy', values: [50,60,90,100,120] },
  { condition: 'Full gut', values: [75,100,125,150,200] },
] as const;

/** Render the stored listing factor as a percentage without introducing a rounding step. */
export function formatListingPercentage(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '';
  const raw = String(value);
  const [rawMantissa, rawExponent = '0'] = raw.toLowerCase().split('e');
  const sign = rawMantissa.startsWith('-') ? '-' : '';
  const mantissa = rawMantissa.replace(/^[+-]/, '');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + Number(rawExponent) + 2;
  const shifted = decimalIndex <= 0
    ? `0.${'0'.repeat(-decimalIndex)}${digits}`
    : decimalIndex >= digits.length
      ? `${digits}${'0'.repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  const [shiftedWhole, shiftedFraction = ''] = shifted.split('.');
  const normalizedWhole = shiftedWhole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = shiftedFraction.replace(/0+$/, '');
  return `${sign}${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

/** Source formulas; retain fractional amounts and the worksheet's operation order. */
export function calculateClosr(i: CalculatorInputs): CalculatorResults {
  const n = (key: keyof CalculatorInputs) => i[key] ?? 0;
  const commission = n('asIs') * .04;
  const listing = n('asIs') * n('listingPercentage');
  const expenses = EXPENSE_FIELDS.reduce((sum, [key]) => sum + n(key), 0);
  // B17 subtracts SUM(B5:B14), including commission in the same sum.
  const totalExpenses = EXPENSE_FIELDS.reduce((sum, [key]) => sum + n(key), commission);
  const equity = (listing - totalExpenses) - n('profit');
  const arv70 = n('arv') * .7;
  const offers = {
    fee40000: arv70 - n('rehab') - 40000, fee30000: arv70 - n('rehab') - 30000,
    fee20000: arv70 - n('rehab') - 20000, fee10000: arv70 - n('rehab') - 10000,
  };
  return { commission, listing, expenses, equity, family: equity*.85, secure: equity*.75,
    rapid: equity*.67, arv70, investor: offers.fee10000 + 10000, offers };
}
export const formatDollars = (amount: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(amount);
