import { expect, test } from "@playwright/test";

function pageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>:root{font-family:Inter,ui-sans-serif,system-ui;color:#1c1917;background:#fafaf9}*{box-sizing:border-box}body{margin:0;padding-top:30px}.proof{position:fixed;inset:0 0 auto;height:30px;display:grid;place-items:center;background:#7c2d12;color:white;font:800 11px ui-monospace;letter-spacing:.07em}.shell{max-width:940px;margin:auto;padding:28px}h1,h2,p{margin-top:0}.muted{color:#78716c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:18px}.notice{border-left:4px solid #292524;background:#f5f5f4;padding:12px;margin:12px 0}.sms{border-left-color:#d97706;background:#fffbeb}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:16px 0}.stat{border:1px solid #e7e5e4;border-radius:10px;padding:11px}.stat strong{display:block;font:800 22px ui-monospace}.button{border:1px solid #1c1917;border-radius:999px;background:#1c1917;color:#fff;padding:9px 15px;font-weight:800;cursor:pointer}.button:disabled{opacity:.55}.toast{margin-top:12px;color:#166534;font-weight:700}.hidden{display:none}.status{font:800 11px ui-monospace;letter-spacing:.08em;color:#b91c1c}@media(max-width:620px){body{padding-top:48px}.proof{height:48px;padding:0 8px;text-align:center;font-size:9px;line-height:1.2}.shell{padding:16px}.grid{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}.stat:last-child{grid-column:1/-1}}</style></head><body>
  <div class="proof" role="status">SYNTHETIC — DATABASE-FREE CSV RECOVERY PROOF — NOT LIVE SANDRA</div>
  <main class="shell"><h1>Import review and recovery</h1><p class="muted">Synthetic records verify the approved safety distinctions and retry presentation.</p>
    <div class="grid"><section class="card" aria-labelledby="preflight"><h2 id="preflight">Preflight</h2>
      <div class="notice"><strong>12 permanently DNC-locked records</strong><p>They import as locked, non-actionable Prospects for compliance history.</p></div>
      <div class="notice sms"><strong>8 SMS-suppressed records</strong><p>They remain ordinary Prospects, but Sandra excludes them from SMS actions.</p></div>
    </section>
    <section class="card" aria-labelledby="progress"><div class="status" id="state">FAILED · RETRY AVAILABLE</div><h2 id="progress">The job stopped before completing</h2><p>Rows already imported are kept and listed; nothing was double-imported. Retry resumes from the failure point.</p>
      <div class="stats"><div class="stat"><strong>0</strong>Processed</div><div class="stat"><strong>0</strong>Imported</div><div class="stat"><strong>1</strong>Failed</div></div>
      <button class="button" id="retry">Retry import</button><div class="toast hidden" id="toast">Import resumed.</div>
    </section></div>
  </main><script>const retry=document.querySelector('#retry'),toast=document.querySelector('#toast'),state=document.querySelector('#state');retry.addEventListener('click',()=>{retry.disabled=true;retry.textContent='Starting retry…';setTimeout(()=>{retry.textContent='Retry started';toast.classList.remove('hidden');state.textContent='QUEUED · RESUMING FROM CHECKPOINT'},60)});</script></body></html>`;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const) {
  test(`synthetic database-free CSV recovery contract at ${viewport.name} width`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.setViewportSize(viewport);
    await page.setContent(pageHtml(), { waitUntil: "domcontentloaded" });
    await expect(page.getByText("SYNTHETIC — DATABASE-FREE CSV RECOVERY PROOF — NOT LIVE SANDRA")).toBeVisible();
    await expect(page.getByText("12 permanently DNC-locked records")).toBeVisible();
    await expect(page.getByText("8 SMS-suppressed records")).toBeVisible();
    await expect(page.getByText(/remain ordinary Prospects/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`synthetic-contract-csv-failed-${viewport.name}.png`), fullPage: true });

    await page.getByRole("button", { name: "Retry import" }).click();
    await expect(page.getByText("Import resumed.")).toBeVisible();
    await expect(page.getByText("QUEUED · RESUMING FROM CHECKPOINT")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`synthetic-contract-csv-retrying-${viewport.name}.png`), fullPage: true });

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
