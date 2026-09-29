import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWriteMode, assertNoProductionRef } from './guards.mjs';

const good = { apiUrl: 'http://127.0.0.1:55421', dbUrl: 'postgresql://postgres:postgres@127.0.0.1:55422/postgres', env: { E2E_DISPOSABLE_DATABASE: '1' } };
test('disposable binding accepts only exact loopback write target', () => {
  assert.equal(assertWriteMode('disposable', good).target, 'disposable');
  const cases = [
    [{ ...good, apiUrl: 'https://another.supabase.co' }, /DISPOSABLE_API_REFUSED/],
    [{ ...good, apiUrl: 'https://copflsklaefwzipsrjqz.supabase.co' }, /HOSTED_TARGET_REFUSED/],
    [{ ...good, env: {} }, /DISPOSABLE_REQUIRED/],
    [{ ...good, dbUrl: 'postgresql://postgres:postgres@127.0.0.1:55423/postgres' }, /DISPOSABLE_DB_REFUSED/],
    [{ ...good, dbUrl: 'postgresql://service_role:postgres@127.0.0.1:55422/postgres' }, /DISPOSABLE_DB_REFUSED/],
    [{ ...good, dbUrl: 'postgresql://postgres:postgres@localhost:55422/postgres?application_name=copflsklaefwzipsrjqz' }, /HOSTED_TARGET_REFUSED/],
  ];
  for (const [value, error] of cases) assert.throws(() => assertWriteMode('disposable', value), error);
  for (const target of ['disposable-readonly', 'shared-readonly', 'production']) assert.throws(() => assertWriteMode(target, good), /WRITE_MODE_REFUSED/);
});
test('NC-T5a refuses production ref for all non-production targets', () => {
  for (const target of ['disposable', 'disposable-readonly', 'shared-readonly']) assert.throws(() => assertNoProductionRef(target, 'postgresql://postgres.copflsklaefwzipsrjqz@x/postgres'), /HOSTED_TARGET_REFUSED/);
});
