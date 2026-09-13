import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('./', import.meta.url));
await mkdir(`${root}.runtime`, { recursive: true });
await build({ entryPoints: [`${root}app.tsx`], outfile: `${root}.runtime/app.js`,
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const origin = 'http://127.0.0.1:58791';
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['.runtime/app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['.runtime/app.css', 'text/css; charset=utf-8']],
]);
const server = createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:58791' || (req.headers.origin && req.headers.origin !== origin)) {
    res.writeHead(403).end(); return;
  }
  const entry = files.get(new URL(req.url ?? '/', origin).pathname);
  if (req.method !== 'GET' || !entry) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(`${root}${entry[0]}`);
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; frame-ancestors 'none'" });
    res.end(body);
  } catch { res.writeHead(503).end('Preview build unavailable'); }
});
server.listen(58791, '127.0.0.1', () => console.log(`Synthetic Inbox presentation preview: ${origin}`));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
