import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { failure, service, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

// Mirrors scripts/my-leads-housekeeping.mjs: page the preview, fold the range digests into one fingerprint,
// apply each range under its own digest, and page the rollback the same way.
type Range = { after: string | null; upto: string; digest: string };
const call = async (w: World, sql: string, args: unknown[]): Promise<Json> => (await service(w.db, () => w.db.query(sql, args))).rows[0].v;
const rangeSql = 'select public.fn_contact_phone_numbers_backfill_range($1,$2,$3,$4,$5,$6,$7,$8) as v';
const previewAll = async (w: World, size: number) => {
  const ranges: Range[] = [];
  let after: string | null = null;
  let candidates = 0, toCreate = 0, toUpdate = 0;
  for (;;) {
    const r = await call(w, rangeSql, [w.org, after, size, null, false, null, null, null]);
    if (r.done) break;
    ranges.push({ after, upto: r.lastId, digest: r.digest });
    candidates += r.candidates; toCreate += r.toCreate; toUpdate += r.toUpdate;
    after = r.lastId;
  }
  const fingerprint = createHash('sha256').update(`phone_backfill_batched|${size}|${ranges.map((x) => x.digest).join(',')}`).digest('hex');
  return { ranges, candidates, toCreate, toUpdate, fingerprint };
};
const applyRange = (w: World, r: Range, run: string | null, fp: string) =>
  call(w, rangeSql, [w.org, r.after, null, r.upto, true, r.digest, run, fp]);
const applyAll = async (w: World, p: Awaited<ReturnType<typeof previewAll>>) => {
  let run: string | null = null, created = 0, updated = 0;
  for (const r of p.ranges) {
    const out = await applyRange(w, r, run, p.fingerprint);
    run = out.runId ?? run; created += out.created; updated += out.updated;
  }
  return { run, created, updated };
};
const rbSql = 'select public.fn_contact_phone_numbers_backfill_rollback_range($1,$2,$3,$4,$5,$6,$7) as v';
const rollbackAll = async (w: World, run: string, size: number) => {
  const ranges: Range[] = [];
  let after: string | null = null;
  for (;;) {
    const r = await call(w, rbSql, [run, w.org, after, size, null, false, null]);
    if (r.done) break;
    ranges.push({ after, upto: r.lastId, digest: r.digest });
    after = r.lastId;
  }
  let restored = 0, already = 0;
  const notRestored: Json[] = [];
  for (const r of ranges) {
    const out = await call(w, rbSql, [run, w.org, r.after, null, r.upto, true, r.digest]);
    restored += out.restored; already += out.alreadyRestored; notRestored.push(...out.notRestored);
  }
  const fin = await call(w, 'select public.fn_contact_phone_numbers_backfill_rollback_finish($1,$2,$3,$4,$5) as v', [run, w.org, restored, already, JSON.stringify(notRestored)]);
  return { ranges, fin };
};
const newContact = async (w: World, phones: (string | null)[]): Promise<string> => {
  const id = randomUUID();
  const t = (v: string | null | undefined) => (v ? 'mobile' : 'unknown');
  await w.db.query(
    'insert into public.contacts(id,org_id,first_name,phone_1,phone_2,phone_3,phone_1_type,phone_2_type,phone_3_type) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, w.org, 'T', phones[0] ?? null, phones[1] ?? null, phones[2] ?? null, t(phones[0]), t(phones[1]), t(phones[2])]);
  return id;
};
const asLegacy = (w: World) => w.db.query('delete from public.contact_phone_numbers where org_id=$1', [w.org]);
const count = async (w: World) => (await w.db.query('select count(*)::int n from public.contact_phone_numbers where org_id=$1', [w.org])).rows[0].n;
const oneShot = async (w: World): Promise<Json> =>
  call(w, 'select public.fn_contact_phone_numbers_backfill($1,false,null) as v', [w.org]);

describe('20261007200000 batched phone backfill', () => {
  it('pages cover the whole set: totals match the one-shot function at every batch size, and preview writes nothing', async () => {
    await withP2('phoneBatched', async (db) => {
      const w = await world(db);
      for (let i = 0; i < 11; i++) await newContact(w, [`816-555-${String(1000 + i)}`, i % 2 ? `913-555-${String(2000 + i)}` : null]);
      await asLegacy(w);
      await db.query("insert into public.contact_phone_numbers(contact_id,slot,org_id,e164) select id,1,org_id,'+18165559999' from public.contacts where org_id=$1 and phone_1 like '%1003'", [w.org]);
      const whole = await oneShot(w);
      const sizes = [1, 3, 5, 50];
      const fps = new Set<string>();
      for (const size of sizes) {
        const p = await previewAll(w, size);
        expect(p).toMatchObject({ candidates: whole.candidates, toCreate: whole.toCreate, toUpdate: whole.toUpdate });
        expect(p.ranges.length).toBe(Math.ceil(12 / size)); // the world's seller contact + 11
        fps.add(p.fingerprint);
      }
      expect(fps.size).toBe(sizes.length); // the batch size is part of what the fingerprint pins
      expect(await count(w)).toBe(1);
      expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_runs where org_id=$1', [w.org])).rows[0].n).toBe(0);
    });
  });

  it('preview and apply agree across batches: one run, a before-image per row, then nothing left', async () => {
    await withP2('phoneBatched', async (db) => {
      const w = await world(db);
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) ids.push(await newContact(w, [`816-555-${3000 + i}`, `913-555-${4000 + i}`]));
      await asLegacy(w);
      await db.query("insert into public.contact_phone_numbers(contact_id,slot,org_id,e164) values ($1,1,$2,'+18165550000')", [ids[4], w.org]);
      const p = await previewAll(w, 4);
      expect(p.ranges.length).toBeGreaterThan(1);
      const done = await applyAll(w, p);
      expect(done).toMatchObject({ created: p.toCreate, updated: 1 });
      expect(await count(w)).toBe(p.candidates);
      const imgs = (await db.query("select before from public.my_leads_housekeeping_before_images where run_id=$1 and table_name='contact_phone_numbers'", [done.run])).rows;
      expect(imgs).toHaveLength(p.candidates);
      expect(imgs.filter((r) => r.before.op === 'updated')).toHaveLength(1);
      expect(imgs.filter((r) => r.before.op === 'updated')[0].before).toMatchObject({ e164: '+18165550000', applied_e164: '+18165553004' });
      const runs = (await db.query('select kind, status, params, summary from public.my_leads_housekeeping_runs where org_id=$1', [w.org])).rows;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: 'phone_backfill', params: { batched: true, fingerprint: p.fingerprint }, summary: { created: p.toCreate, updated: 1 } });
      const second = await previewAll(w, 4);
      expect(second.candidates).toBe(0);
      expect((await applyAll(w, second)).run).toBeNull(); // no run for an empty cohort
    });
  });

  it('refuses a range that drifted since the preview, writes nothing for it, and keeps earlier ranges under their run', async () => {
    await withP2('phoneBatched', async (db) => {
      const w = await world(db);
      for (let i = 0; i < 8; i++) await newContact(w, [`816-555-${5000 + i}`]);
      await asLegacy(w);
      const p = await previewAll(w, 3);
      const last = p.ranges.at(-1)!;
      // a user edit rewrites one phone in the final range: its candidate row changes
      const victim = (await db.query('select id from public.contacts where org_id=$1 and id <= $2 and ($3::uuid is null or id > $3) and phone_1 is not null order by id desc limit 1', [w.org, last.upto, last.after])).rows[0].id;
      await db.query("update public.contacts set phone_1='816-555-9876' where id=$1", [victim]);
      await asLegacy(w);
      let run: string | null = null;
      for (const r of p.ranges.slice(0, -1)) run = (await applyRange(w, r, run, p.fingerprint)).runId ?? run;
      const before = await count(w);
      const err = await failure(db, () => applyRange(w, last, run, p.fingerprint));
      expect(err.message).toContain('FINGERPRINT_MISMATCH');
      expect(await count(w)).toBe(before);
      expect((await failure(db, () => call(w, rangeSql, [w.org, null, null, last.upto, true, null, null, null]))).message).toContain('FINGERPRINT_REQUIRED');
      expect((await failure(db, () => call(w, rangeSql, [w.org, null, null, null, true, last.digest, null, null]))).message).toContain('INVALID_INPUT');
    });
  });

  it('rolls a batched run back range by range; a row a user edit rewrote stays and is reported; clean run flips to rolled_back', async () => {
    await withP2('phoneBatched', async (db) => {
      const w = await world(db);
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push(await newContact(w, [`816-555-${6000 + i}`]));
      await asLegacy(w);
      await db.query("insert into public.contact_phone_numbers(contact_id,slot,org_id,e164) values ($1,1,$2,'+18165550001')", [ids[2], w.org]);
      const stale = (await db.query('select e164, updated_at from public.contact_phone_numbers where contact_id=$1', [ids[2]])).rows[0];
      const p = await previewAll(w, 3);
      const { run } = await applyAll(w, p);
      await db.query("update public.contacts set phone_1='816-555-6999', phone_1_type='mobile' where id=$1", [ids[5]]);
      const first = await rollbackAll(w, run!, 3);
      expect(first.ranges.length).toBeGreaterThan(1);
      expect(first.fin.status).toBe('applied');
      expect(first.fin.notRestored.map((x: Json) => x.contact)).toEqual([ids[5]]);
      expect((await db.query('select e164, updated_at from public.contact_phone_numbers where contact_id=$1', [ids[2]])).rows[0]).toEqual(stale);
      expect((await db.query('select e164 from public.contact_phone_numbers where contact_id=$1', [ids[5]])).rows[0].e164).toBe('+18165556999');
      expect((await db.query('select count(*)::int n from public.contact_phone_numbers where contact_id=any($1)', [[ids[0], ids[1], ids[3]]])).rows[0].n).toBe(0);

      // second run, rolled back cleanly
      const w2 = await world(db);
      const c = await newContact(w2, ['816-555-7001', '816-555-7002']);
      await asLegacy(w2);
      const { run: run2 } = await applyAll(w2, await previewAll(w2, 2));
      const clean = await rollbackAll(w2, run2!, 2);
      expect(clean.fin).toMatchObject({ status: 'rolled_back', notRestored: [] });
      expect((await db.query('select count(*)::int n from public.contact_phone_numbers where contact_id=$1', [c])).rows[0].n).toBe(0);
      expect((await call(w2, rbSql, [run2, w2.org, null, 5, null, false, null]))).toMatchObject({ noop: true });
    });
  });

  it('refuses a rollback range whose rows moved since the preview', async () => {
    await withP2('phoneBatched', async (db) => {
      const w = await world(db);
      const c = await newContact(w, ['816-555-8001']);
      await asLegacy(w);
      const { run } = await applyAll(w, await previewAll(w, 5));
      const pre = await call(w, rbSql, [run, w.org, null, 5, null, false, null]);
      await db.query("update public.contacts set phone_1='816-555-8099', phone_1_type='mobile' where id=$1", [c]);
      const err = await failure(db, () => call(w, rbSql, [run, w.org, null, null, pre.lastId, true, pre.digest]));
      expect(err.message).toContain('FINGERPRINT_MISMATCH');
    });
  });

  it('only touches the named org, and browser roles cannot call any of it', async () => {
    await withP2('phoneBatched', async (db) => {
      const a = await world(db);
      const b = await world(db);
      await asLegacy(a); await asLegacy(b);
      await applyAll(a, await previewAll(a, 2));
      expect(await count(b)).toBe(0);
      for (const sql of [
        ['select public.fn_contact_phone_numbers_backfill_range($1)', [a.org]],
        ['select public.fn_contact_phone_numbers_backfill_run_info($1,$1)', [a.org]],
        ['select public.fn_contact_phone_numbers_backfill_rollback_range($1,$1)', [a.org]],
        ['select public.fn_contact_phone_numbers_backfill_rollback_finish($1,$1,0,0,null)', [a.org]],
      ] as const) {
        for (const role of ['authenticated', 'anon']) {
          await db.query(`set local role ${role}`);
          expect((await failure(db, () => db.query(sql[0], [...sql[1]]))).code).toBe('42501');
        }
      }
    });
  });

  // Opt-in scale proof: PHONE_BACKFILL_SCALE=50000 npm run test:integration:local -- <this file>
  const scale = Number(process.env.PHONE_BACKFILL_SCALE ?? 0);
  it.skipIf(!scale)('scale: every range preview/apply/rollback call stays far inside the 8s API timeout', async () => {
    await withP2('phoneBatched', async (db: Client) => {
      const w = await world(db);
      await db.query(
        `insert into public.contacts(id,org_id,first_name,phone_1,phone_2,phone_3,phone_1_type,phone_2_type,phone_3_type)
         select extensions.gen_random_uuid(), $1, 'S', '(' || (200 + g / 10000) || ') 555-' || lpad((g % 10000)::text, 4, '0'),
                case when g % 3 = 0 then (400 + g / 10000) || '-555-' || lpad((g % 10000)::text, 4, '0') end,
                case when g % 5 = 0 then '(' || (600 + g / 10000) || ') 555-' || lpad((g % 10000)::text, 4, '0') end,
                'mobile', case when g % 3 = 0 then 'mobile' else 'unknown' end, case when g % 5 = 0 then 'mobile' else 'unknown' end
         from generate_series(1, $2) g`, [w.org, scale]);
      await asLegacy(w);
      await db.query("set local statement_timeout = '8s'"); // the API's per-call limit
      const time = async <T,>(fn: () => Promise<T>) => { const t = Date.now(); const v = await fn(); return [v, Date.now() - t] as const; };
      const size = 2000;
      const slowest = { preview: 0, apply: 0, rbPreview: 0, rbApply: 0 };
      const t0 = Date.now();
      const ranges: Range[] = [];
      let after: string | null = null, candidates = 0;
      for (;;) {
        const [r, ms] = await time(() => call(w, rangeSql, [w.org, after, size, null, false, null, null, null]));
        slowest.preview = Math.max(slowest.preview, ms);
        if (r.done) break;
        ranges.push({ after, upto: r.lastId, digest: r.digest }); candidates += r.candidates; after = r.lastId;
      }
      const previewMs = Date.now() - t0;
      const fp = createHash('sha256').update(ranges.map((x) => x.digest).join(',')).digest('hex');
      const t1 = Date.now();
      let run: string | null = null;
      for (const r of ranges) {
        const [o, ms] = await time(() => applyRange(w, r, run, fp));
        slowest.apply = Math.max(slowest.apply, ms); run = o.runId ?? run;
      }
      const applyMs = Date.now() - t1;
      expect(await count(w)).toBe(candidates);
      const t2 = Date.now();
      const rbRanges: Range[] = [];
      after = null;
      for (;;) {
        const [r, ms] = await time(() => call(w, rbSql, [run, w.org, after, size, null, false, null]));
        slowest.rbPreview = Math.max(slowest.rbPreview, ms);
        if (r.done) break;
        rbRanges.push({ after, upto: r.lastId, digest: r.digest }); after = r.lastId;
      }
      for (const r of rbRanges) {
        const [, ms] = await time(() => call(w, rbSql, [run, w.org, r.after, null, r.upto, true, r.digest]));
        slowest.rbApply = Math.max(slowest.rbApply, ms);
      }
      const rollbackMs = Date.now() - t2;
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ contacts: scale, candidates, ranges: ranges.length, previewMs, applyMs, rollbackMs, slowestCallMs: slowest }));
      expect(await count(w)).toBe(0);
      for (const ms of Object.values(slowest)) expect(ms).toBeLessThan(4000);
    });
  }, 1_800_000);
});
