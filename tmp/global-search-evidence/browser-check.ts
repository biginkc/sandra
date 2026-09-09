import {randomUUID} from 'node:crypto';
import {chromium, expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {createBrowserClient} from '@supabase/ssr';
import {Client} from 'pg';
import setup from '../../tests/integration/global-setup';
import {loadTestEnv} from '../../tests/integration/env';
const base=process.env.SEARCH_BROWSER_BASE ?? 'http://localhost:3459';
async function main(){
 const env=loadTestEnv(); if(!env.TEST_SUPABASE_URL.includes('ncsngxlcyxylaeskiteu')) throw Error('Wrong target');
 const release=await setup(); const db=new Client({connectionString:env.TEST_SUPABASE_DB_URL});
 const admin=createClient(env.TEST_SUPABASE_URL,env.TEST_SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const id=randomUUID(),contact=randomUUID(),property=randomUUID(),conversation=randomUUID(),holdingOrg=randomUUID(); const org='00000000-0000-0000-0000-000000000bbb'; let user='';
 try {
 await db.connect();
 const seededOrg=await admin.from('organizations').insert({id:holdingOrg,name:'Global search browser roster holding canary'});if(seededOrg.error)throw seededOrg.error;
 // Middleware requires the fixed Sandra org. Temporarily move its old fixture
 // memberships, preserving every row and keeping its permanent owners in place.
 await db.query('begin');
 try {
 await db.query('set local session_replication_role = replica');
 const moved=await db.query("update memberships set org_id=$1 where org_id=$2 and role <> 'owner' returning id",[holdingOrg,org]);
 await db.query('commit');console.log('ROSTER_TEMPORARILY_MOVED',moved.rowCount,holdingOrg);
 } catch(error) {await db.query('rollback');throw error;}
 const password=randomUUID(),email=`search-${id}@bmhgroupkc.com`;
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true}); if(created.error) throw created.error;user=created.data.user.id;
 const membership=await admin.from('memberships').insert({user_id:user,org_id:org,role:'member'}); if(membership.error) throw membership.error;
 for(const [table,values] of [
 ['contacts',{id:contact,org_id:org,first_name:'Search',last_name:'Zephyrbrowser',phone_1:'(816) 555-9876',phone_1_type:'mobile'}],
 ['properties',{id:property,org_id:org,address:'981 Sunflowerbrowser Avenue',city:'Dayton',state:'OH',zip:'45402',status:'new_lead',homeowner_contact_id:contact}],
 ['messages',{org_id:org,contact_id:contact,property_id:property,conversation_id:conversation,channel:'sms',direction:'inbound',body:'Browserappointment tomorrow please confirm',from_address:'+18165559876',to_address:'+18165559999'}],
 ] as const){const r=await admin.from(table).insert(values);if(r.error)throw r.error;}
 const jar=new Map<string,string>();
 const auth=createBrowserClient(env.TEST_SUPABASE_URL,env.TEST_SUPABASE_ANON_KEY,{isSingleton:false,cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:c=>{for(const x of c)jar.set(x.name,x.value)}}});
 const signed=await auth.auth.signInWithPassword({email,password});if(signed.error)throw signed.error;
 const context=await browser.newContext();await context.addCookies([...jar].map(([name,value])=>({name,value,url:base})));
 const page=await context.newPage();await page.goto(base+'/dashboard');await expect(page.getByRole('button',{name:'Search',exact:true})).toBeVisible({timeout:60000});
 for(const [q,title,destination] of [
 ['Sunflowerbrowser','981 Sunflowerbrowser Avenue',`/leads/${property}`],
 ['Zephyrbrowser','Search Zephyrbrowser',`/leads/${property}`],
 ['8165559876','Search Zephyrbrowser',`/leads/${property}`],
 ['(816) 555-9876','Search Zephyrbrowser',`/leads/${property}`],
 ['816-555-9876','Search Zephyrbrowser',`/leads/${property}`],
 ['Browserappoin','Search Zephyrbrowser',`/messages?thread=${conversation}`],
 ]){
 await page.keyboard.press('Meta+k');await page.getByPlaceholder('Search properties, owners, messages…').fill(q);await expect(page.getByRole('option').filter({hasText:title}).first()).toBeVisible();
 await page.getByRole('option').filter({hasText:title}).first().click();await expect(page).toHaveURL(base+destination,{timeout:30000});await expect(page.getByPlaceholder('Search properties, owners, messages…')).toHaveCount(0);
 if(destination.startsWith('/leads/')) await expect(page.getByText('981 Sunflowerbrowser Avenue',{exact:true}).first()).toBeVisible({timeout:30000});
 else {
 await expect(page.getByTestId('inbox-detail-panel').getByRole('heading',{name:'Search Zephyrbrowser',exact:true})).toBeVisible({timeout:30000});
 await expect(page.getByTestId('inbox-detail-panel').getByText('Browserappointment tomorrow please confirm',{exact:true})).toBeVisible();
 }
 await page.screenshot({path:`tmp/global-search-evidence/browser-${q.replace(/\W/g,'_')}.png`});
 console.log('BROWSER_CONTENT_PASS',q,destination);
 }
 // Delay real old responses, then allow newer results through first.
 await page.route('**/api/search?**',async route=>{const response=await route.fetch();if(route.request().url().includes('Sunflowerbrowser')) await new Promise(r=>setTimeout(r,1200));await route.fulfill({response}).catch(()=>{});});
 await page.keyboard.press('Meta+k');await page.getByPlaceholder('Search properties, owners, messages…').fill('Sunflowerbrowser');await page.waitForTimeout(300);await page.getByPlaceholder('Search properties, owners, messages…').fill('Zephyrbrowser');await expect(page.getByRole('option').filter({hasText:'Search Zephyrbrowser'})).toBeVisible();await page.waitForTimeout(1500);await expect(page.getByRole('option').filter({hasText:'981 Sunflowerbrowser Avenue'})).toHaveCount(0);console.log('BROWSER_STALE_PASS');await page.unroute('**/api/search?**');
 await page.keyboard.press('Escape');
 // Expire the real GoTrue session on the server, then force its cookie's refresh path.
 await db.query("update auth.sessions set not_after=now()-interval '1 minute' where user_id=$1",[user]);
 const session={...signed.data.session,expires_at:1};
 const name=`sb-ncsngxlcyxylaeskiteu-auth-token`;const value='base64-'+Buffer.from(JSON.stringify(session)).toString('base64url');
 await context.clearCookies();await context.addCookies([{name,value,url:base}]);
 await page.keyboard.press('Meta+k');
 const result=page.waitForResponse(r=>r.url().includes('/api/search?'));
 await page.getByPlaceholder('Search properties, owners, messages…').fill('Sunflowerbrowser');const redirected=await result;
 await expect(page.getByRole('alert')).toHaveText('Search unavailable');console.log('EXPIRED_SESSION_PASS',redirected.status());await page.screenshot({path:'tmp/global-search-evidence/expired-session.png'});
 }finally{
 await browser.close();
 try {
 for(const [table,column,value] of [['messages','conversation_id',conversation],['properties','id',property],['contacts','id',contact]] as const){
 const result=await admin.from(table).delete().eq(column,value);if(result.error)throw result.error;
 }
 if(user){const removed=await admin.auth.admin.deleteUser(user);if(removed.error)throw removed.error;}
 } finally {
 try {
 await db.query('begin');
 try {
 await db.query('set local session_replication_role = replica');
 const restored=await db.query('update memberships set org_id=$1 where org_id=$2 returning id',[org,holdingOrg]);
 await db.query('commit');console.log('ROSTER_RESTORED',restored.rowCount);
 } catch(error) {await db.query('rollback');throw error;}
 const removedOrg=await admin.from('organizations').delete().eq('id',holdingOrg);if(removedOrg.error)throw removedOrg.error;
 console.log('BROWSER_CANARY_CLEANUP_PASS');
 } finally {await db.end();await release();}
 }
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
