import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import type { Database } from "@/lib/supabase/types";
import { clientForUser, createOrgUser } from "./fixtures/multi-user";

// Explicit opt-in: roughly half a million synthetic rows on the integration
// project, while globalSetup holds the shared integration mutex. No providers.
export function registerDefinerPerformance(db: Client, service: SupabaseClient<Database>) {
  it.skipIf(process.env.SEARCH_D6_PERFORMANCE !== "1")("D6 representative owner EXPLAIN and real-JWT RPC p95", async () => {
    const orgs = [randomUUID(), randomUUID(), randomUUID()];
    const seed = randomUUID();
    let userId: string | undefined;
    try {
      await db.query("insert into public.organizations(id,name) select id,'D6 performance synthetic '||id from unnest($1::uuid[]) id", [orgs]);
      const user = await createOrgUser(service, { orgId: orgs[0], email: `d6-perf-${seed}@example.test`, role: "owner" });
      userId = user.userId;
      const client = clientForUser(user.jwt);
      await db.query("begin");
      try {
        await db.query("set local statement_timeout='300s'");
        // Keep generated columns and indexes active; bypass unrelated business
        // triggers only for these synthetic inserts on this session/transaction.
        await db.query("set local session_replication_role=replica");
        await db.query(`insert into public.contacts(id,org_id,first_name,last_name,email,phone_1,phone_1_type)
          select md5($1||'contact'||g)::uuid, ($2::uuid[])[case when g%100<98 then 1 when g%100=98 then 2 else 3 end],
            (array['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda'])[1+g%8],
            case when g=100 then 'Vanderplanken' else 'Smithson'||substr(md5(g::text),1,10) end,
            'person'||g||'@example.test',case when g=100 then '+18165551234' else '+1202'||lpad(g::text,7,'0') end,'unknown'
          from generate_series(1,250000) g`, [seed,orgs]);
        await db.query(`insert into public.properties(id,org_id,address,city,state,zip,homeowner_contact_id)
          select md5($1||'property'||g)::uuid, ($2::uuid[])[case when g%100<98 then 1 when g%100=98 then 2 else 3 end],
            g||' '||case when g=100 then 'Sunflower' else 'Oakwood'||substr(md5(g::text),1,8) end||' Avenue',
            'Kansas City','MO','64101',md5($1||'contact'||g)::uuid
          from generate_series(1,150000) g`, [seed,orgs]);
        await db.query(`insert into public.messages(id,org_id,contact_id,property_id,conversation_id,channel,direction,body,from_address,to_address)
          select md5($1||'message'||g)::uuid,($2::uuid[])[case when c%100<98 then 1 when c%100=98 then 2 else 3 end],
            md5($1||'contact'||c)::uuid,md5($1||'property'||c)::uuid,md5($1||'conversation'||c)::uuid,
            'sms','inbound',case when c=100 then 'Appointment confirmation for the house' else 'Please send the details about the house '||substr(md5(g::text),1,12) end,
            '+12025550001','+12025550002'
          from (select g,1+(g-1)%3000 as c from generate_series(1,60000) g) sample`, [seed,orgs]);
        await db.query("commit");
      } catch(error) { await db.query("rollback"); throw error; }
      for (const table of ["properties","contacts","messages"]) await db.query(`analyze public.${table}`);
      const cardinality = (await db.query(`select
        (select count(*) from public.properties where org_id=any($1::uuid[]))::int as properties,
        (select count(*) from public.contacts where org_id=any($1::uuid[]))::int as contacts,
        (select count(*) from public.messages where org_id=any($1::uuid[]))::int as sms,
        (select count(distinct conversation_id) from public.messages where org_id=any($1::uuid[]))::int as conversations`, [orgs])).rows[0];
      expect(cardinality).toEqual({properties:150000,contacts:250000,sms:60000,conversations:3000});
      console.log("D6_CARDINALITY", JSON.stringify(cardinality));
      const installed = (await db.query(`select pg_get_functiondef(oid) as definition,prosrc,proconfig,
        pg_get_userbyid(proowner) as owner from pg_proc where oid='public.search_global(text,integer)'::regprocedure`)).rows[0];
      expect(installed.owner).toBe("postgres");
      expect(installed.definition).toContain("SECURITY DEFINER");
      const body = installed.prosrc as string;
      const visible = body.slice(body.indexOf("with visible_orgs"),body.indexOf("), bounds as ("))+ ") select count(*)::int as n from visible_orgs";
      const measurements: { q: string; p95Ms: number }[] = [];
      for (const [q, expectedType] of [["Sunflower","property"],["Vanderplanken","owner"],["8165551234","owner"],["appoin","thread"]]) {
        // ONE explicit transaction and connection: local claims remain installed
        // through uid/visibility assertions and owner-context EXPLAIN.
        await db.query("begin");
        try {
          expect((await db.query("select current_user as owner")).rows[0].owner).toBe("postgres");
          await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:userId,role:"authenticated"})]);
          for (const config of installed.proconfig as string[]) {
            const index=config.indexOf("=");
            await db.query("select set_config($1,$2,true)",[config.slice(0,index),config.slice(index+1)]);
          }
          expect((await db.query("select auth.uid() as uid")).rows[0].uid).toBe(userId);
          expect((await db.query(visible)).rows[0].n).toBeGreaterThan(0);
          const plan=await db.query("explain (analyze,buffers,format json) "+body,[q,5]);
          console.log("D6_EXPLAIN",JSON.stringify({q,plan:plan.rows[0]["QUERY PLAN"]}));
        } finally { await db.query("rollback"); }
        const times:number[]=[];
        for(let i=0;i<23;i++) {
          const current = (await db.query("select pg_get_functiondef('public.search_global(text,integer)'::regprocedure) as definition")).rows[0].definition;
          expect(current, "another session changed search_global during the protected performance run").toBe(installed.definition);
          const start=performance.now();
          const {data,error}=await client.rpc("search_global",{q,per_type:5});
          const elapsed=performance.now()-start;
          expect(error).toBeNull();
          expect(data?.some(r=>r.entity_type===expectedType)).toBe(true);
          if(i>=3) times.push(elapsed);
        }
        times.sort((a,b)=>a-b);
        console.log("D6_P95",JSON.stringify({q,warmups:3,runs:20,p95Ms:times[18],maxMs:times[19],samples:times}));
        measurements.push({q,p95Ms:times[18]});
      }
      for (const measurement of measurements) expect(measurement.p95Ms, measurement.q).toBeLessThan(500);
    } finally {
      await db.query("begin");
      try {
        await db.query("set local statement_timeout='300s'");
        await db.query("set local session_replication_role=replica");
        for(const table of ["messages","properties","contacts","memberships"]) await db.query(`delete from public.${table} where org_id=any($1::uuid[])`,[orgs]);
        await db.query("delete from public.organizations where id=any($1::uuid[])",[orgs]);
        await db.query("commit");
      } catch(error) { await db.query("rollback"); throw error; }
      if(userId) { const {error}=await service.auth.admin.deleteUser(userId); expect(error).toBeNull(); }
      for(const table of ["messages","properties","contacts"]) {
        expect((await db.query(`select count(*)::int as n from public.${table} where org_id=any($1::uuid[])`,[orgs])).rows[0].n).toBe(0);
        await db.query(`analyze public.${table}`);
      }
      console.log("D6_PERFORMANCE_CLEANUP verified zero synthetic rows");
    }
  },900000);
}
