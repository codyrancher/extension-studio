// The Extension Studio API, as objects in a cluster.
//
// What the service does is in extension-skeleton/pod/service/. This is where it comes from: a
// ConfigMap holding that source, a Deployment running node over it, and a Service in front. The
// same three objects an extension is made of, made the same way, and expressed as InstallSteps
// so that creating them is the read-before-write loop install.ts already runs rather than a
// second, slightly different one written here.
//
// There is no image. node:24 with the source mounted at /seed is what every extension pod in
// this namespace already is, and it means there is nothing to publish, nothing to version and
// nothing that can be older than this file. The cost is that the source has to travel in a
// ConfigMap, which is why it is small and has no dependencies.
import type { InstallStep } from './install';
import { EXT_NS, EXT_ACCOUNT, EXT_IMAGE, serviceBody } from './extensions';
import { VERSION_ANNOTATION, contentVersion, ensureCurrent } from './ensure-current';
import { SERVICE_FILES } from './extension-seed.generated';
import { API_OBJECT, API_PORT, API_PORTS } from './service-api';

/** The container, named because a terminal into this pod has to say which one. */
const API_CONTAINER = 'api';

/**
 * The service's source, taken out of the bundle it travels in.
 *
 * Its own file set rather than a prefix inside every extension's seed, because it is mounted
 * into one pod rather than into every pod: see the note beside SERVICE_FILES. Read here rather
 * than imported directly because a browser bundle cannot import a .mjs that opens with
 * node:tls, and inlining the sources as template strings is the duplication this product has
 * been bitten by twice.
 */
export function serviceSourceFiles(): Record<string, string> {
  return { ...SERVICE_FILES };
}

/**
 * A short fingerprint of the source above, so a cluster can be asked whether it is running it.
 *
 * The reason this exists is the failure it replaces. `ensureService` created the objects when
 * they were absent and did nothing when they were present, which meant a cluster kept whatever
 * source it was first given for ever - and since every screen now reads through the service,
 * that is a Studio quietly running last month's code with no way to tell. There was no signal
 * either: /healthz answered `ok` and said nothing about what it was.
 *
 * So the fingerprint goes three places: on the ConfigMap, on the Deployment (which is where
 * ensureCurrent looks) and on its pod template (which is what makes a changed source actually
 * roll the pod rather than sit in a mounted volume nothing re-reads), and into the pod's
 * environment, where /healthz reports it.
 */
export function serviceSourceVersion(): string {
  const files = serviceSourceFiles();

  return contentVersion(Object.keys(files).sort().flatMap((key) => [key, files[key]]));
}

export function apiConfigMapBody(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      namespace:   EXT_NS,
      name:        API_OBJECT,
      labels:      { app: API_OBJECT },
      annotations: { [VERSION_ANNOTATION]: serviceSourceVersion() },
    },
    data: serviceSourceFiles(),
  };
}

