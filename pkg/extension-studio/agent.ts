// The agent pod: one claude in the cluster, reachable from every page.
//
// Not one agent per extension. The extension pods already have one each, pointed at one tree
// and knowing about one extension. This is the other thing you want when something is wrong -
// somebody who can see all of them at once, ask the cluster a question, and read the Studio's
// own API document - and it has to be reachable from wherever you noticed, which is usually a
// Rancher page that has nothing to do with the Studio.
//
// It is made the way the service is made: a ConfigMap holding the pod's source, a Deployment
// running stock node over it, and both fingerprinted so a cluster running last month's copy is
// replaced rather than left alone. There is no Service, because nothing here is served - the
// only way in is the exec subresource, which addresses a pod.
//
// Its terminal is PodTerminal, unchanged, and its panes are the same shell.sh, tmux and claude
// loop an extension's are. The differences are exactly two: the boot script starts no dev
// server, and the CLAUDE.md a session opens with describes the namespace instead of a tree.
import type { InstallStep } from './install';
import { EXT_NS, EXT_ACCOUNT, EXT_IMAGE, EXT_BASE, execUrl, podExecResult } from './extensions';
import { VERSION_ANNOTATION, contentVersion, ensureCurrent } from './ensure-current';
import { AGENT_FILES } from './extension-seed.generated';
import { rancherFetch } from './api';

/** One name for the ConfigMap and the Deployment. There is no third object. */
export const AGENT_OBJECT = 'extension-studio-agent';

/**
 * The container, which is not called what an extension's is.
 *
 * `devserver` would be a lie - nothing is served from this pod - and the lie would be
 * load-bearing, because a terminal names the container in its exec URL. It is named here, once,
 * and both the Deployment that creates it and the two callers below read it from here.
 */
const AGENT_CONTAINER = 'agent';

/**
 * Where the node keeps this pod's conversations and its claude login between restarts.
 *
 * Beside the extension trees rather than inside one, and named for what it is: an extension's
 * directory is claimed by that extension's name, and the agent is not an extension.
 */
const AGENT_HOST_PATH = '/var/lib/rancher/extension-studio/agent';

/** Where those conversations live inside the pod. Mirrors hostCachePath's role for /app. */
const AGENT_WORKSPACE = '/workspace';

/** The source this pod runs, taken out of the bundle it travels in. */
export function agentSourceFiles(): Record<string, string> {
  return { ...AGENT_FILES };
}

/**
 * A fingerprint of that source, for the same reason the service has one.
 *
 * A pod created once and then left alone keeps whatever source it was first given for ever, and
 * nothing reports the mismatch. It goes on the ConfigMap, on the Deployment (which is what
 * ensureCurrent compares) and on the pod template (which is what makes a changed script
 * actually roll the pod, since /seed is a mounted volume nothing re-reads).
 */
export function agentSourceVersion(): string {
  const files = agentSourceFiles();

  return contentVersion(Object.keys(files).sort().flatMap((key) => [key, files[key]]));
}

export function agentConfigMapBody(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      labels:      { app: AGENT_OBJECT },
      annotations: { [VERSION_ANNOTATION]: agentSourceVersion() },
    },
    data: agentSourceFiles(),
  };
}

