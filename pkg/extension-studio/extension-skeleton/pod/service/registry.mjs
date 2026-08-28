// Reading the API registry: which extensions in this cluster say they offer an API.
//
// The registry itself is a set of ConfigMaps, one per extension, and reading it needs nothing
// from this service - a label-selected list is one call any client with RBAC can make, and it
// keeps working when this service is down, which is exactly when somebody is hunting for a way
// to reach it. That is the primary reader and it lives in the browser, in api-registry.ts.
//
// This is the convenience: the same list, already parsed, with each entry's documentation URL
// actually tried. The reason it is worth having is the marking. An entry whose service has been
// deleted, or which advertises a URL that never worked, is still an entry - and a reader that
// quietly dropped it would turn "this API is broken" into "this API does not exist", which sends
// somebody looking for a registration that is sitting right there.
//
// The registry vouches for nothing. Anything able to write a ConfigMap in this namespace can put
// an entry in it, so an entry is a claim by whoever wrote it and never a statement by us.
import { EXT_BASE, EXT_NS } from './names.mjs';
import { rancherFetch, RANCHER_URL } from './rancher.mjs';

/** The label an entry carries. The prefix matches every other key this product writes. */
const API_REGISTRY_LABEL = 'barn.rancher.io/api-registry';

/** How long to wait for an entry's documentation before calling it unreachable. */
const PROBE_TIMEOUT_MS = 5000;

/** One extension's registry object. See api-registry.ts for why the suffix is this long. */
export function apiRegistryObject(extension) {
  return `${ extension }-api-registry`;
}

/** Join an entry's two halves the way every reader must, so nobody invents a third way. */
export function apiDocsUrl(entry) {
  return `${ String(entry.url || '').replace(/\/+$/, '') }/${ String(entry.docs || '').replace(/^\/+/, '') }`;
}

/**
 * One ConfigMap as an entry, or null when it carries nothing a reader could use.
 *
 * Dropping an object that has the label but no `url` is different from marking one whose URL
 * does not answer: the first is not an entry, the second is a broken one, and only the second is
 * worth reporting.
 */
function entryOf(item) {
  const data = item?.data || {};

  if (!data.url) {
    return null;
  }

  return {
    extension: data.extension || item?.metadata?.name || '',
    title:     data.title || data.extension || '',
    url:       data.url,
    docs:      data.docs || '',
    version:   data.version || '',
  };
}

/**
 * Whether an entry's documentation actually answers, as the caller.
 *
 * Only root-relative paths are tried, and that refusal is the point rather than a limitation.
 * The probe sends the caller's own credential, and the address comes out of a ConfigMap that
 * anything with write access to this namespace can create. Honouring an absolute URL would
 * therefore buy whoever wrote the entry two things at once: every session that loads GET
 * /v1/apis delivered to a host they named, and a request originating inside the cluster from a
 * pod on a cluster-admin ServiceAccount, which reaches addresses no browser can - the apiserver,
 * a link-local metadata service, anything else in the namespace. One ConfigMap write for a
 * credential harvester and an SSRF pivot.
 *
 * Refusing a leading `//` matters as much as refusing `https://`, and the protocol-relative form
 * was tried against this service to be sure of it: `//example.invalid/x` does not escape, but not
 * because of this test. It does not escape because the fetch below concatenates onto RANCHER_URL
 * rather than resolving against it, so the request goes to Rancher with a doubled slash in the
 * path. Anything that later turns this into `new URL(docs, RANCHER_URL)` would make that form
 * outbound again, which is why the reasoning is written down here rather than left to the shape
 * of the code.
 *
 * A path on Rancher's own origin is the only thing an extension API can legitimately be in this
 * design, so anything else is reported as unreachable with the reason said plainly.
 */
async function probe(cred, entry) {
  const docs = apiDocsUrl(entry);

  if (!docs.startsWith('/')) {
    return { reachable: false, status: 0, reason: `"${ entry.url }" is not a path on this Rancher, so it was not fetched. A registry entry's url has to be root-relative.` };
  }

  try {
    const resp = await fetch(`${ RANCHER_URL }${ docs }`, {
      headers: { Accept: 'application/json', ...cred },
      signal:  AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    return {
      reachable: resp.ok,
      status:    resp.status,
      reason:    resp.ok ? '' : `${ docs } answered HTTP ${ resp.status }`,
    };
  } catch (e) {
    return { reachable: false, status: 0, reason: `${ docs } could not be reached: ${ e?.message || e }` };
  }
}

/**
 * Every entry, with its documentation URL resolved.
 *
 * The probes run together rather than in turn: this is a list, one slow entry should not decide
 * how long the whole answer takes, and each has its own timeout.
 */
export async function listApis(cred) {
  const selector = encodeURIComponent(`${ API_REGISTRY_LABEL }=true`);
  // The apiserver's own path rather than Steve's, because Steve ignores labelSelector and would
  // hand back every ConfigMap in the namespace for us to filter.
  const list = await rancherFetch(cred, `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/configmaps?labelSelector=${ selector }`);
  const entries = (list.items || []).map(entryOf).filter(Boolean);

  const items = await Promise.all(entries.map(async(entry) => ({
    ...entry,
    docsUrl: apiDocsUrl(entry),
    ...await probe(cred, entry),
  })));

  return { items: items.sort((a, b) => a.extension.localeCompare(b.extension)) };
}