export function apiDeploymentBody(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   {
      namespace: EXT_NS,
      name:      API_OBJECT,
      labels:    { app: API_OBJECT },
      // On the Deployment itself as well as on its pod template, and the two are for different
      // readers. This one is what `replaceIfStale` compares, so leaving it off meant the
      // ConfigMap was updated and the Deployment was not - which is worse than doing nothing,
      // because the source in the cluster then differs from the source in the running pod and
      // /healthz still reports the old fingerprint it was started with.
      annotations: { [VERSION_ANNOTATION]: serviceSourceVersion() },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: API_OBJECT } },
      template: {
        metadata: {
          labels: { app: API_OBJECT },
          // On the template, not just on the Deployment: a ConfigMap that changes under a
          // running pod is not re-read by node, which imported its modules at start. Changing
          // an annotation here is what makes Kubernetes replace the pod, and replacing the pod
          // is what makes the new source run.
          annotations: { [VERSION_ANNOTATION]: serviceSourceVersion() },
        },
        spec: {
          // The same account every pod here runs as, and deliberately unused: nothing in the
          // service reads its token. It is here because a pod has to run as something, and
          // giving this one an account of its own would suggest the service acts as itself.
          serviceAccountName: EXT_ACCOUNT,
          containers:         [{
            name:    API_CONTAINER,
            image:   EXT_IMAGE,
            command: ['node', '/seed/main.mjs'],
            ports:   [{ name: 'http', containerPort: API_PORT }],
            env:     [
              { name: 'PORT', value: `${ API_PORT }` },
              // What /healthz reports, so "which build is this cluster running" is one
              // unauthenticated request rather than a diff of a ConfigMap against a bundle.
              { name: 'API_SOURCE_VERSION', value: serviceSourceVersion() },
              // The node's address, which is Rancher's: this cluster is k3s inside the Rancher
              // container. Declared before RANCHER_URL because Kubernetes expands $(VAR) only
              // against variables already listed.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              { name: 'RANCHER_URL', value: 'https://$(NODE_IP)' },
              // Rancher serves a certificate for its own name and is reached here by address,
              // so there is nothing verification could succeed against. The browser pod says
              // the same thing as --ignore-certificate-errors. It is scoped to this process,
              // which talks to exactly one host.
              { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
            ],
            volumeMounts: [{ name: 'seed', mountPath: '/seed' }],
            // Liveness on /healthz rather than readiness alone: the whole point of that route
            // needing no credential is that a probe has none to give it.
            readinessProbe: {
              httpGet:       { path: '/healthz', port: API_PORT },
              periodSeconds: 10,
            },
            livenessProbe: {
              httpGet:             { path: '/healthz', port: API_PORT },
              periodSeconds:       20,
              initialDelaySeconds: 10,
            },
          }],
          volumes: [{ name: 'seed', configMap: { name: API_OBJECT } }],
        },
      },
    },
  };
}

/**
 * The three objects, in the order they have to be made.
 *
 * The ConfigMap first: a Deployment whose seed volume names a ConfigMap that does not exist
 * schedules a pod that never starts, and the event that says so is on the pod rather than on
 * anything the installer is watching.
 */
export function serviceSteps(): InstallStep[] {
  return [
    {
      id:          'api-source',
      label:       `ConfigMap ${ API_OBJECT }`,
      description: 'The service itself, as source. There is no image, so this is the only copy of it in the cluster.',
      type:        'configmaps',
      uiType:      'configmap',
      namespace:   EXT_NS,
      name:        API_OBJECT,
      body:        apiConfigMapBody,
    },
    {
      id:          'api-deployment',
      label:       `Deployment ${ API_OBJECT }`,
      description: 'Runs that source on stock node, so extensions can be created and exec\'d into by anything that can make an HTTP request.',
      type:        'apps.deployments',
      uiType:      'apps.deployment',
      namespace:   EXT_NS,
      name:        API_OBJECT,
      body:        apiDeploymentBody,
    },
    {
      id:          'api-service',
      label:       `Service ${ API_OBJECT }`,
      description: 'How anything in the cluster reaches it, and what the apiserver service proxy resolves for a caller outside.',
      type:        'services',
      uiType:      'service',
      namespace:   EXT_NS,
      name:        API_OBJECT,
      body:        () => serviceBody(API_OBJECT, API_PORTS),
    },
  ];
}

/**
 * Make the service exist, and make it the source this bundle carries.
 *
 * Create-if-missing is not enough here, and that is the point of the version check. The browser
 * is created once and left alone deliberately - replacing it throws away the Rancher session in
 * its profile and whatever page somebody was looking at - but the service holds no state at all,
 * and every screen in the Studio now reads through it. A cluster left running an older copy of
 * it is a Studio whose behaviour does not match the code anybody is reading.
 *
 * Called when the bundle loads, in front of a page, on behalf of somebody who may not be allowed
 * to create or update any of it - so it swallows what goes wrong, and the screens that need the
 * service say so themselves when it is not there.
 */
let ensureServiceInFlight: Promise<void> | null = null;

export function ensureService(): Promise<void> {
  if (ensureServiceInFlight) {
    return ensureServiceInFlight;
  }

  ensureServiceInFlight = ensureCurrent(serviceSteps()).finally(() => {
    ensureServiceInFlight = null;
  });

  return ensureServiceInFlight;
}
