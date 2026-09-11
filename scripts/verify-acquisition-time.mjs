/** Isolated PG17 proof. Creates only a private local socket/database, never a hosted target. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
const bin = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const dir = mkdtempSync(path.join(tmpdir(), 'acq-time-'));
const data = path.join(dir, 'data');
let started = false;
let client;
try {
  assert.match(execFileSync(path.join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }), /PostgreSQL\) 17\./);
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'], { stdio: 'pipe' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'postgres.log'), '-o', `-k ${dir} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  client = new pg.Client({ host: dir, user: 'postgres', database: 'postgres' });
  await client.connect();
  await client.query('create role anon; create role authenticated; create role service_role;');
  await client.query(readFileSync(new URL('../supabase/migrations/20260912080000_acquisition_time_helpers.sql', import.meta.url), 'utf8'));
  const vectors = [
    ['2026-09-11T21:50:00Z', '2026-09-14T14:20:00Z'],
    ['2026-03-06T22:50:00Z', '2026-03-09T14:20:00Z'],
    ['2026-10-30T21:50:00Z', '2026-11-02T15:20:00Z'],
    ['2026-09-11T22:00:00Z', '2026-09-14T14:30:00Z'],
    ['2026-09-14T04:59:00Z', '2026-09-14T14:30:00Z'],
    ['2026-09-14T14:00:00Z', '2026-09-14T14:30:00Z'],
  ];
  for (const [start, end] of vectors) {
    const { rows: [row] } = await client.query('select public.acquisition_working_deadline($1) as deadline, public.acquisition_working_minutes($1,$2) as minutes', [start, end]);
    assert.equal(row.deadline.toISOString(), new Date(end).toISOString());
    assert.equal(row.minutes, 30);
  }
  const { rows: [fraction] } = await client.query("select public.acquisition_working_minutes('2026-09-11T21:59:30Z','2026-09-14T14:00:15Z') as minutes");
  assert.equal(fraction.minutes, 0.75);
  await client.query('set role authenticated');
  await assert.rejects(client.query('select public.acquisition_working_deadline(now())'), error => error.code === '42501');
  await client.query('reset role');
  await assert.rejects(client.query('select public.acquisition_working_deadline(now(), -1)'), error => error.code === '22023');
  console.log('PASS: PG17 migration, six deadline/minute vectors, fractional minutes, invalid duration, authenticated grant isolation');
} finally {
  await client?.end();
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
}
