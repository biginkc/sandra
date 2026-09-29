import test from 'node:test';
import assert from 'node:assert/strict';
import { hasExactKeys } from './catalog-sections.mjs';

test('exact keys reject missing, extra, combined, and delimiter-colliding names', () => {
  const valid = value => typeof value === 'string' && value.length === 64;
  const digest = 'a'.repeat(64);
  assert.equal(hasExactKeys({ alpha: digest, beta: digest }, ['alpha', 'beta'], valid), true);
  for (const value of [
    { alpha: digest },
    { alpha: digest, beta: digest, extra: digest },
    { 'alpha,beta': digest },
    { 'a,b': digest, c: digest },
    { alpha: digest, beta: 'invalid' },
  ]) assert.equal(hasExactKeys(value, ['alpha', 'beta'], valid), false);
  assert.equal(['a,b', 'c'].join(','), ['a', 'b,c'].join(','));
  assert.equal(hasExactKeys({ 'a,b': digest, c: digest }, ['a', 'b,c'], valid), false);
  assert.equal(hasExactKeys({ alpha: digest }, ['alpha', 'alpha'], valid), false);
});
