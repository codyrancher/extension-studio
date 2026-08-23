// What the Studio is configured with, and the one place that reads or writes it.
//
// The design's screen 09 is "connection, permissions, access and data in one place", and "in
// one place" has to be true of the code as well as of the page: a settings page and a dialog
// that each wrote the same Secret in their own way is how a token gets replaced while the
// account named next to it stays the old one. So both surfaces call in here.
//
// Where things live, and why they live in two objects rather than one:
//
//   - The GitHub credential is in Secret `barn-settings` (extensions.ts owns it). It is
//     write-only: it goes in, it never comes back out to a page, and `readSettings` answers
//     only whether one is stored.
//   - Everything else is in ConfigMap `barn-studio-settings` in the same namespace, one JSON
//     key. That includes what GitHub said about the credential when it was stored - the account
//     and its scopes, which are not secret and are the whole of what the design's
//     "Connected as ..." row shows. Keeping them out of the Secret is what lets the page name
//     the account without ever reading the credential back.
//
// The same shape review.ts uses for its own record, and for the same reasons: one object, one
// key, read-modify-write with the object that was read so a second tab gets a 409 rather than
// silently winning.
import { rancherFetch } from './api';
import {
  EXT_NS, DEFAULT_EXTENSION, extensionObject, githubIdentity, readSettings, saveSettings
} from './extensions';

// The cluster every object in this product lives in. Written out rather than imported because
// `extensions.ts` does not export it, and review.ts already does the same.
const EXT_BASE = '/k8s/clusters/local';

/** One ConfigMap for the Studio's own settings, one key in it. */
export const SETTINGS_OBJECT = 'barn-studio-settings';
const SETTINGS_KEY = 'settings.json';

/** Off / Notified / Required: the three values every cell of the sign-off matrix can hold. */
export const LEVELS = [
  { value: 'off', label: 'Off' },
  { value: 'notified', label: 'Notified' },
  { value: 'required', label: 'Required' },
];

export interface SignoffPolicy {
  code:    string;
  outcome: string;
}

/** What each editable row starts at, which is what the design draws it at. */
export const DEFAULT_POLICY: Record<string, SignoffPolicy> = {
  'dev-load': { code: 'off', outcome: 'off' },
  repo:       { code: 'required', outcome: 'notified' },
};

/**
 * What GitHub said about the stored credential at the moment it was stored.
 *
 * Never the credential. `authorised` is when this Studio stored it, not when GitHub issued it,
 * and it is named for what it is on the screen rather than for what the design's caption says.
 */
export interface GithubConnection {
  login:      string;
  scopes:     string;
  authorised: string;
}

export interface StudioSettings {
  policy: Record<string, SignoffPolicy>;
  github: GithubConnection | null;
  /**
   * The Rancher role the access card is currently asking about, remembered so the answer is
   * still there after a reload. A question rather than a grant: see `readRole` below.
   */
  customRole: string;
}

interface StoredSettings extends StudioSettings {
  /** The object as the apiserver handed it over, for the write that follows. */
  object: any;
}

