// The caller's credential, forwarded and never held.
//
// This pod has a ServiceAccount, because every pod does, and it is bound to cluster-admin,
// because every pod in this namespace is. That makes it the one thing this service must never
// use: a request answered with our identity is a request answered for somebody who was not
// asked whether they were allowed. So nothing here reads a token off disk. The only credential
// that reaches Rancher is the one that arrived on the request, and a request that arrived with
// none is refused here rather than served by us.
//
// The consequence is worth stating plainly, because it is the point: this service decides
// nothing about permissions. A caller whose RBAC forbids a write gets the apiserver's own 403,
// with the apiserver's own message, and we pass it back untouched.
//
// Two shapes count, because two kinds of caller exist. A signed-in dashboard has an `R_SESS`
// cookie and a CSRF header, which is exactly what pkg/extension-studio/api.ts sends today.
// Anything else - curl, a controller, a script - carries a Rancher API token in Authorization.

/**
 * The request headers that are a credential, or carry one.
 *
 * `x-api-csrf` is not itself a credential, but Rancher rejects a cookie-authenticated write
 * without it, so dropping it would turn every browser-shaped POST into a 403 that looked like
 * an RBAC failure. It travels with the cookie or not at all.
 */
const FORWARDED = ['authorization', 'cookie', 'x-api-csrf', 'x-api-auth-header'];

/**
 * What to send upstream on this caller's behalf, or null when they sent nothing.
 *
 * Copied verbatim. Rewriting a token into another form would mean understanding it, and the
 * whole design here is that we do not.
 */
export function callerCredential(req) {
  const headers = {};

  for (const name of FORWARDED) {
    const value = req.headers[name];

    if (value) {
      headers[name] = Array.isArray(value) ? value.join('; ') : value;
    }
  }

  return hasCredential(headers) ? headers : null;
}

function hasCredential(headers) {
  return !!headers.authorization || /(?:^|;\s*)R_SESS=/.test(headers.cookie || '');
}

/** What a caller with no credential is told, which has to be enough to fix it with. */
export const NO_CREDENTIAL = [
  'This request carried no credential, and this service has none of its own to lend you.',
  'Send an Authorization header holding a Rancher API token ("Authorization: Bearer token-xxxxx:secret"),',
  'or the R_SESS cookie and X-Api-CSRF header that a signed-in dashboard already sends.',
].join(' ');
