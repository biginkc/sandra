import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['e2e/inbox-acceptance/owned-rows.test.ts'], environment: 'node' } });
