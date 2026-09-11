/** Native Chromium tab zoom, using a temporary headless-only extension.
 * https://playwright.dev/docs/chrome-extensions
 * Reuses the existing rep; never touches a user's browser profile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createBrowserClient } from '@supabase/ssr';
const fixtureDir='/tmp/sandra-my-leads-acceptance-20260911';
const runtime=JSON.parse(fs.readFileSync(path.join(fixtureDir,'runtime.json'),'utf8'));
assert.equal(runtime.API_URL,'http://127.0.0.1:58321');
const identity=JSON.parse(fs.readFileSync(path.join(fixtureDir,'identities.json'),'utf8')).find(x=>x.role==='rep');
assert.equal(identity.id,'10000000-0000-4000-8000-000000000003');
const temporary=fs.mkdtempSync('/tmp/my-leads-zoom-');
const extension=path.join(temporary,'extension');fs.mkdirSync(extension);
fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Local My Leads zoom verifier',version:'1.0',permissions:['tabs'],background:{service_worker:'background.js'}}));
fs.writeFileSync(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(() => {});');
const executablePath=process.env.MY_LEADS_LOCAL_CHROMIUM;
if(executablePath)assert.ok(executablePath.startsWith("/tmp/sandra-my-leads-")&&executablePath.endsWith("/Google Chrome for Testing"));
let context;
try {
  context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',...(executablePath?{executablePath}:{}),headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const jar=new Map();
  const auth=createBrowserClient(runtime.API_URL,runtime.ANON_KEY,{isSingleton:false,cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>{for(const c of cs){if(c.value)jar.set(c.name,c.value);else jar.delete(c.name);}}}});
  const {error}=await auth.auth.signInWithPassword({email:identity.email,password:identity.password});
  assert.equal(Boolean(error),false,'Local fixture authentication failed');
  await context.addCookies([...jar].map(([name,value])=>({name,value,url:'http://127.0.0.1:58700',sameSite:'Lax'})));
  const page=await context.newPage();await page.goto('http://127.0.0.1:58700/my-leads');
  await expect(page.getByRole('heading',{name:'My Leads',exact:true})).toBeVisible();
  const factor=await worker.evaluate(async()=>{const tabs=await globalThis.chrome.tabs.query({url:'http://127.0.0.1:58700/my-leads'});if(tabs.length!==1)throw Error('Expected one local app tab');await globalThis.chrome.tabs.setZoom(tabs[0].id,2);return globalThis.chrome.tabs.getZoom(tabs[0].id);});
  assert.equal(factor,2);
  await expect(page.getByRole('heading',{name:'My Leads',exact:true})).toBeVisible();
  const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:window.innerWidth}));
  assert.ok(layout.width<=layout.viewport,'Page overflows at native 200% zoom');
  const action=page.getByRole('button',{name:'Log attempt',exact:true}).first();await action.click();
  await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(fixtureDir,'my-leads-200-percent.png')});
  console.log('PASS: native Chromium tab zoom 200%, no horizontal overflow, dialog opens and cancels');
} finally {await context?.close();fs.rmSync(temporary,{recursive:true,force:true});}
