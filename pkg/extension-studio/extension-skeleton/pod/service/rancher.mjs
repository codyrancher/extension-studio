// Talking to Rancher from inside the cluster, as whoever called us.
//
// The same API the browser uses and the same paths, because it is the same product: Steve at
// `/k8s/clusters/local/v1/<type>` for reading and writing objects, and the apiserver's own
// `/api/v1/...` underneath it for the exec subresource. Nothing here is a Kubernetes client;
// there is no client to install and none is wanted.
//
// The address is Rancher's, not `kubernetes.default.svc`. Going straight to the apiserver
// would mean holding a credential the apiserver understands, and the caller's is a Rancher
// one. Forwarding it to Rancher is the only route that keeps this service credential-free,
// and it has the second benefit of putting the caller through the same authorization Rancher
// applies to the dashboard rather than a second, parallel one of our own.
import { EXT_BASE } from './names.mjs';

/**
 * Rancher's address as seen from a pod, which is the node's.
 *
 * This cluster is k3s inside the Rancher container, so the node and Rancher are one address;
 * the Deployment composes this out of `status.hostIP`, the same way the browser's CHROME_CLI
 * does. There is no default worth guessing, so an unset value fails at the first call with a
 * sentence rather than as a connection refused to `undefined`.
 */
export const RANCHER_URL = (process.env.RANCHER_URL || '').replace(/\/+$/, '');

/** An upstream answer that was not a success, carrying the status so a route can pass it on. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function requireRancherUrl() {
  if (!RANCHER_URL) {
    throw new ApiError(
      'RANCHER_URL is not set on this pod, so there is nothing to forward to. It is composed from status.hostIP by the Deployment in pkg/extension-studio/service.ts; recreate the pod from that.',
      500,
    );
  }
}

/**
 * One Rancher call as the caller, decoded as JSON, that throws on failure.
 *
 * `cred` is what callerCredential produced. It is a required argument rather than an optional
 * one on purpose: a call site that forgot it would otherwise silently run as this pod's own
 * ServiceAccount, which is the single failure this whole design exists to make impossible.
 */
export async function rancherFetch(cred, path, init = {}) {
  requireRancherUrl();

  const write = init.method && init.method !== 'GET';
  const resp = await fetch(`${ RANCHER_URL }${ path }`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...cred,
      ...(init.headers || {}),
    },
  }).catch((e) => {
    throw new ApiError(`could not reach Rancher at ${ RANCHER_URL }: ${ e?.message || e }`, 502);
  });

  const text = await resp.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Rancher answers an unauthenticated request to some paths with HTML. Keeping the status
    // is what matters; the body would only be a login page.
    data = { message: text.slice(0, 200) };
  }

  if (!resp.ok) {
    throw new ApiError(data.message || data.error || `HTTP ${ resp.status }`, resp.status);
  }

  return data;
}

/** Where one object lives, namespaced or not. Only this file addresses an object by path. */
function objectPath(spec) {
  return spec.namespace
    ? `${ EXT_BASE }/v1/${ spec.type }/${ spec.namespace }/${ spec.name }`
    : `${ EXT_BASE }/v1/${ spec.type }/${ spec.name }`;
}

/**
 * What a read of one object found: 'present', 'absent', or 'unknown' with the reason.
 *
 * Three answers rather than two, because 404 is the only status that means the object is not
 * there. Everything else - a refusal, a Rancher that is down, a proxy that timed out - means the
 * question was not answered, and folding those into "absent" is a report of nothing installed
 * that invites a reinstall of things that are standing.
 *
 * The refusal is not hypothetical and is the reason this function exists. Steve answers
 * `GET /k8s/clusters/local/v1/namespaces/extension-studio` with 403, not 404, when the caller
 * may not see that namespace, which is every Rancher user who is not an administrator. Checked
 * against this cluster with a real low-privilege user rather than reasoned about.
 *
 * A 401 is not one of the three and is raised instead. The other two answers are about one
 * object; a 401 says nothing was asked on anybody's behalf, which is true of every object at
 * once and is the caller's whole answer. Reporting it per step would be a 200 to somebody whose
 * session has expired, when what they need is to be sent to log in again.
 */
export async function objectState(cred, spec) {
  try {
    await rancherFetch(cred, objectPath(spec));

    return { state: 'present', error: '' };
  } catch (e) {
    if (e?.status === 401) {
      throw e;
    }

    if (e?.status === 404) {
      return { state: 'absent', error: '' };
    }

    return { state: 'unknown', status: e?.status || 0, error: e?.message || String(e) };
  }
}

/**
 * Whether an object is there, for the one caller that is about to create it anyway.
 *
 * createIfAbsent is that caller and, since this is not exported, the only one it can have. A
 * read it was refused reads as "not there", it tries to create, and the apiserver refuses the
 * write too - so the refusal still reaches the caller, from the write instead of the read, and
 * nothing is lost. Treating a forbidden read as an existence check would instead report
 * "already installed" to somebody who cannot see any of it.
 *
 * Anything that only wants to know what exists must use objectState. installState called this
 * instead, and so told an ordinary user that all six steps were missing when the namespace was
 * there and only unreadable.
 */
async function existsForCreate(cred, spec) {
  return (await objectState(cred, spec)).state === 'present';
}

/**
 * Create one object if it is not already there, and treat losing the race as success.
 *
 * The same read-before-write install.ts does in the browser, for the same reason. The state
 * that matters is in the cluster rather than in this process, so an install interrupted half
 * way finishes on the next call instead of starting over, and two callers racing converge.
 *
 * Which leaves the gap between the read and the write, and that is what the 409 is for: both
 * of them saw nothing, both POSTed, one was told the object already exists. That is the
 * outcome both of them wanted, so it is success.
 */
export async function createIfAbsent(cred, spec) {
  if (await existsForCreate(cred, spec)) {
    return 'present';
  }

  try {
    await rancherFetch(cred, `${ EXT_BASE }/v1/${ spec.type }`, {
      method: 'POST',
      body:   JSON.stringify(spec.body()),
    });

    return 'created';
  } catch (e) {
    if (e?.status === 409 || /already exists|alreadyexists/i.test(e?.message || '')) {
      return 'present';
    }

    throw e;
  }
}

/** Delete one object, treating a missing one as done rather than as a failure. */
export async function removeObject(cred, spec) {
  try {
    await rancherFetch(cred, objectPath(spec), { method: 'DELETE' });

    return 'deleted';
  } catch (e) {
    if (e?.status === 404) {
      return 'absent';
    }

    throw e;
  }
}
