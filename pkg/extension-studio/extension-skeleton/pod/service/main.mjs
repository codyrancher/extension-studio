#!/usr/bin/env node
// The Extension Studio API: the resource lifecycle, and one socket in front of every pod.
//
//   node /seed/main.mjs
//
// Started by the Deployment in pkg/extension-studio/service.ts, on the stock node:24 image with
// this directory mounted from a ConfigMap. There is no image to build and no install to wait
// for, which is the same bargain every extension pod here already takes: node 24 has an HTTP
// server, fetch and TLS in the box, and those are the whole surface this needs.
//
// Two halves. Requests are routed through the table in routes.mjs and answered as JSON.
// Upgrades are routed through the same table and answered by splicing the caller's socket onto
// the apiserver's exec stream. Both halves refuse a request that arrived without a credential,
// and neither has one of its own to fall back on.
import http from 'node:http';
import { match } from './router.mjs';
import { HANDLERS } from './handlers.mjs';
import { callerCredential, NO_CREDENTIAL } from './credential.mjs';
import { ApiError } from './rancher.mjs';
import { refuse } from './exec.mjs';

const PORT = Number(process.env.PORT || 8006);

/** How much of a POST body will be read before it is refused. A seed is the large case. */
const BODY_LIMIT = 1024 * 1024;

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2);

  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The request URL as a URL.
 *
 * `req.url` is a path, so it needs a base to parse against, and the base is thrown away
 * afterwards. It is a placeholder rather than the real host on purpose: nothing here should be
 * able to accidentally use it as an address.
 */
function requestUrl(req) {
  return new URL(req.url, 'http://service.invalid');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > BODY_LIMIT) {
        reject(new ApiError(`that body is larger than ${ BODY_LIMIT } bytes. A seed that big belongs in a ConfigMap made directly, not in a request.`, 413));
        req.destroy();

        return;
      }

      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');

      if (!text.trim()) {
        resolve({});

        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new ApiError(`the body is not JSON: ${ e.message }`, 400));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async(req, res) => {
  const url = requestUrl(req);
  const found = match(req.method, url.pathname);

  if (!found) {
    send(res, 404, { message: `no route for ${ req.method } ${ url.pathname }. GET /openapi.json lists every route this service has.` });

    return;
  }

  if (!found.route) {
    res.setHeader('Allow', found.allowed.join(', '));
    send(res, 405, { message: `${ url.pathname } exists, but not for ${ req.method }. It answers ${ found.allowed.join(' and ') }.` });

    return;
  }

  const { route, params } = found;

  // A plain GET to the stream route. It matched, so a 404 would be a lie, and a caller who
  // curled it deserves to be told the one thing missing rather than left with an empty body.
  if (route.upgrade) {
    send(res, 426, { message: `${ url.pathname } is a WebSocket. Connect with an Upgrade request and the base64.channel.k8s.io subprotocol.` });

    return;
  }

  const cred = route.auth ? callerCredential(req) : {};

  if (!cred) {
    send(res, 401, { message: NO_CREDENTIAL });

    return;
  }

  try {
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : null;
    const answer = await HANDLERS[route.handler]({
      cred, params, url, req, body,
    });

    send(res, answer.status, answer.body);
  } catch (e) {
    // The apiserver's own status, passed on. A 403 here is the caller's RBAC and not our
    // decision, and turning it into a 500 would hide the one thing they can act on.
    send(res, e instanceof ApiError ? e.status : 500, { message: e?.message || String(e) });
  }
});

server.on('upgrade', async(req, socket, head) => {
  const url = requestUrl(req);
  const found = match(req.method, url.pathname);

  if (!found?.route?.upgrade) {
    refuse(socket, 404, 'Not Found', `${ url.pathname } is not a stream. The only one is GET /v1/extensions/{name}/exec.`);

    return;
  }

  const cred = callerCredential(req);

  if (!cred) {
    refuse(socket, 401, 'Unauthorized', NO_CREDENTIAL);

    return;
  }

  try {
    await HANDLERS[found.route.handler]({
      cred, params: found.params, url, req, socket, head,
    });
  } catch (e) {
    refuse(socket, e instanceof ApiError ? e.status : 500, 'Error', e?.message || String(e));
  }
});

server.listen(PORT, () => console.log(`[api] listening on ${ PORT }`));
