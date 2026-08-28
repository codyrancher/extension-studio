// Where an extension says it offers an API, and where to find it.
//
// The Studio's service is the first extension API in this cluster and should not be the last, so
// there is nothing special about it: it registers the same way anything else would, and its own
// entry is the proof the mechanism works rather than an exception carved out of it.
//
// **The registry vouches for nothing.** Anything that can write a ConfigMap in this namespace can
// put an entry in it, which is the same trust boundary everything else here already has - an
// extension pod runs as a cluster-admin ServiceAccount, and anyone who can developer-load an
// extension is already running code in the dashboard. So an entry is a claim by whoever wrote
// it, not a statement by this product, and a reader that renders one should present it as such.
// There is deliberately no authentication of registrants and no notion of trust between
// extensions; adding one would be a much larger change than a ConfigMap.
//
// One object per extension rather than one shared registry. A shared one has every registrant
// writing the same resource, which is write contention and a lost update the first time two
// extensions load at once. Per-extension objects have exactly one writer each, are still listed
// in a single call by label selector, and can be RBAC-scoped per extension later if that is ever
// wanted.
import type { InstallStep } from './install';
import { rancherFetch } from './api';
import { EXT_NS, EXT_BASE } from './extensions';
import { VERSION_ANNOTATION, contentVersion, ensureCurrent } from './ensure-current';
import { API_BASE, API_OBJECT } from './service-api';
import { serviceSourceVersion } from './service';

/**
 * The label a registry entry carries.
 *
 * `barn.rancher.io/` because it is the only precedent in this codebase - it is on every
 * annotation this product writes (`source`, `authored`, `source-version`, `gh-token`) and was
 * kept through the rename because changing it would orphan objects already in clusters. A label
 * has no such constraint and could have used a fresher prefix, but a codebase with two
 * conventions is worse to work in than one with a single unfashionable one, and a reader
 * grepping for our keys should find all of them with one search.
 */
export const API_REGISTRY_LABEL = 'barn.rancher.io/api-registry';

/** What one extension says about the API it offers. */
export interface ApiEntry {
  /** Which extension this belongs to. */
  extension: string;
  /** What a person would call it. */
  title:     string;
  /** Where to call it, as a path on Rancher's own origin. */
  url:       string;
  /**
   * Where its documentation is, relative to `url` and joined by the reader.
   *
   * Relative on purpose: moving a service then means rewriting one field instead of two that
   * have to agree, and two fields that have to agree are two fields that eventually will not.
   */
  docs:      string;
  /** What is running, so a reader can tell an entry that has fallen behind from one that has not. */
  version:   string;
}

/**
 * One extension's registry object. One writer each - see the note at the top.
 *
 * `-api-registry` rather than the shorter `-api`, and the extra word is not decoration. The
 * Studio registers itself like anything else, its extension is `extension-studio`, and its
 * service source already lives in a ConfigMap called `extension-studio-api` in this namespace.
 * With the shorter suffix those are the same object: the first registration would have found a
 * ConfigMap that exists, seen a fingerprint that did not match, and replaced fifteen files of
 * running service source with five lines of registry entry. Silently, and then the service would
 * have failed to start on its next roll.
 */
export function apiRegistryObject(extension: string): string {
  return `${ extension }-api-registry`;
}

/** Join an entry's two halves the way every reader must, so nobody invents a third way. */
export function apiDocsUrl(entry: { url: string; docs: string }): string {
  return `${ entry.url.replace(/\/+$/, '') }/${ (entry.docs || '').replace(/^\/+/, '') }`;
}

export function apiRegistryBody(entry: ApiEntry): Record<string, unknown> {
  const data = {
    extension: entry.extension,
    title:     entry.title,
    url:       entry.url,
    docs:      entry.docs,
    version:   entry.version,
  };

  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      namespace:   EXT_NS,
      name:        apiRegistryObject(entry.extension),
      labels:      { [API_REGISTRY_LABEL]: 'true' },
      // An entry advertising a version that is not the one running is the same trap the service
      // source was in, so it is closed the same way: the entry carries a fingerprint of itself
      // and is replaced when this bundle would write something different.
      annotations: { [VERSION_ANNOTATION]: contentVersion([JSON.stringify(data)]) },
    },
    data,
  };
}

export function apiRegistryStep(entry: ApiEntry): InstallStep {
  return {
    id:          `api-registry-${ entry.extension }`,
    label:       `ConfigMap ${ apiRegistryObject(entry.extension) }`,
    description: `Says that ${ entry.extension } offers an API, and where to call it.`,
    type:        'configmaps',
    uiType:      'configmap',
    namespace:   EXT_NS,
    name:        apiRegistryObject(entry.extension),
    body:        () => apiRegistryBody(entry),
  };
}

/**
 * The Studio's own entry.
 *
 * `version` is the service source fingerprint rather than the extension's package version,
 * because the field exists for the mismatch case and this is the value that can actually be
 * checked: `GET /healthz` reports the same string, so "is the registry describing what is
 * running" is one unauthenticated request rather than a judgement.
 */
export function studioApiEntry(): ApiEntry {
  return {
    extension: API_OBJECT.replace(/-api$/, ''),
    title:     'Extension Studio API',
    url:       API_BASE,
    docs:      'openapi.json',
    version:   serviceSourceVersion(),
  };
}

/** Publish an entry, and keep it equal to what this bundle would write. */
export function ensureApiRegistration(entry: ApiEntry): Promise<void> {
  return ensureCurrent([apiRegistryStep(entry)]);
}

/**
 * Every entry in the registry, read straight from Kubernetes.
 *
 * The registry must not depend on the thing it registers, so this is a plain label-selected list
 * with no service involved: any client with RBAC to read these ConfigMaps can do exactly this,
 * and it keeps working when the service is down, which is precisely when somebody is looking for
 * a way to reach it.
 *
 * The apiserver's own path rather than Steve's, because Steve ignores `labelSelector` and would
 * return every ConfigMap in the namespace for the caller to filter. This is one call that
 * selects.
 */
export async function listApiEntries(): Promise<ApiEntry[]> {
  const selector = encodeURIComponent(`${ API_REGISTRY_LABEL }=true`);
  const list = await rancherFetch(
    `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/configmaps?labelSelector=${ selector }`,
  ).catch(() => null);

  return (list?.items || []).map((item: any) => entryOf(item)).filter(Boolean) as ApiEntry[];
}

/**
 * One ConfigMap as an entry, or null when it does not carry one.
 *
 * An object with the label but no `url` is not an entry a reader can do anything with. It is
 * dropped here rather than rendered empty, which is different from the service's `/v1/apis`
 * marking an entry whose URL does not answer: that one is a real entry that is broken, and
 * hiding it would be hiding the fault.
 */
function entryOf(item: any): ApiEntry | null {
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
