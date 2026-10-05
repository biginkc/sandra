import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { as, failure, service, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

const rows = async (db: Client, contact: string): Promise<Json[]> =>
  (await db.query('select slot, e164, digits10, org_id, updated_at from public.contact_phone_numbers where contact_id=$1 order by slot', [contact])).rows;
const newContact = async (w: World, phones: (string | null)[]): Promise<string> => {
  const id = randomUUID();
  const t = (v: string | null | undefined) => (v ? 'mobile' : 'unknown');
  await w.db.query(
    'insert into public.contacts(id,org_id,first_name,phone_1,phone_2,phone_3,phone_1_type,phone_2_type,phone_3_type) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, w.org, 'T', phones[0] ?? null, phones[1] ?? null, phones[2] ?? null, t(phones[0]), t(phones[1]), t(phones[2])]);
  return id;
};
const backfill = async (w: World, apply: boolean, fp: string | null = null): Promise<Json> =>
  (await service(w.db, () => w.db.query('select public.fn_contact_phone_numbers_backfill($1,$2,$3) as v', [w.org, apply, fp]))).rows[0].v;
const rollback = async (w: World, run: string): Promise<Json> => {
  const fp = (await w.db.query('select public.my_leads_housekeeping_rollback_fingerprint($1,$2) as f', [run, w.org])).rows[0].f;
  return (await service(w.db, () => w.db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as v', [run, w.org, fp]))).rows[0].v;
};
// The state of contacts that existed before this migration: phones set, no lookup rows.
const asLegacy = (w: World) => w.db.query('delete from public.contact_phone_numbers where org_id=$1', [w.org]);

describe('20261006100200 contact_phone_numbers', () => {
  it('maintains rows from the three phone columns', async () => {
    await withP2('phoneNumbers', async (db) => {
      const w = await world(db);
      const c = await newContact(w, ['(816) 555-0642', '816-555-0199', '+1 913 555 0100']);
      expect((await rows(db, c)).map((r) => [r.slot, r.e164, r.digits10])).toEqual([
        [1, '+18165550642', '8165550642'], [2, '+18165550199', '8165550199'], [3, '+19135550100', '9135550100']]);
      const before = await rows(db, c);
      await db.query("update public.contacts set phone_2='(816) 555-0188', phone_2_type='mobile' where id=$1", [c]);
      const after = await rows(db, c);
      expect(after[0]).toEqual(before[0]);
      expect(after[2]).toEqual(before[2]);
      expect(after[1].e164).toBe('+18165550188');
      await db.query('update public.contacts set phone_3=null where id=$1', [c]);
      expect((await rows(db, c)).map((r) => r.slot)).toEqual([1, 2]);
      expect(after.every((r) => r.org_id === w.org)).toBe(true);
    });
  });

  it('a no-op update writes nothing', async () => {
    await withP2('phoneNumbers', async (db) => {
      const w = await world(db);
      const c = await newContact(w, ['816-555-0942']);
      const before = await rows(db, c);
      await db.query("update public.contacts set phone_1='816-555-0942', phone_1_type='mobile', first_name='Changed' where id=$1", [c]);
      await db.query("update public.contacts set phone_1='(816) 555-0942', phone_1_type='mobile' where id=$1", [c]); // different text, same number
      expect(await rows(db, c)).toEqual(before);
    });
  });

  it('normalizes formats the way dial authorization does and drops unusable numbers', async () => {
    await withP2('phoneNumbers', async (db) => {
      const w = await world(db);
      for (const raw of ['(816) 555-0142', '816-555-0142', '+1 816 555 0142', '18165550142']) {
        const c = await newContact(w, [null, raw]);
        expect((await rows(db, c))[0]).toMatchObject({ slot: 2, digits10: '8165550142' });
      }
      for (const raw of ['816555014', '+44 20 7946 0958', '816-555-0142 x2', 'call me']) {
        const c = await newContact(w, [null, raw]);
        expect(await rows(db, c)).toEqual([]);
      }
    });
  });

  it('two contacts sharing a number both appear; delete cascades; browser roles cannot read', async () => {
    await withP2('phoneNumbers', async (db) => {
      const w = await world(db);
      const a = await newContact(w, [null, '816-555-0777']);
      const b = await newContact(w, [null, '816-555-0777']);
      const n = (await db.query("select count(*)::int n from public.contact_phone_numbers where org_id=$1 and digits10='8165550777'", [w.org])).rows[0].n;
      expect(n).toBe(2);
      await db.query('delete from public.contacts where id=$1', [a]);
      expect(await rows(db, a)).toEqual([]);
      expect(await rows(db, b)).toHaveLength(1);
      await db.query('set local role authenticated');
      expect((await failure(db, () => db.query('select * from public.contact_phone_numbers'))).code).toBe('42501');
      await db.query('reset role');
      await db.query('set local role anon');
      expect((await failure(db, () => db.query('select * from public.contact_phone_numbers'))).code).toBe('42501');
      await db.query('reset role');
      await service(db, () => db.query('select count(*) from public.contact_phone_numbers'));
    });
  });

  describe('backfill run kind phone_backfill', () => {
    it('preview writes nothing and reports the created/updated split; apply fills, images, and is idempotent', async () => {
      await withP2('phoneNumbers', async (db) => {
        const w = await world(db);
        const c1 = await newContact(w, ['816-555-0301', '816-555-0302']);
        const c2 = await newContact(w, ['816-555-0303']);
        await asLegacy(w);
        // one stale row that the backfill must correct (an `updated` image)
        await db.query("insert into public.contact_phone_numbers(contact_id,slot,org_id,e164) values ($1,1,$2,'+18165559999')", [c2, w.org]);
        const preview = await backfill(w, false);
        expect(preview).toMatchObject({ kind: 'phone_backfill', toUpdate: 1 });
        expect(preview.toCreate).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(preview)).not.toContain('8165550301');
        expect((await db.query("select count(*)::int n from public.contact_phone_numbers where contact_id=$1", [c1])).rows[0].n).toBe(0);
        expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_runs where org_id=$1', [w.org])).rows[0].n).toBe(0);

        const done = await backfill(w, true, preview.fingerprint);
        expect(done).toMatchObject({ created: preview.toCreate, updated: 1 });
        expect((await rows(db, c1)).map((r) => r.e164)).toEqual(['+18165550301', '+18165550302']);
        expect((await rows(db, c2))[0].e164).toBe('+18165550303');
        const imgs = (await db.query("select before from public.my_leads_housekeeping_before_images where run_id=$1 and table_name='contact_phone_numbers'", [done.runId])).rows;
        expect(imgs).toHaveLength(preview.candidates);
        expect(imgs.filter((r) => r.before.op === 'updated')).toHaveLength(1);
        const second = await backfill(w, false);
        expect(second.candidates).toBe(0);
        expect(await backfill(w, true, second.fingerprint)).toMatchObject({ noop: true });
      });
    });

    it('refuses a stale fingerprint and writes nothing', async () => {
      await withP2('phoneNumbers', async (db) => {
        const w = await world(db);
        await newContact(w, ['816-555-0401']);
        await asLegacy(w);
        const preview = await backfill(w, false);
        await newContact(w, ['816-555-0402']);
        await asLegacy(w);
        const err = await failure(db, () => backfill(w, true, preview.fingerprint));
        expect(err.message).toContain('FINGERPRINT_MISMATCH');
        expect((await db.query('select count(*)::int n from public.contact_phone_numbers where org_id=$1', [w.org])).rows[0].n).toBe(0);
        expect((await failure(db, () => backfill(w, true, null))).message).toContain('FINGERPRINT_REQUIRED');
        await db.query('set local role authenticated');
        expect((await failure(db, () => db.query('select public.fn_contact_phone_numbers_backfill($1,false,null)', [w.org]))).code).toBe('42501');
        await db.query('reset role');
      });
    });

    it('only touches the named org', async () => {
      await withP2('phoneNumbers', async (db) => {
        const a = await world(db);
        const b = await world(db);
        await asLegacy(a); await asLegacy(b);
        const p = await backfill(a, false);
        await backfill(a, true, p.fingerprint);
        expect((await db.query('select count(*)::int n from public.contact_phone_numbers where org_id=$1', [b.org])).rows[0].n).toBe(0);
      });
    });

    it('rollback removes created rows, restores updated rows, and keeps a row a user edit rewrote', async () => {
      await withP2('phoneNumbers', async (db) => {
        const w = await world(db);
        const c1 = await newContact(w, ['816-555-0501']);
        const c2 = await newContact(w, ['816-555-0502']);
        const c3 = await newContact(w, ['816-555-0503']);
        await asLegacy(w);
        await db.query("insert into public.contact_phone_numbers(contact_id,slot,org_id,e164) values ($1,1,$2,'+18165550000')", [c2, w.org]);
        const stale = (await rows(db, c2))[0];
        const p = await backfill(w, false);
        const run = (await backfill(w, true, p.fingerprint)).runId;
        // a user edits c3's phone after the run: the maintaining trigger rewrites that row
        await db.query("update public.contacts set phone_1='816-555-0599', phone_1_type='mobile' where id=$1", [c3]);
        const out = await rollback(w, run);
        expect(out.status).toBe('applied'); // something was not restored
        expect(out.notRestored.map((x: Json) => x.contact)).toEqual([c3]);
        expect(await rows(db, c1)).toEqual([]);
        const back = (await rows(db, c2))[0];
        expect(back.e164).toBe('+18165550000');
        expect(back.updated_at).toEqual(stale.updated_at);
        expect((await rows(db, c3))[0].e164).toBe('+18165550599');
      });
    });

    it('a clean rollback marks the run rolled back; a second rollback is a no-op', async () => {
      await withP2('phoneNumbers', async (db) => {
        const w = await world(db);
        const c = await newContact(w, ['816-555-0601']);
        await asLegacy(w);
        const p = await backfill(w, false);
        const run = (await backfill(w, true, p.fingerprint)).runId;
        const out = await rollback(w, run);
        expect(out).toMatchObject({ status: 'rolled_back', notRestored: [] });
        expect(await rows(db, c)).toEqual([]);
        expect((await service(db, () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,null) as v', [run, w.org]))).rows[0].v).toMatchObject({ noop: true });
      });
    });
  });
});
void as;
