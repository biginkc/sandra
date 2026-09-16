import { describe, expect, it } from 'vitest';
import { canViewCalculators } from './access';
import type { AcquisitionRoster } from '@/lib/my-leads/queries';
const roster = (overrides:Partial<AcquisitionRoster['members'][number]>={}, isOwner=false):AcquisitionRoster=>({isOwner,settings:{enabled:true,recipientId:null,revision:1},members:[{id:'me',label:'Test',role:isOwner?'owner':'member',acquisitionsEnabled:true,active:true,hasHistory:false,...overrides}]});
describe('calculator workspace membership',()=>{
 it('allows active acquisitions members',()=>expect(canViewCalculators(roster(),'me')).toBe(true));
 it('denies owners who are not acquisition members',()=>expect(canViewCalculators(roster({acquisitionsEnabled:false},true),'me')).toBe(false));
 it('denies inactive, missing, and nonacquisition members',()=>{
  expect(canViewCalculators(roster({active:false}),'me')).toBe(false);
  expect(canViewCalculators(roster(),'other')).toBe(false);
  expect(canViewCalculators(roster({acquisitionsEnabled:false}),'me')).toBe(false);
 });
 it('honors the organization workflow flag',()=>{const r=roster();r.settings.enabled=false;expect(canViewCalculators(r,'me')).toBe(false);});
});
