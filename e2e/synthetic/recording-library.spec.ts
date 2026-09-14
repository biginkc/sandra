import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import tailwindcss from '@tailwindcss/postcss';
import * as esbuild from 'esbuild';
import path from 'node:path';
import postcss from 'postcss';
let html='';
test.beforeAll(async()=>{
 const css=(await postcss([tailwindcss()]).process(readFileSync('src/app/globals.css','utf8'),{from:path.resolve('src/app/globals.css')})).css;
 const stub=path.resolve('e2e/synthetic/fixtures/recording-library-stubs.tsx');
 const bundle=esbuild.buildSync({entryPoints:['e2e/synthetic/fixtures/recording-library-harness.tsx'],bundle:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'next/navigation':stub,'next/link':stub,'@/lib/supabase/client':stub,'@':path.resolve('src')},define:{'process.env.NODE_ENV':'"test"'},write:false}).outputFiles[0].text;
 html=`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Recordings visual preview</title><style>${css}</style></head><body style="font-family:Arial,sans-serif"><div id="root"></div><script>${bundle.replaceAll('</script','<\\/script')}</script></body></html>`;
 if(process.env.RECORDING_PREVIEW_OUTPUT)writeFileSync(process.env.RECORDING_PREVIEW_OUTPUT,html);
});
for(const width of [390,1440])test(`recording filters and files work at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.setContent(html);
 await expect(page.getByRole('heading',{name:'Recordings',exact:true})).toBeVisible();
 await page.getByText('More filters',{exact:true}).click();
 await expect(page.getByLabel('Users (select one or more)')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 await page.getByLabel('Contact, property address or phone').fill('Example');await page.getByRole('button',{name:'Apply filters'}).click();
 await expect(page.locator('#last-navigation')).toContainText('q=Example');
 await page.getByText('2 recording files',{exact:true}).click();await expect(page.getByRole('button',{name:'Play recording'})).toHaveCount(2);
 await page.getByRole('button',{name:'Switch to My Recordings'}).click();
 await expect(page.getByRole('heading',{name:'My Recordings',exact:true})).toBeVisible();
 await page.getByText('More filters',{exact:true}).click();await expect(page.getByLabel('Users (select one or more)')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});
