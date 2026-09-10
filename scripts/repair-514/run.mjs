import { runRepair } from './repair-pr514-search.mjs';
import { verifyAuthenticated } from './verify.ts';

try {
  const receipt = await runRepair({ verifyAuthenticated, env: { ...process.env, REPAIR_514_DB_URL: process.env.E2E_CI_SUPABASE_DB_URL, REPAIR_514_API_URL: process.env.TEST_SUPABASE_URL, REPAIR_514_ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY } });
  console.log(JSON.stringify(receipt));
} catch (error) {
  // Only runner-defined codes are printable; never expose SDK/pg errors.
  console.error(/^R514_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'R514_EXECUTION_FAILED');
  process.exitCode = 1;
}
