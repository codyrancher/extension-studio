// What the objects in this namespace are called, said once for the pod side.
//
// These names exist twice on purpose. This file runs in a pod, against nothing but node, so it
// cannot import pkg/extension-studio: that tree opens with a browser fetch, a Vue component and a
// 140KB generated seed, none of which a service has any business loading. The other copy is
// pkg/extension-studio/extensions.ts.
//
// Drift between the two is the failure worth preventing, because it is silent: a service that
// creates a Deployment naming a container the browser does not expect produces an extension
// that installs, runs and cannot be exec'd into. scripts/gen-extension-seed.mjs compares the
// constants below against their counterparts and refuses to generate a seed if they disagree,
// which is the same guard barn-provenance.mjs and the screenshot skill already live under.
export const EXT_NS = 'extension-studio';
export const EXT_ACCOUNT = 'extension-studio';
export const EXT_ROLE_BINDING = 'extension-studio-cluster-admin';
const EXT_CONTAINER = 'devserver';
const EXT_IMAGE = 'node:24';
const EXT_PORT = 8005;

// The browser every extension in this namespace is looked at in. Named here because a pod is
// told where it is: an extension created through this service has to reach the same one an
// extension created from the dashboard does, or a screenshot taken in it goes nowhere.
export const BROWSER_OBJECT = 'browser';

// The one claude that can see every extension, which the drawer's conversations run in - and,
// scoped by project, a workspace's conversations too. Spelled here as well as in agent.ts for
// the reason every other name on this file is: the service has no way to import the browser's.
export const AGENT_OBJECT = 'extension-studio-agent';
export const AGENT_CONTAINER = 'agent';
const BROWSER_CDP_PORT = 9222;

// ConfigMap keys cannot contain '/', so tree paths are flattened with this and boot.sh
// rebuilds them. Both halves have to spell it the same or a seeded pod writes its tree flat.
const PATH_SEPARATOR = '__';

export { EXT_CONTAINER, EXT_IMAGE, EXT_PORT, BROWSER_CDP_PORT, PATH_SEPARATOR };

// The `local` cluster, like everything else here: this product edits extensions in the cluster
// Rancher itself runs in, and a path that named a different one would have nothing to talk to.
const EXT_CLUSTER = 'local';

/** Every path this service builds hangs off Rancher's proxy to that cluster's apiserver. */
export const EXT_BASE = `/k8s/clusters/${ EXT_CLUSTER }`;

/**
 * What one extension's objects are called.
 *
 * `<name>-extension` rather than the bare name, because the namespace also holds the browser
 * and this service, and a bare name would eventually collide with one of them.
 */
export function extensionObject(name) {
  return `${ name }-extension`;
}

/** The reverse, for listing: null for anything in the namespace that is not an extension. */
export function extensionName(object) {
  const match = /^(.+)-extension$/.exec(object || '');

  return match ? match[1] : null;
}

/**
 * A name Kubernetes will accept, and that a person will recognise afterwards.
 *
 * Applied rather than rejected, the same way the header's own box applies it, so that a POST
 * asking for "My Thing" creates `my-thing` instead of failing validation twice: once here and
 * once in the apiserver, with two different messages.
 */
export function normalizeExtensionName(input) {
  return (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Where the node keeps an extension's working tree and node_modules between pod restarts. */
export function hostCachePath(name) {
  return `/var/lib/rancher/extension-studio/${ name }-extension`;
}

/** The apiserver service proxy an extension's dev server is served through. */
export function extensionProxyPath(name) {
  return `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/services/http:${ extensionObject(name) }:${ EXT_PORT }/proxy`;
}

/** Where to point a browser at one. */
export function extensionUrl(name) {
  return `${ extensionProxyPath(name) }/`;
}
