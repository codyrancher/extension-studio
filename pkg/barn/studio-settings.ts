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
  EXT_NS, DEFAULT_EXTENSION, extensionObject, readSettings, saveSettings
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
    github: parsed.github || null,
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
  const next = change({ policy: current.policy, github: current.github });
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
 * refusing it. GitHub cannot be reached: it is stored with nothing recorded against it, because
 * a browser with no egress is not evidence about the token. GitHub answers: stored, with the
 * account.
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
        // expiry header, which is why nothing here can show one.
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
