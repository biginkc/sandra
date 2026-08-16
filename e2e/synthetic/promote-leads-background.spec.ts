import { expect, test } from "@playwright/test";

function pageHtml(): string {
  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui;color:#1c1917;background:#fafaf9}*{box-sizing:border-box}body{margin:0;padding-top:30px}.banner{position:fixed;inset:0 0 auto;height:30px;display:grid;place-items:center;background:#7c2d12;color:#fff;font:800 11px ui-monospace;letter-spacing:.08em}.shell{max-width:1050px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}h1{margin:0}button,a{border:1px solid #d6d3d1;border-radius:999px;background:#fff;color:#1c1917;padding:9px 15px;font-weight:700;text-decoration:none;cursor:pointer}button.primary{background:#1c1917;color:#fff}button:disabled{opacity:.45}.toolbar{display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px}.menu{position:absolute;right:28px;background:#fff;border:1px solid #d6d3d1;border-radius:10px;padding:6px;box-shadow:0 8px 30px #0002}.menu button{border:0;border-radius:7px;width:100%}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e7e5e4}th,td{text-align:left;padding:14px;border-bottom:1px solid #eee}.muted{color:#78716c}.modal-wrap{position:fixed;inset:0;background:#0007;display:grid;place-items:center;padding:18px}.modal{width:min(520px,100%);background:#fff;border-radius:16px;padding:22px;box-shadow:0 24px 80px #0005}.counts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}.count,.result{border:1px solid #e7e5e4;border-radius:10px;padding:13px}.count strong,.result strong{display:block;font:800 22px ui-monospace}.safe{background:#f5f5f4;padding:10px;border-radius:8px;font-size:13px}.footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.results{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.hidden{display:none!important}@media(max-width:520px){.shell{padding:16px}header{align-items:flex-start;gap:12px;flex-direction:column}.counts,.results{grid-template-columns:1fr 1fr}th,td{padding:10px;font-size:13px}.result:last-child{grid-column:1/-1}}
  </style></head><body>
  <div class="banner" role="status">SYNTHETIC DATA — DATABASE-FREE PROMOTION PROOF — NOT LIVE SANDRA</div>
  <main class="shell" id="prospects"><header><div><h1>Prospects</h1><p class="muted">Choose records, then confirm before they move to Leads.</p></div></header>
    <div class="toolbar"><button id="actions" disabled aria-haspopup="menu">Actions</button></div>
    <div id="menu" class="menu hidden" role="menu"><button role="menuitem" id="promote">Promote to Lead</button></div>
    <table><thead><tr><th>Select</th><th>Property</th><th>Current state</th></tr></thead><tbody>
      <tr><td><input type="checkbox" aria-label="Select 101 Synthetic Main St"></td><td>101 Synthetic Main St</td><td>Prospect</td></tr>
      <tr><td><input type="checkbox" aria-label="Select 202 Synthetic Oak Ave"></td><td>202 Synthetic Oak Ave</td><td>Prospect</td></tr>
      <tr><td><input type="checkbox" aria-label="Select 303 Synthetic Pine Rd"></td><td>303 Synthetic Pine Rd</td><td>Prospect</td></tr>
    </tbody></table>
  </main>
  <section id="dialog" class="modal-wrap hidden" role="dialog" aria-labelledby="dialog-title"><div class="modal">
    <h2 id="dialog-title">Promote selected Prospects to Leads?</h2><p class="muted">This runs in the background. You can leave this page and follow exact results in Jobs.</p>
    <div class="counts" aria-label="Promotion eligibility"><div class="count"><strong>3</strong> selected</div><div class="count"><strong>1</strong> eligible</div><div class="count"><strong>1</strong> permanently DNC locked</div><div class="count"><strong>1</strong> stale or already a Lead</div></div>
    <p class="safe">Permanently DNC-locked records stay in Prospects. Every item is checked again immediately before it moves.</p>
    <div id="started" class="hidden"><strong>Promotion started in the background.</strong><br><a href="#results" id="view-progress">View progress</a></div>
    <div class="footer"><button id="cancel">Cancel</button><button id="confirm" class="primary">Promote 1 to Leads</button></div>
  </div></section>
  <main class="shell hidden" id="results"><header><div><h1>Promotion results</h1><p class="muted">Completed · 3/3 processed</p></div></header>
    <p class="safe">Permanently DNC-locked records stay in Prospects and count as safe skips, not failures.</p>
    <div class="results"><div class="result"><strong>1</strong>Promoted</div><div class="result"><strong>1</strong>Already Leads</div><div class="result"><strong>1</strong>Became permanently DNC</div><div class="result"><strong>0</strong>Stale or missing</div><div class="result"><strong>0</strong>Failed</div></div>
  </main>
  <script>
    const checks=[...document.querySelectorAll('input[type=checkbox]')],actions=document.querySelector('#actions'),menu=document.querySelector('#menu'),dialog=document.querySelector('#dialog');
    checks.forEach(box=>box.addEventListener('change',()=>{actions.disabled=!checks.some(item=>item.checked)}));
    actions.addEventListener('click',()=>menu.classList.toggle('hidden'));
    document.querySelector('#promote').addEventListener('click',()=>{menu.classList.add('hidden');dialog.classList.remove('hidden')});
    document.querySelector('#cancel').addEventListener('click',()=>dialog.classList.add('hidden'));
    document.querySelector('#confirm').addEventListener('click',event=>{event.currentTarget.classList.add('hidden');document.querySelector('#started').classList.remove('hidden')});
    document.querySelector('#view-progress').addEventListener('click',event=>{event.preventDefault();dialog.classList.add('hidden');document.querySelector('#prospects').classList.add('hidden');document.querySelector('#results').classList.remove('hidden')});
  </script></body></html>`;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const) {
  test(`promotion confirmation and truthful results at ${viewport.name} width`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize(viewport);
    await page.setContent(pageHtml(), { waitUntil: "domcontentloaded" });

    await expect(page.getByText(/SYNTHETIC DATA/)).toBeVisible();
    for (const address of [
      "101 Synthetic Main St",
      "202 Synthetic Oak Ave",
      "303 Synthetic Pine Rd",
    ]) {
      await page.getByRole("checkbox", { name: `Select ${address}` }).check();
    }
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Promote to Lead" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Promote selected Prospects to Leads?" })).toBeVisible();
    await expect(dialog.getByLabel("Promotion eligibility")).toContainText("1 permanently DNC locked");
    await expect(dialog.getByText(/stay in Prospects/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`promote-confirm-${viewport.name}.png`), fullPage: true });

    await dialog.getByRole("button", { name: "Promote 1 to Leads" }).click();
    await expect(dialog.getByText("Promotion started in the background.")).toBeVisible();
    await dialog.getByRole("link", { name: "View progress" }).click();
    await expect(page.getByRole("heading", { name: "Promotion results" })).toBeVisible();
    await expect(page.getByText("Became permanently DNC").locator("..")).toContainText("1");
    await expect(page.getByText("Failed").locator("..")).toContainText("0");
    await page.screenshot({ path: testInfo.outputPath(`promote-results-${viewport.name}.png`), fullPage: true });

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
