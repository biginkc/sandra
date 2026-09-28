import { defineConfig } from '@playwright/test';
import base from './playwright.inbox-acceptance.config';
import { assertDisposableE2EDatabaseEnvironment } from './src/lib/supabase/e2e-target-safety';

assertDisposableE2EDatabaseEnvironment(process.env.TEST_SUPABASE_URL ?? '');
if (!process.env.OUTBOX_RUN_DIR || process.env.INBOX_ACCEPTANCE_ORG_ID !== '00000000-0000-0000-0000-000000000bbb' || process.env.MESSAGING_PROVIDER !== 'mock') throw new Error('Outbox runner requires disposable Sandra org and mock provider');
export default defineConfig({
  ...base,
  testMatch: /outbox\.spec\.ts$/,
  testIgnore: [],
  globalSetup: './e2e/inbox-acceptance/outbox-global-setup.ts',
  outputDir: `${process.env.OUTBOX_RUN_DIR}/playwright`,
  use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off' },
});
