// What creating an extension is, said once, in the order it happens.
//
// The same list pkg/extension-studio/install.ts holds, and for the same reason: the install,
// the "what is already there" answer and the uninstall all read one list, so an object added
// to one of them cannot be forgotten by the other two.
//
// It is shorter than the browser's list by three steps, and the missing three are the browser
// pod, its Service and its scripts. That is not an omission. Those are the Studio's own
// plumbing for the whole namespace rather than any extension's, one exists for all of them,
// and DELETE here removes an extension's own objects - so a create that made the browser and a
// delete that left it standing would be a pair that does not balance. A cluster with no
// browser in it is a cluster where nobody has opened the Studio yet, and opening it makes one.
import {
  EXT_NS, EXT_ACCOUNT, EXT_ROLE_BINDING, extensionObject,
} from './names.mjs';
import {
  namespaceBody, serviceAccountBody, clusterRoleBindingBody, serviceBody, deploymentBody,
  seedConfigMapBody, EXT_PORTS,
} from './bodies.mjs';
import { createIfAbsent, objectState, removeObject } from './rancher.mjs';

/**
 * The cluster-wide half: made once, shared by every extension, and the part that outlives them.
 */
function sharedSteps() {
  return [
    {
      id:          'namespace',
      label:       `Namespace ${ EXT_NS }`,
      description: 'Holds everything this extension creates, so uninstalling it is one delete.',
      type:        'namespaces',
      name:        EXT_NS,
      body:        namespaceBody,
    },
    {
      id:          'serviceaccount',
      label:       `ServiceAccount ${ EXT_ACCOUNT }`,
      description: 'The identity every extension pod runs as, and what its terminal acts as.',
      type:        'serviceaccounts',
      namespace:   EXT_NS,
      name:        EXT_ACCOUNT,
      body:        serviceAccountBody,
    },
    {
      id:          'clusterrolebinding',
      label:       `ClusterRoleBinding ${ EXT_ROLE_BINDING }`,
      description: 'Grants that identity cluster-admin, without which a terminal gets 403 to every question about the cluster.',
      type:        'rbac.authorization.k8s.io.clusterrolebindings',
      name:        EXT_ROLE_BINDING,
      body:        clusterRoleBindingBody,
    },
  ];
}

/**
 * The tree one extension is seeded from, the pod that serves it, and the way in.
 *
 * `seed` is `{ data, annotations }` and may be null, because two callers want this list for
 * two reasons. A create has a seed and is going to write it. A state read has none and only
 * wants to know what exists, and it never calls a body. A null seed that reached a write is
 * therefore a bug in this file rather than bad input, and it says so.
 */
function extensionSteps(name, seed) {
  const object = extensionObject(name);

  return [
    {
      id:          `seed-${ name }`,
      label:       `ConfigMap ${ object }`,
      description: `The source ${ name } is seeded from, which is what a fresh pod writes its tree out of.`,
      type:        'configmaps',
      namespace:   EXT_NS,
      name:        object,
      body:        () => {
        if (!seed) {
          throw new Error(`no seed was resolved for ${ name }, so there is nothing to write into its ConfigMap`);
        }

        return seedConfigMapBody(name, seed.data, seed.annotations);
      },
    },
    {
      id:          `deployment-${ name }`,
      label:       `Deployment ${ object }`,
      description: `Runs the dev server that compiles ${ name } and pushes every save into the browser.`,
      type:        'apps.deployments',
      namespace:   EXT_NS,
      name:        object,
      body:        () => deploymentBody(name),
    },
    {
      id:          `service-${ name }`,
      label:       `Service ${ object }`,
      description: `How the dashboard reaches that dev server, through the apiserver's proxy on Rancher's own origin.`,
      type:        'services',
      namespace:   EXT_NS,
      name:        object,
      body:        () => serviceBody(object, EXT_PORTS),
    },
  ];
}

/** Everything that has to exist for `name` to be running. */
export function installSteps(name, seed = null) {
  return [...sharedSteps(), ...extensionSteps(name, seed)];
}

/**
 * What one step looks like to a caller: the step, minus the function only we can call.
 *
 * `status` is Rancher's, carried rather than summarised. Without it the two routes that report
 * per step stopped one field short of being useful: "unknown - Method GET not supported" reads
 * the same as a Rancher that was down or a proxy that timed out, and a caller deciding whether
 * to send somebody to log in, retry, or ask for access cannot tell those apart from prose.
 * Absent when there is no status to give, because a step that simply is not there has none.
 */
function reportable(step, state, error, status) {
  return {
    id:          step.id,
    label:       step.label,
    description: step.description,
    type:        step.type,
    namespace:   step.namespace || null,
    name:        step.name,
    state,
    ...(error ? { error } : {}),
    ...(status ? { status } : {}),
  };
}

/**
 * Do the install as the caller, reporting each step.
 *
 * Sequential on purpose: the namespace has to exist before anything can be made in it, and the
 * account has to exist before a pod can be told to run as it.
 *
 * Nothing here throws. A step that fails is reported as failed and the rest still run, because
 * one object that could not be made is not a reason to leave the other five unmade - and the
 * caller gets a list saying exactly which one it was, which is more use than a 500.
 *
 * That reasoning is about a write that failed on one object, and it stops being true when every
 * step failed the same way. The caller's route decides what to do about that; this list carries
 * the status each step failed with so it can. See handlers.mjs raiseIfWhollyRefused.
 */
export async function runInstall(cred, name, seed) {
  const out = [];

  for (const step of installSteps(name, seed)) {
    try {
      const result = await createIfAbsent(cred, step);

      out.push(reportable(step, result === 'created' ? 'created' : 'present'));
    } catch (e) {
      out.push(reportable(step, 'failed', e?.message || String(e), e?.status || 0));
    }
  }

  return out;
}

/**
 * What is already there, without making anything.
 *
 * Three states, not two, and the third is the one that matters. This route creates nothing, so
 * it has no second attempt to fall back on the way runInstall does: a read it was refused is
 * the whole of what it knows about that step, and it has to say so. Reported as 'unknown' with
 * the reason rather than as 'missing', because an ordinary Rancher user is refused the read of
 * the shared namespace - Steve answers 403 there, not 404 - and six steps reported missing to
 * them is an invitation to reinstall a namespace that is already holding every extension in the
 * cluster.
 *
 * Per step rather than one 403 for the route, because the answer is genuinely mixed: the same
 * caller can be refused the ClusterRoleBinding and shown the Deployment, and the list says which
 * was which. Rancher's status travels with the reason, because "unknown" is only actionable if
 * a caller can tell a 403 they should ask for access about from a 502 they should retry.
 */
export async function installState(cred, name) {
  return Promise.all(installSteps(name).map(async(step) => {
    const found = await objectState(cred, step);

    return found.state === 'unknown'
      ? reportable(step, 'unknown', found.error, found.status)
      : reportable(step, found.state === 'present' ? 'present' : 'missing');
  }));
}

/**
 * Remove one extension's own objects, and only its own.
 *
 * The shared three are left alone: the namespace holds every other extension, and deleting a
 * ClusterRoleBinding because one extension went away would break all of them. Reverse order,
 * so the Deployment stops before the ConfigMap it mounts disappears from under it.
 */
export async function runUninstall(cred, name) {
  const steps = extensionSteps(name, null).reverse();
  const out = [];

  for (const step of steps) {
    try {
      out.push(reportable(step, await removeObject(cred, step) === 'deleted' ? 'deleted' : 'absent'));
    } catch (e) {
      out.push(reportable(step, 'failed', e?.message || String(e), e?.status || 0));
    }
  }

  return out;
}
