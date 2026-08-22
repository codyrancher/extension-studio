// Install the built barn bundle into the running Rancher as a UIPlugin.
//
// The same shape the extension's own publishExtension uses for extensions in pods: a UIPlugin
// in cattle-ui-plugin-system with `direct: true`, so the browser fetches the endpoint itself
// rather than asking Rancher to serve files from a downloaded chart.
import { readFileSync } from 'node:fs';

const RANCHER = process.env.RANCHER_URL || 'https://magic-closet-rancher';
const USER = 'admin';
const PASS = process.env.RANCHER_PASS || '';

if (!PASS) {
  console.error('Set RANCHER_PASS before running this.');
  process.exit(1);
}
const PLUGIN = 'barn';
const VERSION = process.argv[2] || '0.5.22';
// Cache-busting on the URL rather than trust in noCache, for the reason publishExtension
// gives: the browser has almost certainly loaded this exact path before, and verifying against
// a stale bundle is worse than not verifying at all.
const ENDPOINT = `${ process.argv[3] }?t=${ Date.now() }`;
const NS = 'cattle-ui-plugin-system';
const PKG = JSON.parse(readFileSync('/workspace/magic-closet/barn/pkg/barn/package.json', 'utf8'));
const ANNOTATIONS = PKG.rancher?.annotations || {};

console.log('annotations:', JSON.stringify(ANNOTATIONS));

const login = await fetch(`${ RANCHER }/v3-public/localProviders/local?action=login`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify({ username: USER, password: PASS }),
});

if (!login.ok) {
  console.error('login failed', login.status, await login.text());
  process.exit(1);
}

const { token } = await login.json();
const H = { Authorization: `Bearer ${ token }`, 'Content-Type': 'application/json' };

console.log('logged in');

const body = {
  apiVersion: 'catalog.cattle.io/v1',
  kind:       'UIPlugin',
  metadata:   { namespace: NS, name: PLUGIN },
  spec:       {
    plugin: {
      name:     PLUGIN,
      version:  VERSION,
      endpoint: ENDPOINT,
      noCache:  true,
      // The annotations matter as much as the endpoint. Without
      // catalog.cattle.io/ui-extensions-version the dashboard refuses to load the plugin and
      // says so only as plugins.error.apiAnnotationMissing in a store nobody is looking at -
      // so the extension installs cleanly, reports Ready, and never appears. A published
      // chart carries these across from package.json; this does the same by hand.
      metadata: { ...ANNOTATIONS, direct: 'true' },
    },
  },
};

const url = `${ RANCHER }/v1/catalog.cattle.io.uiplugins`;
const existing = await fetch(`${ url }/${ NS }/${ PLUGIN }`, { headers: H }).then((r) => (r.ok ? r.json() : null));

if (existing) {
  const res = await fetch(`${ url }/${ NS }/${ PLUGIN }`, {
    method: 'PUT', headers: H, body: JSON.stringify({ ...existing, spec: body.spec }),
  });

  console.log('updated ->', res.status, res.ok ? '' : await res.text());
} else {
  const res = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });

  console.log('created ->', res.status, res.ok ? '' : await res.text());
}

const check = await fetch(`${ url }/${ NS }/${ PLUGIN }`, { headers: H }).then((r) => r.json());

console.log('endpoint now:', check?.spec?.plugin?.endpoint);
process.exit(0);
