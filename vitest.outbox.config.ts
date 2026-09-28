import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['scripts/outbox-owned-rows.test.ts'], environment: 'node' } });
