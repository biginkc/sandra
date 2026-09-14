import { describe, expect, it } from 'vitest';
import { InvalidDialpadPersonas, normalizeDialpadPersonas } from './personas';
const scope = { orgId: 'test-org', providerUserId: '9007199254740993' };
const persona = (type = 'user', id = scope.providerUserId) => ({ id, type, caller_id: '+12025550101', name: 'Test persona', image_url: '', phone_numbers: ['+12025550101'] });
describe('Dialpad persona inventory', () => {
  it('expands actual persona arrays for personal and all supported groups', () => {
    const input = [persona(), ...['office', 'department', 'callcenter'].map((type, index) => ({ ...persona(type, String(index + 1)), phone_numbers: ['+12025550102', '+12025550103'] }))];
    const result = normalizeDialpadPersonas(input, scope);
    expect(result.callers).toHaveLength(7);
    expect(result.callers.map(caller => caller.identity.type)).toEqual(['user','office','office','department','department','callcenter','callcenter']);
    expect(result.providerUserId).toBe(scope.providerUserId);
  });
  it('deduplicates exact triples but retains shared numbers under distinct group identities', () => {
    const result = normalizeDialpadPersonas([persona('office','1'), persona('office','1'), persona('office','2'), persona('department','1')], scope);
    expect(result.callers).toHaveLength(3);
    expect(result.callers.map(caller => caller.identity)).toEqual([{type:'office',id:'1'},{type:'office',id:'2'},{type:'department',id:'1'}]);
  });
  it('never falls back to caller_id for an empty phone_numbers array', () => {
    expect(normalizeDialpadPersonas([{...persona(),phone_numbers:[]}],scope).callers).toEqual([]);
    expect(normalizeDialpadPersonas([],scope).callers).toEqual([]);
  });
  it('rejects malformed entire inventory including a bad group after a valid persona', () => {
    for (const patch of [{id:12},{id:Number.MAX_SAFE_INTEGER+1},{id:'0'},{id:'1.5'},{type:'team'},{type:'Office'},{caller_id:''},{name:null},{image_url:null},{phone_numbers:null},{phone_numbers:['invalid']},{phone_numbers:[123]}]) {
      expect(() => normalizeDialpadPersonas([persona(),{...persona('office','1'),...patch}],scope)).toThrow(InvalidDialpadPersonas);
    }
    for (const input of [null, {}, {items:[]}, [null], [[]]]) expect(() => normalizeDialpadPersonas(input,scope)).toThrow(InvalidDialpadPersonas);
  });
  it('rejects another personal user even if its number matches', () => {
    expect(() => normalizeDialpadPersonas([persona('user','123')],scope)).toThrow(InvalidDialpadPersonas);
  });
  it('validates server scope and does not leak payload in errors', () => {
    expect(() => normalizeDialpadPersonas([], {...scope,orgId:''})).toThrow(InvalidDialpadPersonas);
    expect(() => normalizeDialpadPersonas([], {...scope,providerUserId:'1e3'})).toThrow(InvalidDialpadPersonas);
    try { normalizeDialpadPersonas([{...persona(),name:'Sensitive name',phone_numbers:['Sensitive phone']}],scope); }
    catch (error) { expect((error as Error).message).toBe('Invalid Dialpad caller inventory'); }
  });
  it('copies identities and numbers and freezes resolved inventory', () => {
    const entry=persona('office','1'),result=normalizeDialpadPersonas([entry],scope);
    entry.id='2';entry.phone_numbers[0]='+12025550102';
    expect(result.callers[0]).toEqual({number:'+12025550101',identity:{type:'office',id:'1'},active:true});
    expect(Object.isFrozen(result.callers)).toBe(true);expect(Object.isFrozen(result.callers[0].identity)).toBe(true);
  });
});