export function agentDeploymentBody(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   {
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      labels:      { app: AGENT_OBJECT },
      annotations: { [VERSION_ANNOTATION]: agentSourceVersion() },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: AGENT_OBJECT } },
      // Recreate, like an extension's and for the same reason: /workspace is a hostPath, and two
      // pods would be two tmux servers writing one set of conversation directories.
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels:      { app: AGENT_OBJECT },
          annotations: { [VERSION_ANNOTATION]: agentSourceVersion() },
        },
        spec: {
          // The same account every pod here runs as, and here it is used rather than declared:
          // kubectl in a pane reads its token, and being able to answer a question about the
          // cluster is most of what this pod is for. See EXT_ACCOUNT for what that grants, and
          // agent-overlay.ts for why the way in is offered to admins only.
          serviceAccountName: EXT_ACCOUNT,
          containers:         [{
            name:    AGENT_CONTAINER,
            image:   EXT_IMAGE,
            command: ['/bin/sh', '/seed/boot.sh'],
            env:     [
              // Rancher's address from inside the cluster, which is the node's: this cluster is
              // k3s inside the Rancher container. Declared before RANCHER_URL because Kubernetes
              // expands $(VAR) only against variables already listed.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              { name: 'RANCHER_URL', value: 'https://$(NODE_IP)' },
              // Where the Studio's own API answers, so the CLAUDE.md can tell the agent to read
              // its OpenAPI document rather than describe the routes and go stale.
              { name: 'EXTENSION_STUDIO_API', value: 'http://extension-studio-api:8006' },
            ],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed' },
              { name: 'workspace', mountPath: AGENT_WORKSPACE },
            ],
            // No probes. There is no port and nothing to ask; a pod with neither is Ready as
            // soon as it is Running, which for this one is the truth.
          }],
          volumes: [
            { name: 'seed', configMap: { name: AGENT_OBJECT } },
            { name: 'workspace', hostPath: { path: AGENT_HOST_PATH, type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  };
}

/** The two objects, in the order they have to be made: a Deployment naming an absent ConfigMap never starts. */
export function agentSteps(): InstallStep[] {
  return [
    {
      id:          'agent-source',
      label:       `ConfigMap ${ AGENT_OBJECT }`,
      description: 'What the agent pod runs, as source. There is no image, so this is the only copy of it in the cluster.',
      type:        'configmaps',
      uiType:      'configmap',
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      body:        agentConfigMapBody,
    },
    {
      id:          'agent-deployment',
      label:       `Deployment ${ AGENT_OBJECT }`,
      description: 'The one claude that can see every extension, which the global terminal opens into.',
      type:        'apps.deployments',
      uiType:      'apps.deployment',
      namespace:   EXT_NS,
      name:        AGENT_OBJECT,
      body:        agentDeploymentBody,
    },
  ];
}

/**
 * Make the agent pod exist, and make it the source this bundle carries.
 *
 * Called when the bundle loads, in front of a page, on behalf of somebody who may not be allowed
 * to create any of it - so it swallows what goes wrong. The overlay says so itself when there is
 * no pod to open into.
 */
let ensureAgentInFlight: Promise<void> | null = null;

export function ensureAgent(): Promise<void> {
  if (ensureAgentInFlight) {
    return ensureAgentInFlight;
  }

  ensureAgentInFlight = ensureCurrent(agentSteps()).finally(() => {
    ensureAgentInFlight = null;
  });

  return ensureAgentInFlight;
}

/**
 * The running agent pod, or null while there isn't one.
 *
 * `Running` rather than `Ready` is not the distinction it is for an extension - this pod has no
 * probes - but the shape is the same as extensionPod's on purpose, because the terminal polls
 * this the same way and a first boot is still installing tmux and claude for a minute or two.
 */
export async function agentPod(): Promise<string | null> {
  const pods = await rancherFetch(`${ EXT_BASE }/v1/pods/${ EXT_NS }`).catch(() => null);

  const running = (pods?.data || []).find((pod: any) => (
    pod.metadata?.labels?.app === AGENT_OBJECT &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

/** Where one conversation's files live. One directory per session, because claude keys its history by directory. */
function sessionDir(session: string): string {
  return `${ AGENT_WORKSPACE }/sessions/${ session }`;
}

/**
 * WebSocket URL for one conversation in the agent pod.
 *
 * The same shell.sh an extension's terminal runs, given a directory of its own and this pod's
 * durable home. The arguments are positional (session, directory, home, mode) and none of them
 * can be skipped, which is why the third is spelled out rather than left to shell.sh's default -
 * that default is /app, and this pod has no /app.
 */
export function agentShellUrl(pod: string, session: string, mode = 'claude'): string {
  return execUrl(
    pod,
    ['/bin/sh', '/seed/shell.sh', session, sessionDir(session), `${ AGENT_WORKSPACE }/.home`, mode],
    true,
    AGENT_CONTAINER,
  );
}

/**
 * Every conversation the pod is holding.
 *
 * Asked of the pod rather than remembered in the browser, and that is the whole design of the
 * tab strip. A conversation outlives the tab that opened it, so a second browser tab, a reload,
 * or a different person's session all have to see the same list - and the only place that list
 * exists is tmux.
 *
 * An empty list is the honest answer for a pod that is still installing tmux, so this reports
 * nothing rather than throwing: the terminal itself already says when the pod is not up.
 */
export async function agentSessions(): Promise<string[]> {
  const pod = await agentPod();

  if (!pod) {
    return [];
  }

  // Short, because this runs when a panel opens and a person is waiting for it. A pod still
  // installing answers instantly with nothing, which is correct.
  const result = await podExecResult(pod, ['/bin/sh', '/seed/sessions.sh'], 15000, AGENT_CONTAINER);

  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * End one conversation.
 *
 * Killing the tmux session rather than just dropping the socket, because the list above comes
 * from the pod: a close that left the session running would be a tab that reappeared on the next
 * refresh, which is a control that does nothing. Closing the panel is the thing that leaves
 * everything running, and that is the persistence this is all built on.
 */
export async function endAgentSession(session: string): Promise<void> {
  const pod = await agentPod();

  if (!pod) {
    return;
  }

  // Through the same script the listing uses, because both have to run as the node user whose
  // tmux server this is, and the exec subresource arrives as root.
  await podExecResult(pod, ['/bin/sh', '/seed/sessions.sh', session], 15000, AGENT_CONTAINER);
}
