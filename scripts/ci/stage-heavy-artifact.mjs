import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const { HEAVY_TESTED_SHA: sha, GITHUB_RUN_ID: runId, HEAVY_RUN_DIR: runDir, RUNNER_TEMP: runnerTemp } = process.env;
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[0-9]+$/.test(runId ?? '') || !runnerTemp) {
  throw new Error('Missing heavy run identity');
}
const relative = `docs/performance/inbox-redesign/evidence/${sha}/pre-merge/${runId}`;
if (runDir !== relative) throw new Error('Lane did not export its exact run directory');
if (!existsSync(runDir)) throw new Error(`Run directory missing: ${runDir}`);
const destination = path.join(runnerTemp, 'heavy-upload', sha, 'pre-merge', runId);
mkdirSync(path.dirname(destination), { recursive: true });
cpSync(runDir, destination, { recursive: true, errorOnExist: true, force: false });