/** Absent, unreadable and invalid all read as "nothing set yet". */
export async function readStudioSettings(): Promise<StoredSettings> {
  const object = await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ SETTINGS_OBJECT }`).catch(() => null);
  let parsed: any = {};

  try {
    parsed = JSON.parse(object?.data?.[SETTINGS_KEY] || '{}');
  } catch {
    // Hand-edited into invalid JSON reads as nothing set. The next write replaces it, and it is
    // not worth taking a page down for.
    parsed = {};
  }

  return {
    object,
    policy: {
      'dev-load': { ...DEFAULT_POLICY['dev-load'], ...(parsed.policy?.['dev-load'] || {}) },
      repo:       { ...DEFAULT_POLICY.repo, ...(parsed.policy?.repo || {}) },
    },
    github:     parsed.github || null,
    customRole: parsed.customRole || '',
  };
}

/**
 * Read, change, write - PUT with the object that was read, resourceVersion and all, so a second
 * tab writing between the two gets a 409 rather than silently losing this one.
 */
export async function writeStudioSettings(
  change: (current: StudioSettings) => StudioSettings
): Promise<StudioSettings> {
  const current = await readStudioSettings();
  const next = change({ policy: current.policy, github: current.github, customRole: current.customRole });
  const data = { [SETTINGS_KEY]: JSON.stringify(next, null, 2) };

  if (current.object) {
    await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ SETTINGS_OBJECT }`, {
      method: 'PUT',
      body:   JSON.stringify({ ...current.object, data }),
    });
  } else {
    await rancherFetch(`${ EXT_BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { name: SETTINGS_OBJECT, namespace: EXT_NS },
        data,
      }),
    });
  }

  return next;
}

/**
 * Git's own words, and the pod's, arrive lowercase and unpunctuated. A card is prose.
 *
 * The same helper `ImportExtensionModal` uses, so a refusal reads the same wherever it is
 * shown. It lives here rather than in either surface because this module is already the one
 * place the GitHub connection is handled from.
 */
export function asSentence(text: string): string {
  return text ? `${ text[0].toUpperCase() }${ text.slice(1) }`.replace(/\.?$/, '.') : '';
}

/**
 * A refusal from GitHub, said in words.
 *
 * `githubApiAnywhere` throws the status followed by the first 200 characters of GitHub's body,
 * which is the right thing to carry back from the pod and the wrong thing to put in front of a
 * reader: a rejected token arrives as `401 { "message": "Bad credentials", "documentation_url":
 * ... }` flattened onto one line. So the status and GitHub's own `message` are pulled out and
 * the rest is dropped. The body is truncated, so it is read with a pattern rather than parsed -
 * a cut-off JSON object does not parse, and a token being rejected is exactly the sentence
 * worth keeping.
 *
 * Anything that is not a status is left alone. "No GitHub token is configured" and "no extension
 * pod is running to ask GitHub from" are this product's own words and already read as prose.
 */
export function githubErrorText(message: string): string {
  const text = String(message || '').trim();
  const status = /^(\d{3})\b/.exec(text);

  if (!status) {
    return text;
  }

  const said = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const detail = said ? said[1] : '';
  const because = detail ? ` (${ detail })` : '';

  if (status[1] === '401') {
    return `GitHub rejected the token${ because }.`;
  }

  if (status[1] === '403') {
    return `GitHub refused the call${ because }.`;
  }

  return `GitHub answered ${ status[1] }${ because }.`;
}

/**
 * A date, in the reader's own format.
 *
 * GitHub writes the expiry header as `2026-10-18 12:00:00 UTC`, which Date can read; anything it
 * cannot is passed through rather than shown as "Invalid Date".
 */
function asDay(value: string): string {
  const at = Date.parse(value || '');

  return at ? new Date(at).toLocaleDateString() : String(value || '');
}

/** What `githubIdentity()` answers with. Structural, so this module need not import the type. */
export interface GithubIdentityLike {
  login:     string;
  scopes:    string[];
  expiresAt: string;
}

/**
 * The line under "Connected as ...": scopes, expiry, and when this Studio stored it.
 *
 * Shared by the settings page and the dialog rather than written twice, because the two used to
 * say different things about the same credential - the dialog claimed Studio could not name the
 * account at all, which stopped being true when `githubIdentity()` learned to ask a pod.
 *
 * What GitHub said a moment ago comes first and the record made when the token was pasted is the
 * fallback, because only the second one is limited to tokens that went in through this Studio.
 */
export function connectionSummary(identity: GithubIdentityLike | null, connection: GithubConnection | null): string {
  const parts: string[] = [];
  const scopes = identity ? identity.scopes.join(', ') : (connection?.scopes || '');

  if (scopes) {
    parts.push(`Scopes: ${ scopes }`);
  } else if (identity) {
    // A fine-grained token lists no scopes at all, which is a fact about the token rather than a
    // gap in the reading.
    parts.push('Scopes: none listed, which is what a fine-grained token reports');
  }

  if (identity?.expiresAt) {
    parts.push(`expires ${ asDay(identity.expiresAt) }`);
  } else if (identity) {
    parts.push('no expiry date');
  }

  if (connection?.authorised) {
    parts.push(`stored ${ new Date(connection.authorised).toLocaleDateString() }`);
  }

  return parts.join(' · ');
}

/**
 * Whether GitHub answered about the token and the answer was no.
 *
 * A 401 or a 403 is GitHub saying the credential is bad. Anything else - no egress from the pod,
 * no pod at all, a timeout - is nobody having asked, which is a different sentence and must not
 * be shown as the same one.
 */
export function tokenRejected(message: string): boolean {
  return /\b40[13]\b/.test(String(message || ''));
}

/** Thrown when GitHub says the token is no good, which is the one case where nothing is stored. */
export class TokenRejected extends Error {}

export interface ConnectResult {
  connection: GithubConnection | null;
  /** True when the token was stored without GitHub being reachable to say whose it is. */
  unchecked: boolean;
}

/**
 * Store a pasted token, and record what GitHub says it is.
 *
 * The credential stays write-only: it goes into the Secret and no page reads it back. What this
 * does is spend it once, here, at the only moment anything legitimately has it, and keep the
 * answer - the account and its scopes are not secret, and they are what the design's
 * "Connected as ..." row is made of.
 *
 * Three outcomes, and they are different on purpose. GitHub rejects it: nothing is stored and
 * this throws, because storing a credential that is already known not to work is worse than
 * refusing it. GitHub cannot be reached from the browser: it is stored anyway, because a browser
 * with no egress is not evidence about the token, and a pod is asked instead - a pod can reach
 * GitHub and can read the Secret, so the account is usually recorded even then. GitHub answers:
 * stored, with the account.
 *
 * The recorded connection is always replaced, including with `null`, so a new token can never
 * leave the previous token's account name on the screen.
 */
export async function connectGithub(token: string): Promise<ConnectResult> {
  let connection: GithubConnection | null = null;
  let unchecked = false;

  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${ token }`,
        Accept:        'application/vnd.github+json',
      },
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new TokenRejected('GitHub rejected that token, so it has not been stored.');
    }

    if (resp.ok) {
      const user = await resp.json();

      connection = {
        login: user?.login || '',
        // GitHub's CORS policy exposes the scopes header to a browser. It does not expose the
        // expiry header, which is why the expiry is read by `githubIdentity` from a pod rather
        // than recorded here.
        scopes:     resp.headers.get('x-oauth-scopes') || '',
        authorised: new Date().toISOString(),
      };
    } else {
      unchecked = true;
    }
  } catch (e) {
    if (e instanceof TokenRejected) {
      throw e;
    }

    // No egress to github.com from this browser. Not a reason to refuse the credential.
    unchecked = true;
  }

  await saveSettings('', { token });

  // The browser could not be told whose token this is - either GitHub was unreachable from it
  // or CORS stopped the answer being read. A pod can ask, and now that the token is in the
  // Secret it can read it, so the account is recorded from there instead of being left blank.
  // The token still never comes back into the browser: what returns is what GitHub said.
  if (!connection) {
    connection = await githubIdentity()
      .then((who) => (who ? {
        login:      who.login,
        scopes:     who.scopes.join(', '),
        authorised: new Date().toISOString(),
      } : null))
      .catch(() => null);

    unchecked = !connection;
  }

  await writeStudioSettings((current) => ({ ...current, github: connection }));

  return { connection, unchecked };
}

