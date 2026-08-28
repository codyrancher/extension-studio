// The Kubernetes objects an extension is made of.
//
// The other copy of these is pkg/extension-studio/extensions.ts, and the reason for the
// duplication is in names.mjs. Everything that has to agree between them is a constant, and
// every one of those constants is drift-checked, so what is left here is shape rather than
// fact: if this ever produces a Deployment the browser would not have produced, the difference
// will be a field, and a field is visible in `kubectl get -o yaml`.
import {
  EXT_NS, EXT_ACCOUNT, EXT_ROLE_BINDING, EXT_CONTAINER, EXT_IMAGE, EXT_PORT,
  BROWSER_OBJECT, BROWSER_CDP_PORT, PATH_SEPARATOR, extensionObject, extensionProxyPath,
  hostCachePath,
} from './names.mjs';

/** The namespace everything here lives in. */
export function namespaceBody() {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: EXT_NS } };
}

/** The identity every extension pod runs as. */
export function serviceAccountBody() {
  return { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { namespace: EXT_NS, name: EXT_ACCOUNT } };
}

/**
 * The grant, which is cluster-admin.
 *
 * Said plainly because it is real: anyone who can open a terminal in one of these pods can do
 * anything in this cluster. It is not widened by this service, which cannot create it for
 * somebody who is not already allowed to create it - see credential.mjs.
 */
export function clusterRoleBindingBody() {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: EXT_ROLE_BINDING },
    roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    subjects:   [{ kind: 'ServiceAccount', name: EXT_ACCOUNT, namespace: EXT_NS }],
  };
}

/** The ClusterIP the apiserver's service proxy resolves to. */
export function serviceBody(object, ports) {
  return {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { namespace: EXT_NS, name: object, labels: { app: object } },
    spec:       { selector: { app: object }, ports },
  };
}

export const EXT_PORTS = [{ name: 'http', port: EXT_PORT, targetPort: 'http' }];

/** A tree of real paths as ConfigMap keys, flattened the way boot.sh un-flattens them. */
export function seedData(files) {
  const data = {};

  for (const [filePath, contents] of Object.entries(files || {})) {
    data[filePath.split('/').join(PATH_SEPARATOR)] = contents;
  }

  return data;
}

/**
 * The seed an extension's pod writes its tree out of.
 *
 * `data` is already in ConfigMap shape, because the usual caller copied it off another
 * extension's seed rather than building it. Annotations come across with it: they record what
 * the extension was seeded from and which of its files were authored rather than seeded, and a
 * copy that dropped them would produce an extension whose next re-seed overwrites the answers
 * somebody wrote into it.
 */
export function seedConfigMapBody(name, data, annotations = {}) {
  const object = extensionObject(name);

  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      namespace: EXT_NS,
      name:      object,
      labels:    { app: object },
      annotations,
    },
    data,
  };
}

/** The dev server: plain node over the seeded tree, which is why there is no image to build. */
export function deploymentBody(name) {
  const object = extensionObject(name);

  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace: EXT_NS, name: object, labels: { app: object } },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: object } },
      // Recreate, not RollingUpdate: /app is a hostPath, so two dev servers would be watching
      // and rebuilding the same tree at the same time.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: object } },
        spec:     {
          serviceAccountName: EXT_ACCOUNT,
          containers:         [{
            name:    EXT_CONTAINER,
            image:   EXT_IMAGE,
            command: ['/bin/sh', '/seed/boot.sh'],
            ports:   [{ name: 'http', containerPort: EXT_PORT }],
            env:     [
              { name: 'DEV_PROXY_PATH', value: extensionProxyPath(name) },
              { name: 'EXTENSION_NAME', value: name },
              { name: 'NODE_ENV', value: 'dev' },
              { name: 'BARN_BROWSER_SERVICE', value: BROWSER_OBJECT },
              { name: 'BARN_BROWSER_CDP_PORT', value: `${ BROWSER_CDP_PORT }` },
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              // A dashboard build is big enough to OOM node's default heap.
              { name: 'NODE_OPTIONS', value: '--max_old_space_size=4096' },
            ],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed' },
              { name: 'app', mountPath: '/app' },
            ],
            // Installing and the first compile take minutes. A long startup budget is what
            // keeps the kubelet from restarting a pod that is working fine, and restarting it
            // would throw away a part-finished install.
            startupProbe: {
              httpGet:          { path: '/index.html', port: EXT_PORT },
              periodSeconds:    10,
              failureThreshold: 90,
            },
            readinessProbe: {
              httpGet:       { path: '/index.html', port: EXT_PORT },
              periodSeconds: 10,
            },
          }],
          volumes: [
            { name: 'seed', configMap: { name: object } },
            { name: 'app', hostPath: { path: hostCachePath(name), type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  };
}
