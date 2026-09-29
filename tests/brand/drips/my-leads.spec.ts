import { expect, test } from '@playwright/test';

test('My Leads drip grouping and replied flag', async ({page}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({width:1440,height:1800});
  await page.goto('/brand/drips/my-leads');
  await expect(page.getByTestId('my-leads-section-in_drip')).toContainText('In a drip');
  await expect(page.getByTestId('my-lead-drip-fixture-drip-1')).toContainText('text 2 of 4');
  await expect(page.getByTestId('kpi-replied-to-drip')).toContainText('1');
  await expect(page.getByTestId('my-lead-row-fixture-replied')).toContainText('Replied to drip');
  await expect(page).toHaveScreenshot('my-leads-main.png', {fullPage:true});
});

test('Log attempt fixture', async ({page}) => {
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/brand/drips/log-attempt');
  await page.getByRole('button',{name:'Open fixture dialog'}).click();
  await expect(page.getByRole('dialog', {name:/Log an attempt/i})).toBeVisible();
  await expect(page).toHaveScreenshot('my-leads-log-attempt.png');
  await page.getByLabel('Source').selectOption('manual');
  await page.getByLabel('External outcome').selectOption('reached');
  await page.getByLabel('When did the outreach occur?').fill('2026-09-29T09:00');
  await page.getByRole('button',{name:'Save attempt'}).click();
  await expect(page.getByText('Attempt saved. Add to a drip (optional).')).toBeVisible();
  await expect(page.getByRole('button',{name:/Seller follow-up/})).toBeVisible();
  await expect(page).toHaveScreenshot('my-leads-post-save-picker.png');
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
  await expect(page).toHaveScreenshot('my-leads-handoff.png');
});
