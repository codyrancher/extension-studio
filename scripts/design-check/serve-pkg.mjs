// Serve the built extension over HTTPS so Rancher's browser can fetch it.
//
// The UIPlugin below is created with `direct: true`, which means the *browser* fetches this
// endpoint rather than Rancher serving the files itself - so this only has to be reachable
// from the browser sidecar, which can already reach this container. HTTPS rather than HTTP
// because Rancher is served over TLS and a plain-http script would be blocked as mixed
// content; the certificate is self-signed, which the sidecar's Chromium is already tolerating
// for Rancher itself.
import { createServer } from 'node:https';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const ROOT = process.argv[2];
const PORT = parseInt(process.argv[3] || '8443', 10);
const TLS = process.argv[4];

const TYPES = {
  '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css',
  '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.html': 'text/html',
};

createServer({
  key:  readFileSync(join(TLS, 'key.pem')),
  cert: readFileSync(join(TLS, 'cert.pem')),
}, (req, res) => {
  // Rancher's origin fetches this cross-origin; without CORS the browser refuses the module.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  // No caching, at all. The main bundle can be cache-busted with a query parameter but the
  // chunks it pulls in cannot - webpack requests those by their own generated names - and a
  // chunk id is reused across builds with different contents. That is how a rebuilt component
  // can go on behaving like the previous build, which cost an hour of chasing a badge that
  // was being handed the right value and rendering the wrong one.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();

    return;
  }

  const rel = normalize(decodeURIComponent(new URL(req.url, 'https://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);

  if (!existsSync(file) || !statSync(file).isFile()) {
    console.log(`404 ${ rel }`);
    res.writeHead(404).end('not found');

    return;
  }

  const ext = file.slice(file.lastIndexOf('.'));

  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
  res.end(readFileSync(file));
  console.log(`200 ${ rel }`);
}).listen(PORT, '0.0.0.0', () => console.log(`serving ${ ROOT } on https://0.0.0.0:${ PORT }`));
