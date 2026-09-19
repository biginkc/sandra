import {readFileSync} from 'node:fs';
import path from 'node:path';
import {test,expect,type Page} from '@playwright/test';
import * as esbuild from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import fixtures from '../../src/lib/calculators/worksheet-fixtures.json';
import type {CalculatorInputs} from '../../src/lib/calculators/types';
let js='',css='';
test.beforeAll(async()=>{
  const build=await esbuild.build({entryPoints:['e2e/synthetic/fixtures/calculator-harness.tsx'],bundle:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':path.resolve('src')},define:{'process.env.NODE_ENV':'"test"','process.env.__NEXT_ROUTER_BASEPATH':'""'},write:false,outdir:'/tmp/closr-synthetic'});
  js=build.outputFiles.find(f=>f.path.endsWith('.js'))!.text;
  css=(await postcss([tailwindcss()]).process(readFileSync('src/app/globals.css','utf8'),{from:path.resolve('src/app/globals.css')})).css+'\n'+build.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
});
test.beforeEach(async({page})=>{await page.route("http://localhost/closr-test", route=>route.fulfill({contentType:"text/html",body:`<style>${css}</style><div id="root"></div>`}));await page.goto("http://localhost/closr-test");await page.addScriptTag({content:js});});
const labels={asIs:'As-is market value',profit:'Desired profit',flatFee:'Flat-fee listing',attorney:'Attorney',titleInsurance:'Title insurance',efile:'E-file',recording:'Recording',taxStamps:'Tax / stamps',pictures:'Pictures',other:'Other expenses',repairs:'Buyer-requested repairs',arv:'ARV (after-repair value)',rehab:'Investor rehab'};
async function enter(page:Page,input:CalculatorInputs){
  for(const [key,label] of Object.entries(labels)) await page.getByRole('textbox',{name:label,exact:true}).fill(input[key as keyof typeof input]===null?'':String(input[key as keyof typeof input]));
  await page.getByRole('button',{name:'Unlock listing percentage',exact:true}).click();
  await page.getByRole('textbox',{name:'Listing percentage',exact:true}).fill(input.listingPercentage===null?'':String(input.listingPercentage*100));
  await page.getByRole('button',{name:'Lock listing percentage',exact:true}).click();
}
const cellResults={B5:'commission',B26:'listing',B17:'equity',B19:'family',B21:'secure',B23:'rapid',E21:'fee40000',E22:'fee30000',E23:'fee20000',E24:'fee10000',E26:'investor'} as const;
const dollars=(v:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v);
for(const fixture of fixtures) test(`actual UI matches all 11 worksheet outputs: ${fixture.name}`,async({page})=>{
  await enter(page,fixture.inputs);
  for(const [cell,id] of Object.entries(cellResults)) await expect(page.getByTestId(`result-${id}`)).toHaveText(dollars(fixture.worksheet[cell as keyof typeof fixture.worksheet]));
});
test('attach, lost-response retry, reopen, immutable revision and detach',async({page})=>{
  await expect(page.getByRole('button',{name:'Save to lead',exact:true})).toBeDisabled();
  await enter(page,fixtures[0].inputs);
  await page.getByRole('button',{name:'Attach a lead',exact:true}).click();
  await page.getByRole('textbox',{name:'Search leads by address or name'}).fill('Test Seller');
  await page.getByRole('button',{name:/123 Test Lane/}).click();
  await page.getByRole('textbox',{name:'Proposed offer',exact:true}).fill('180000');
  await page.evaluate(()=> (window as any).calculatorHarness.loseNextResponse());
  await page.getByRole('button',{name:'Save to lead',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('entries are still here');
  await page.getByRole('button',{name:'Retry save',exact:true}).click();
  await expect(page.getByText(/Saved revision v1/)).toBeVisible();
  expect(await page.evaluate(()=>{const h=(window as any).calculatorHarness;return [h.store.length,h.requests[0].requestId===h.requests[1].requestId];})).toEqual([1,true]);
  await page.getByRole('textbox',{name:'Buyer-requested repairs',exact:true}).fill('1000');
  await page.getByRole('button',{name:'Save to lead',exact:true}).click();
  await expect(page.getByText(/Saved revision v2/)).toBeVisible();
  await page.evaluate(()=> (window as any).calculatorHarness.reopen(0));
  await expect(page.getByTestId('result-equity')).toHaveText('$196,595.00');
  await expect(page.getByRole('textbox',{name:'Buyer-requested repairs',exact:true})).toHaveValue('0');
  await page.getByRole('button',{name:'Detach lead',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save to lead',exact:true})).toBeDisabled();
});
test('mobile worksheet functions remain reachable and guide opens',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Guide',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Calculator guide'})).toBeVisible();
  await page.getByRole('button',{name:'Close Guide',exact:true}).last().click();
  await enter(page,fixtures[1].inputs);
  await expect(page.getByTestId('result-equity')).toHaveText('$241,310.00');
  await page.screenshot({path:'test-results/calculator-mobile.png',fullPage:true});
});
test('sequential typing preserves decimals, negative offers and unlocked percentage',async({page})=>{
  const value=page.getByRole('textbox',{name:'As-is market value',exact:true});
  await value.fill('');await value.pressSequentially('123.45');await expect(value).toHaveValue('123.45');
  await page.getByRole('button',{name:'Unlock listing percentage',exact:true}).click();
  const percentage=page.getByRole('textbox',{name:'Listing percentage',exact:true});
  await percentage.fill('');await percentage.pressSequentially('93.75');await expect(percentage).toHaveValue('93.75');
  await page.getByRole('button',{name:'Lock listing percentage',exact:true}).click();
  await expect(page.getByTestId('result-listing')).toHaveText('$115.73');
  const offer=page.getByRole('textbox',{name:'Proposed offer',exact:true});
  await offer.pressSequentially('-100.25');await expect(offer).toHaveValue('-100.25');
});
test('user-specified 350k ARV example matches displayed worksheet amounts',async({page})=>{
  await enter(page,{...fixtures[0].inputs,arv:350000,rehab:50000});
  const expected={arv70:'$245,000.00',investor:'$195,000.00',fee40000:'$155,000.00',fee30000:'$165,000.00',fee20000:'$175,000.00',fee10000:'$185,000.00',expenses:'$2,705.00'};
  for(const [id,value] of Object.entries(expected))await expect(page.getByTestId(`result-${id}`)).toHaveText(value);
});
test('reopened precise percentage survives untouched save and lost-response retry',async({page})=>{
  await page.evaluate(()=> (window as any).calculatorHarness.mount(null,true));
  await page.getByRole('button',{name:'Unlock listing percentage',exact:true}).click();
  await page.getByRole('textbox',{name:'Listing percentage',exact:true}).fill('29.123456789');
  await page.getByRole('button',{name:'Lock listing percentage',exact:true}).click();
  await page.getByRole('button',{name:'Save to lead',exact:true}).click();
  await expect(page.getByText(/Saved revision v1/)).toBeVisible();
  await page.evaluate(()=> (window as any).calculatorHarness.reopen(0));
  await page.getByRole('button',{name:'Unlock listing percentage',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Listing percentage',exact:true})).toHaveValue('29.123456789');
  await page.getByRole('textbox',{name:'Listing percentage',exact:true}).focus();
  await page.getByRole('button',{name:'Lock listing percentage',exact:true}).click();
  await page.evaluate(()=> (window as any).calculatorHarness.loseNextResponse());
  await page.getByRole('button',{name:'Save to lead',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('entries are still here');
  await page.getByRole('button',{name:'Retry save',exact:true}).click();
  await expect(page.getByText(/Saved revision v2/)).toBeVisible();
  const result=await page.evaluate(()=>{const h=(window as any).calculatorHarness;return {count:h.store.length,factors:h.requests.map((r:any)=>r.inputs.listingPercentage),sameRetry:h.requests[1].requestId===h.requests[2].requestId};});
  expect(result).toEqual({count:2,factors:[.29123456789,.29123456789,.29123456789],sameRetry:true});
});
