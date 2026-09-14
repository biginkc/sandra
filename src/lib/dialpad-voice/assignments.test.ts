import { describe, expect, it } from 'vitest';
import { resolveDialpadAssignment, type DialpadCallerIdentity } from './assignments';
function fixture(type: DialpadCallerIdentity['type'] = 'user') {
  const identity = { type, id: type === 'user' ? '9007199254740993' : '42' };
  return {
    viewer: { orgId: 'org', memberId: 'rep' },
    membership: { orgId: 'org', memberId: 'rep', active: true, acquisitionsEnabled: true },
    binding: { orgId: 'org', memberId: 'rep', providerUserId: '9007199254740993', version: 2, active: true, adminValidated: true },
    grants: [{ id: 'grant', orgId: 'org', memberId: 'rep', providerUserId: '9007199254740993', version: 3, bindingVersion: 2, number: '+12025550101', identity, active: true }],
    inventory: { orgId: 'org', providerUserId: '9007199254740993', callers: [{ number: '+12025550101', identity, active: true }] },
    selection: { grantId: 'grant', version: 3 },
  };
}
describe('authorized acquisitions Dialpad assignment', () => {
  it.each([['user',null],['office','Office'],['department','OfficeGroup'],['callcenter','CallCenter']] as const)('maps %s from authorized inventory to %s', (type, mapped) => {
    const result=resolveDialpadAssignment(fixture(type));expect(result.ok).toBe(true);
    if(result.ok) { if (mapped === null) expect(result.snapshot.ctiIdentity).toBeNull(); else expect(result.snapshot.ctiIdentity?.type).toBe(mapped);expect(result.snapshot.providerUserId).toBe('9007199254740993'); }
  });
  it('requires current active acquisitions membership and administrator-validated binding', () => {
    for(const patch of [{active:false},{acquisitionsEnabled:false},{orgId:'other'},{memberId:'other'}]) { const f=fixture();Object.assign(f.membership,patch);expect(resolveDialpadAssignment(f)).toEqual({ok:false,code:'membership_denied'}); }
    for(const patch of [{active:false},{adminValidated:false},{orgId:'other'},{memberId:'other'},{providerUserId:'0'}]) {const f=fixture();Object.assign(f.binding,patch);expect(resolveDialpadAssignment(f)).toEqual({ok:false,code:'binding_denied'});}
  });
  it('rejects forged, ambiguous, revoked and cross-member grant selections', () => {
    for(const patch of [{id:'other'},{active:false},{orgId:'other'},{memberId:'other'},{providerUserId:'123'}]) {const f=fixture();Object.assign(f.grants[0],patch);expect(resolveDialpadAssignment(f)).toEqual({ok:false,code:'grant_denied'});}
    const f=fixture();f.grants.push({...f.grants[0]});expect(resolveDialpadAssignment(f)).toEqual({ok:false,code:'grant_denied'});
  });
  it('fences both grant edits and binding reassignment versions', () => {
    for(const patch of [{version:4},{version:NaN},{bindingVersion:1}]) {const f=fixture();Object.assign(f.grants[0],patch);expect(resolveDialpadAssignment(f)).toEqual({ok:false,code:'stale_selection'});}
  });
  it('requires exact current per-user caller ID and ownership identity', () => {
    for(const change of ['number','identity','inactive','inventory-user','inventory-org']) {const f=fixture('department');
      if(change==='number')f.inventory.callers[0].number='+12025550102';
      if(change==='identity')f.inventory.callers[0]={...f.inventory.callers[0],identity:{type:'office',id:'42'}};
      if(change==='inactive')f.inventory.callers[0].active=false;
      if(change==='inventory-user')f.inventory.providerUserId='123';
      if(change==='inventory-org')f.inventory.orgId='other';
      expect(resolveDialpadAssignment(f)).toEqual({ok:false,code:'caller_unavailable'});
    }
  });
  it('cannot use another user identity even if a malformed inventory contains it', () => {const f=fixture();f.grants[0].identity.id='123';expect(resolveDialpadAssignment(f)).toEqual({ok:false,code:'grant_denied'});});
  it('copies and freezes dispatch identity independently of later grant edits', () => {
    const f=fixture('office'),result=resolveDialpadAssignment(f);expect(result.ok).toBe(true);if(!result.ok)return;
    f.grants[0].number='+12025550102';f.grants[0].identity.id='77';
    expect(result.snapshot.callerId).toBe('+12025550101');expect(result.snapshot.identity.id).toBe('42');
    expect(Object.isFrozen(result.snapshot)).toBe(true);expect(Object.isFrozen(result.snapshot.identity)).toBe(true);expect(Object.isFrozen(result.snapshot.ctiIdentity)).toBe(true);
  });
  it('supports separate reps without shared personal constants', () => {const f=fixture();f.viewer.memberId=f.membership.memberId=f.binding.memberId=f.grants[0].memberId='second-rep';expect(resolveDialpadAssignment(f).ok).toBe(true);});
});
