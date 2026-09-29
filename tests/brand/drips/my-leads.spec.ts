import path from 'node:path';
import { expect, test } from '@playwright/test';

const screenshot = (name:string) => path.resolve('docs/design/screenshots/drips', `${name}.png`);

test('My Leads drip grouping and replied flag', async ({page}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({width:1440,height:1800});
  await page.goto('/brand/drips/my-leads');
  await expect(page.getByTestId('my-leads-section-in_drip')).toContainText('In a drip');
  await expect(page.getByTestId('my-lead-drip-fixture-drip-1')).toContainText('text 2 of 4');
  await expect(page.getByTestId('kpi-replied-to-drip')).toContainText('1');
  await expect(page.getByTestId('my-lead-row-fixture-replied')).toContainText('Replied to drip');
  await page.screenshot({path:screenshot('my-leads-main'),fullPage:true});
});

test('Log attempt fixture', async ({page}) => {
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/brand/drips/log-attempt');
  await page.getByRole('button',{name:'Open fixture dialog'}).click();
  await expect(page.getByRole('dialog', {name:/Log an attempt/i})).toBeVisible();
  await page.screenshot({path:screenshot('my-leads-log-attempt')});
});

test('Handoff fixture', async ({page}) => {
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/brand/drips/handoff');
  await page.getByRole('button',{name:'Open fixture dialog'}).click();
  await expect(page.getByRole('dialog', {name:/Hand off lead/i})).toBeVisible();
  await page.getByLabel('Handoff reason').selectOption('not_interested');
  await expect(page.getByText('Add to a drip (optional)')).toBeVisible();
  await page.getByRole('button',{name:/Seller follow-up/}).click();
  await expect(page.getByLabel('Reassign to')).toHaveCount(0);
  await page.screenshot({path:screenshot('my-leads-handoff')});
});
