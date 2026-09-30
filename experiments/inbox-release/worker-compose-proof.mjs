import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { load: parseYaml } = require('js-yaml');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const supplied = input.supplied_env ?? {};
const composePath = path.resolve(input.compose_path);
const compose = parseYaml(fs.readFileSync(composePath, 'utf8'));

function interpolate(value) {
  return String(value).replace(/\$\{([A-Z0-9_]+)(?::\?([^}]*))?\}/g, (whole, name, message) => {
    const replacement = supplied[name];
    if (replacement === undefined || replacement === '') {
      throw Error(message || `missing compose variable ${name}`);
    }
    return replacement;
  });
}

function readEnvFile(filename) {
  const values = {};
  for (const rawLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw Error(`invalid env file line in ${path.basename(filename)}`);
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function resolvedServiceEnvironment(serviceName) {
  const service = compose.services?.[serviceName];
  if (!service || typeof service !== 'object') throw Error(`compose service ${serviceName} is missing`);
  const values = {};
  for (const rawEnvFile of service.env_file ?? []) {
    const envFile = interpolate(typeof rawEnvFile === 'string' ? rawEnvFile : rawEnvFile.path);
    Object.assign(values, readEnvFile(path.isAbsolute(envFile) ? envFile : path.resolve(path.dirname(composePath), envFile)));
  }
  const environment = service.environment ?? {};
  for (const [name, rawValue] of Object.entries(environment)) {
    values[name] = rawValue === null ? supplied[name] ?? '' : interpolate(rawValue);
  }
  return values;
}

function workerPaths(kind) {
  const directory = kind === 'operation' ? 'inbox-operation-worker' : 'inbox-reply-send-worker';
  return {
    core: pathToFileURL(path.resolve(path.dirname(composePath), '..', directory, 'core.mjs')).href,
    server: pathToFileURL(path.resolve(path.dirname(composePath), '..', directory, 'server.mjs')).href,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function proveWorker(kind, env) {
  const { core, server: serverPath } = workerPaths(kind);
  const { workerConfiguration, databaseConfiguration } = await import(core);
  const { createWorkerRequestHandler } = await import(serverPath);
  const config = workerConfiguration(env);
  const database = databaseConfiguration(env);
  assert.equal(config.registrationPath, env.INBOX_RESTATE_REGISTRATION_PATH);
  assert.equal(database.host, '127.0.0.1');
  assert.equal(database.port, 54322);

  const registrationPath = config.registrationPath;
  const endpointPath = kind === 'operation' ? '/InboxMetadataOperation/run/send' : '/InboxReplySend/run/send';
  const handler = createWorkerRequestHandler({
    registrationPath,
    endpoint: async (_req, res) => { res.writeHead(200); res.end('handled'); },
  });
  const server = createServer(handler);
  const port = await listen(server);
  try {
    const base = `http://127.0.0.1:${port}`;
    const live = await fetch(`${base}/livez`);
    const routed = await fetch(`${base}${registrationPath}${endpointPath}`);
    const root = await fetch(`${base}${endpointPath}`);
    assert.equal(live.status, 200);
    assert.equal(routed.status, 200);
    assert.equal(await routed.text(), 'handled');
    assert.equal(root.status, 404);
  } finally {
    await close(server);
  }
  return { kind, configurationAccepted: true, databaseAccepted: true, routingAccepted: true };
}

const composeEnvironments = {
  'operation-worker': resolvedServiceEnvironment('operation-worker'),
  'reply-send-worker': resolvedServiceEnvironment('reply-send-worker'),
};
const environments = input.resolved_services
  ? {
      'operation-worker': { ...composeEnvironments['operation-worker'], ...input.resolved_services['operation-worker'] },
      'reply-send-worker': { ...composeEnvironments['reply-send-worker'], ...input.resolved_services['reply-send-worker'] },
    }
  : composeEnvironments;
const results = await Promise.all([
  proveWorker('operation', environments['operation-worker']),
  proveWorker('reply', environments['reply-send-worker']),
]);
process.stdout.write(JSON.stringify(results));