/**
 * Remove the credential, now, on one click, with nothing to press afterwards.
 *
 * The dialog this replaced armed the removal and applied it on Save, which left the screen
 * disagreeing with the cluster until a second button was found.
 */
export async function disconnectGithub(): Promise<void> {
  await saveSettings('', { token: '' });
  await writeStudioSettings((current) => ({ ...current, github: null }));
}

/** Whether a credential is stored. The one thing about it that is not secret. */
export async function githubConnected(): Promise<boolean> {
  return (await readSettings('')).hasToken;
}

export interface AssistantPermission {
  /** ask-every-edit | edit-freely | never-ask, or '' when it could not be read. */
  level:  string;
  detail: string;
}

/**
 * Which permission level the assistant is actually running at, read from the thing that decides.
 *
 * The pod starts claude from `claude-session.sh`, seeded into the extension's own ConfigMap, so
 * the answer is in an object a page can GET rather than in a sentence somebody typed into a
 * template. Reading it means the card stops being wrong the moment the pod changes, which a
 * hardcoded string would not.
 */
export async function detectPermission(): Promise<AssistantPermission> {
  const object = extensionObject(DEFAULT_EXTENSION);
  const cm = await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ object }`).catch(() => null);
  const script = cm?.data?.['claude-session.sh'] || '';

  if (!script) {
    return {
      level:  '',
      detail: `The script that decides it could not be read (ConfigMap ${ object } in namespace ${ EXT_NS }), so this cannot say which level is in force.`,
    };
  }

  if (script.includes('--dangerously-skip-permissions')) {
    return {
      level:  'never-ask',
      detail: 'The pod starts claude with --dangerously-skip-permissions (pod/claude-session.sh), so this is the level in force for everybody, and it is the only level this build can produce.',
    };
  }

  if (/--permission-mode\s+acceptEdits/.test(script)) {
    return { level: 'edit-freely', detail: 'The pod starts claude with --permission-mode acceptEdits (pod/claude-session.sh).' };
  }

  return { level: 'ask-every-edit', detail: 'The pod starts claude with no permission flag (pod/claude-session.sh), so it asks.' };
}

/**
 * What a role has to be able to do before somebody holding it can use Studio.
 *
 * Studio's pages are registered with no permission gate, so anybody signed in can open them.
 * That is not the same as being able to use them: every read and every write this product makes
 * goes through Rancher's cluster proxy carrying the session of whoever is looking, so what
 * actually decides is Kubernetes RBAC on namespace `barn` in the local cluster. Three calls are
 * the whole product, and a role that cannot make them gets a Studio that renders and then 403s.
 *
 * `pods/exec` is the one that matters most and the one a reader is least likely to guess: the
 * terminal is not a convenience on the side, it is how every file in an extension gets written.
 */
export const STUDIO_NEEDS = [
  {
    verb: 'get', group: '', resource: 'configmaps', label: 'read an extension',
  },
  {
    verb: 'create', group: 'apps', resource: 'deployments', label: 'create one',
  },
  {
    verb: 'create', group: '', resource: 'pods/exec', label: 'open a terminal in its pod',
  },
];

/** One rule of a Rancher RoleTemplate, in the shape `/v3/roleTemplates` answers with. */
export interface PolicyRule {
  apiGroups?:     string[];
  resources?:     string[];
  verbs?:         string[];
  resourceNames?: string[];
}

/**
 * Kubernetes RBAC, as much of it as this question needs.
 *
 * `*` is the only wildcard RBAC has: there is no `pods/*`, so a rule that grants `pods` does not
 * grant `pods/exec` and a role can very reasonably be able to list pods and not exec into one.
 * A rule carrying `resourceNames` is treated as granting nothing, because it grants only the
 * objects it names and this asks about objects that do not exist yet.
 *
 * A RoleTemplate marked `external` carries no rules of its own - it defers to the cluster's
 * ClusterRole of the same name - so its rules have to be fetched from there before this is
 * asked. Passing the empty list would read as "can do nothing", which is the opposite of the
 * answer for `cluster-admin`.
 */
export function ruleAllows(rules: PolicyRule[], group: string, resource: string, verb: string): boolean {
  return (rules || []).some((rule) => {
    if (rule.resourceNames?.length) {
      return false;
    }

    const has = (list: string[] | undefined, want: string) => !!list && (list.includes('*') || list.includes(want));

    return has(rule.apiGroups, group) && has(rule.resources, resource) && has(rule.verbs, verb);
  });
}

export interface RoleReading {
  /** True when every one of `STUDIO_NEEDS` is granted. */
  capable: boolean;
  /** The labels of the ones that are not, in the order they are listed. */
  missing: string[];
}

/** What somebody holding this role could do with Studio, read from the role's own rules. */
export function readRole(rules: PolicyRule[]): RoleReading {
  const missing = STUDIO_NEEDS
    .filter((need) => !ruleAllows(rules, need.group, need.resource, need.verb))
    .map((need) => need.label);

  return { capable: !missing.length, missing };
}
