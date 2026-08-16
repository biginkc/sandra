import { expect, test, type Page } from "@playwright/test";

type ProofRecord = {
  id: string;
  address: string;
  city: string;
  state: string;
  status: string;
  isDncLocked: boolean;
  restriction?: "SMS opted out" | "Wrong number";
};

const records: ProofRecord[] = [
  {
    id: "advanced-dnc",
    address: "404 Locked History Ave",
    city: "Kansas City",
    state: "MO",
    status: "under_contract",
    isDncLocked: true,
  },
  {
    id: "sms-only",
    address: "212 SMS Opt Out St",
    city: "Independence",
    state: "MO",
    status: "prospect",
    isDncLocked: false,
    restriction: "SMS opted out",
  },
  {
    id: "wrong-number",
    address: "816 Wrong Number Rd",
    city: "Raytown",
    state: "MO",
    status: "prospect",
    isDncLocked: false,
    restriction: "Wrong number",
  },
  {
    id: "ordinary-lead",
    address: "101 Active Seller Blvd",
    city: "Kansas City",
    state: "MO",
    status: "interested",
    isDncLocked: false,
  },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prospectRow(record: ProofRecord): string {
  const selection = record.isDncLocked
    ? `<span class="lock" role="img" aria-label="${escapeHtml(record.address)} is locked Do Not Contact">🔒</span>`
    : `<input type="checkbox" aria-label="Select ${escapeHtml(record.address)}" />`;
  const state = record.isDncLocked
    ? `<span class="dnc">⊘ DO NOT CONTACT</span>`
    : record.restriction
      ? `<span class="restriction">${escapeHtml(record.restriction)}</span>`
      : `<span class="status">${escapeHtml(record.status)}</span>`;
  return `<tr data-record="${record.id}"><td>${selection}</td><td><strong>${escapeHtml(record.address)}</strong><small>${escapeHtml(record.city)}, ${record.state}</small></td><td>${state}</td></tr>`;
}

function pageHtml(): string {
  const leads = records.filter(
    (record) => record.status !== "prospect" && !record.isDncLocked,
  );
  const prospects = records.filter(
    (record) => record.status === "prospect" || record.isDncLocked,
  );
  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui;color:#1c1917;background:#fafaf9}
    *{box-sizing:border-box} body{margin:0;padding-top:28px}.synthetic-banner{position:fixed;inset:0 0 auto;z-index:20;height:28px;display:flex;align-items:center;justify-content:center;background:#7c2d12;color:white;font:800 11px ui-monospace;letter-spacing:.09em} header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid #e7e5e4;background:white;position:sticky;top:28px}
    nav{display:flex;gap:6px}button{border:1px solid #d6d3d1;border-radius:7px;background:white;padding:8px 12px;font-weight:650;cursor:pointer}button[aria-pressed="true"]{background:#1c1917;color:white}
    main{padding:24px;max-width:1100px;margin:auto}.view[hidden]{display:none}.lede{color:#78716c;margin-top:-6px}table{width:100%;border-collapse:separate;border-spacing:0;background:white;border:1px solid #e7e5e4;border-radius:10px;overflow:hidden}th,td{padding:13px;text-align:left;border-bottom:1px solid #eee}tr:last-child td{border-bottom:0}td:first-child{width:52px}small{display:block;color:#78716c;margin-top:3px}.dnc{display:inline-block;background:#1c1917;color:white;border-radius:4px;padding:5px 8px;font:700 10px ui-monospace;letter-spacing:.06em}.restriction{display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:999px;padding:4px 8px;font-size:12px}.status{border:1px solid #d6d3d1;border-radius:999px;padding:4px 8px;font:600 11px ui-monospace}.lock{filter:grayscale(1)}
    .board{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px}.column{min-width:260px;background:#f5f5f4;border:1px solid #e7e5e4;border-radius:10px;padding:12px}.card{background:white;border:1px solid #d6d3d1;border-radius:8px;padding:13px;box-shadow:0 1px 2px #0000000d}.permanent{border:2px solid #1c1917;border-radius:8px;padding:16px;background:#f5f5f4}.permanent strong{display:block;font:800 14px ui-monospace;letter-spacing:.06em}.chips{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.chip{border:1px solid #d6d3d1;border-radius:999px;padding:5px 9px;font-size:12px}.details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.panel{background:white;border:1px solid #e7e5e4;border-radius:9px;padding:15px}.mutations{display:none}
    @media(max-width:520px){header{align-items:flex-start;gap:12px;padding:12px;flex-direction:column}main{padding:14px}nav{width:100%;overflow-x:auto}h1{font-size:24px}.details{grid-template-columns:1fr}table{font-size:13px}th,td{padding:10px}}
  </style></head><body>
  <div class="synthetic-banner" role="status">SYNTHETIC — DATABASE-FREE CONTRACT PROOF — NOT LIVE SANDRA</div>
  <header><strong>SANDRA</strong><nav aria-label="Proof views"><button data-view="leads" aria-pressed="true">Leads</button><button data-view="prospects" aria-pressed="false">Prospects</button><button data-view="detail" aria-pressed="false">Locked detail</button></nav></header>
  <main>
    <section class="view" id="leads"><h1>Leads</h1><p class="lede">Only active, unlocked pipeline records can appear here.</p><div class="board">${leads.map((record) => `<article class="column"><strong>Interested</strong><div class="card" data-record="${record.id}"><strong>${escapeHtml(record.address)}</strong><small>${escapeHtml(record.city)}, ${record.state}</small></div></article>`).join("")}</div></section>
    <section class="view" id="prospects" hidden><h1>Prospects</h1><p class="lede">Permanent DNC records remain visible for audit history.</p><table><thead><tr><th>Select</th><th>Property</th><th>Status</th></tr></thead><tbody>${prospects.map(prospectRow).join("")}</tbody></table></section>
    <section class="view" id="detail" hidden><h1>404 Locked History Ave</h1><div class="permanent" data-testid="permanent-dnc-lock"><strong>⊘ PERMANENT DO NOT CONTACT</strong><p>This record is permanently locked and read-only. Its historical pipeline stage is preserved for audit history.</p></div><div class="chips"><span class="chip">Historical stage: under contract</span><span class="chip">Disposition: dnc</span></div><div class="details"><section class="panel"><h2>Property</h2><p>404 Locked History Ave<br>Kansas City, MO</p></section><section class="panel"><h2>Homeowner</h2><p>Do not contact<br><strong>Yes — permanent</strong></p></section></div><div class="mutations" aria-hidden="true">Send SMS Assign Delete Book appointment Add task Enroll in sequence Change status</div></section>
  </main>
  <script>
    const buttons=[...document.querySelectorAll('[data-view]')];
    buttons.forEach(button=>button.addEventListener('click',()=>{buttons.forEach(item=>item.setAttribute('aria-pressed',String(item===button)));document.querySelectorAll('.view').forEach(view=>view.hidden=view.id!==button.dataset.view)}));
  </script></body></html>`;
}

async function openView(page: Page, name: "Leads" | "Prospects" | "Locked detail") {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const) {
  test(`synthetic database-free DNC contract at ${viewport.name} width`, async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(pageHtml(), { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("SYNTHETIC — DATABASE-FREE CONTRACT PROOF — NOT LIVE SANDRA"),
    ).toBeVisible();

    await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
    const leadsView = page.locator("#leads");
    await expect(leadsView.getByText("101 Active Seller Blvd")).toBeVisible();
    await expect(leadsView.getByText("404 Locked History Ave")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`synthetic-contract-dnc-leads-${viewport.name}.png`),
      fullPage: true,
    });

    await openView(page, "Prospects");
    const lockedRow = page.locator('[data-record="advanced-dnc"]');
    await expect(lockedRow).toContainText("404 Locked History Ave");
    await expect(lockedRow).toContainText("⊘ DO NOT CONTACT");
    await expect(
      lockedRow.getByRole("checkbox", { name: /Select 404 Locked/ }),
    ).toHaveCount(0);
    await expect(
      lockedRow.getByRole("img", { name: /locked Do Not Contact/ }),
    ).toBeVisible();

    const smsRow = page.locator('[data-record="sms-only"]');
    await expect(smsRow).toContainText("SMS opted out");
    await expect(smsRow).not.toContainText("DO NOT CONTACT");
    await expect(smsRow.getByRole("checkbox")).toBeVisible();

    const wrongNumberRow = page.locator('[data-record="wrong-number"]');
    await expect(wrongNumberRow).toContainText("Wrong number");
    await expect(wrongNumberRow).not.toContainText("DO NOT CONTACT");
    await expect(wrongNumberRow.getByRole("checkbox")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`synthetic-contract-dnc-prospects-${viewport.name}.png`),
      fullPage: true,
    });

    await openView(page, "Locked detail");
    await expect(page.getByTestId("permanent-dnc-lock")).toBeVisible();
    await expect(page.getByText("Historical stage: under contract")).toBeVisible();
    for (const action of [
      "Send SMS",
      "Assign",
      "Delete",
      "Book appointment",
      "Add task",
      "Enroll in sequence",
      "Change status",
    ]) {
      await expect(page.getByRole("button", { name: action })).toHaveCount(0);
    }
    await page.screenshot({
      path: testInfo.outputPath(`synthetic-contract-dnc-locked-detail-${viewport.name}.png`),
      fullPage: true,
    });

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
