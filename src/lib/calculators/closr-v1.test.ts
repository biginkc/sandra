import { describe,it,expect } from 'vitest';
import fixtures from './worksheet-fixtures.json';
import { calculateClosr, DEFAULT_INPUTS, formatDollars } from './closr-v1';
describe('CLOSR worksheet parity (LibreOffice-recalculated source caches)',()=>{
  for(const fixture of fixtures) it(fixture.name,()=>{
    const r=calculateClosr(fixture.inputs);
    const cells={B5:r.commission,B17:r.equity,B19:r.family,B21:r.secure,B23:r.rapid,B26:r.listing,E21:r.offers.fee40000,E22:r.offers.fee30000,E23:r.offers.fee20000,E24:r.offers.fee10000,E26:r.investor};
    for(const key of Object.keys(cells) as (keyof typeof cells)[]) {
      expect(Math.abs(cells[key]-fixture.worksheet[key]),key).toBeLessThanOrEqual(1e-9);
      expect(formatDollars(cells[key]),key).toBe(formatDollars(fixture.worksheet[key]));
    }
  });
  it('matches the supplied complete example',()=>{
    const r=calculateClosr({...DEFAULT_INPUTS,asIs:255000,arv:350000,rehab:50000});
    const expected={listing:229500,commission:10200,expenses:2705,equity:196595,family:167105.75,secure:147446.25,rapid:131718.65,arv70:245000,investor:195000};
    for(const key of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(Math.abs(r[key]-expected[key])).toBeLessThanOrEqual(1e-9);
      expect(formatDollars(r[key])).toBe(formatDollars(expected[key]));
    }
    for(const [key,value] of Object.entries({fee40000:155000,fee30000:165000,fee20000:175000,fee10000:185000})) {
      expect(Math.abs(r.offers[key as keyof typeof r.offers]-value)).toBeLessThanOrEqual(1e-9);
      expect(formatDollars(r.offers[key as keyof typeof r.offers])).toBe(formatDollars(value));
    }
  });
  it('an unlocked listing percentage changes listing and anchors, not commission or wholesale',()=>{
    const original=calculateClosr({...DEFAULT_INPUTS,asIs:255000,arv:350000,rehab:50000});
    const changed=calculateClosr({...DEFAULT_INPUTS,asIs:255000,arv:350000,rehab:50000,listingPercentage:.95});
    expect(changed.listing).toBe(242250); expect(changed.equity-original.equity).toBe(12750);
    expect(changed.commission).toBe(original.commission); expect(changed.offers).toEqual(original.offers);
  });
  it('formats half cents without changing stored precision',()=>{
    expect(formatDollars(123.125)).toBe('$123.13'); expect(formatDollars(-123.125)).toBe('-$123.13');
    const r=calculateClosr(fixtures[2].inputs); expect(r.equity).not.toBe(Number(r.equity.toFixed(2)));
  });
});
