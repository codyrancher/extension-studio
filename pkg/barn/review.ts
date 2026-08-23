// The review record: who decided what about a change, and when.
//
// Step 1 of `scripts/feature-audit/REVIEW-SYSTEM.md`, which decides where each kind of review
// state lives so that four screens do not each invent an answer. The split it draws:
//
//   Everything about the CODE lives in the pod's git repository (`extensions.ts`), because that
//   is the store that already moves with the code.
//
//   Everything about PEOPLE AND THEIR DECISIONS lives here, in one ConfigMap per extension,
//   `barn-review-<extension>` in namespace `barn`, because a sign-off has to be readable by the
//   queue without an exec into every pod, has to outlive the pod that happens to be serving the
//   extension today, and has to be attributable to a Rancher principal that the pod knows
//   nothing about.
//
// The last of those is the reason a sign-off cannot go where the deferral went. `git config`
// has no idea who set a value and there is exactly one pod, so two people using the same Studio
// would overwrite each other silently and neither record would name anybody.
//
// What this is not: an attestation. There is no server of ours anywhere in this product, so
// every write here is a browser write with the user's own session. A sign-off is recorded,
// compared and auditable in the apiserver's log; it is not signed, and no screen may use
// language that implies it is.
import { rancherFetch } from './api';
import { EXT_NS } from './extensions';

// The same cluster and the same base path `extensions.ts` addresses, which does not export it.
// Written out rather than imported so this file has no cycle with the module that will
// eventually call into it.
const EXT_BASE = '/k8s/clusters/local';

/** One ConfigMap per extension, one key in it. */
export function reviewObject(extension: string): string {
  return `barn-review-${ extension }`;
}

const REVIEW_KEY = 'review.json';

/**
 * One person's answer to one of the two questions.
 *
 * `sha` is what makes an answer mean something later: a sign-off is against the commit that was
 * on the branch when it was given, never against "the extension". Move past it and the record
 * is still there, still named, and no longer sufficient - which is the difference between a
 * gate and a checkbox.
 */
export interface Signoff {
  /** approved | changes-requested */
  verdict:   string;
  /** The Rancher principal id, e.g. `local://user-btc48`. The identity, not the label. */
  principal: string;
  /** What to put on the screen. May be empty if Rancher would only give us the id. */
  name:      string;
  at:        string;
  note:      string;
  /** The commit the answer was given against. */
  sha:       string;
}

export interface ReviewRecord {
  /** `code` is screen 12's question, `outcome` is screen 13's. */
  signoffs: { code?: Signoff; outcome?: Signoff };
}

const EMPTY: ReviewRecord = { signoffs: {} };

export interface Signer {
  principal: string;
  name:      string;
}

/**
 * Who the cluster believes is asking.
 *
 * Two readings, and they answer different questions. The SelfSubjectReview is what the
 * apiserver believes about this session - server attested, and therefore the identity that goes
 * into the record. `/v3/users?me=true` is Rancher's own view of the same person and is the
 * better source for a name a human recognises.
 *
 * It throws rather than returning a blank when neither answers. A sign-off nobody can be
 * attributed to is not a sign-off, and recording one anyway would be exactly the fake this
 * product does not ship.
 */
export async function currentSigner(): Promise<Signer> {
  const [review, me] = await Promise.all([
    rancherFetch(`${ EXT_BASE }/apis/authentication.k8s.io/v1/selfsubjectreviews`, {
      method: 'POST',
      body:   JSON.stringify({ apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' }),
    }).catch(() => null),
    rancherFetch('/v3/users?me=true').catch(() => null),
  ]);

  const info = review?.status?.userInfo || {};
  const user = me?.data?.[0] || null;

  const principal = user?.principalIds?.[0] || info?.extra?.principalid?.[0] ||
    (info.username ? `local://${ info.username }` : '');
  const name = user?.name || user?.username || info?.extra?.username?.[0] || info.username || '';

  if (!principal) {
    throw new Error('Rancher would not say who you are, so this decision cannot be attributed to anybody');
  }

  return { principal, name };
}

async function readObject(extension: string): Promise<any> {
  return rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ reviewObject(extension) }`).catch(() => null);
}

function parse(object: any): ReviewRecord {
  try {
    const parsed = JSON.parse(object?.data?.[REVIEW_KEY] || '{}');

    return { signoffs: parsed.signoffs || {} };
  } catch {
    // A record somebody hand-edited into invalid JSON reads as no record. It is not worth
    // taking the screen down for, and the next write replaces it.
    return { ...EMPTY };
  }
}

/**
 * The record, or an empty one.
 *
 * A missing ConfigMap is the normal state of an extension nobody has reviewed, so nothing has
 * to be created ahead of time and the cost of never having been reviewed is one 404.
 */
export async function readReview(extension: string): Promise<ReviewRecord> {
  return parse(await readObject(extension));
}

/**
 * Read, change, write - with the object that was read handed back to the apiserver.
 *
 * The same optimistic concurrency `saveSettings` uses on the settings Secret: PUT the object
 * that was read, resourceVersion and all, so a second reviewer writing between the read and the
 * write gets a 409 rather than silently losing their answer.
 */
export async function updateReview(
  extension: string,
  change: (record: ReviewRecord) => ReviewRecord
): Promise<ReviewRecord> {
  const existing = await readObject(extension);
  const next = change(parse(existing));
  const data = { [REVIEW_KEY]: JSON.stringify(next, null, 2) };

  if (existing) {
    await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ reviewObject(extension) }`, {
      method: 'PUT',
      body:   JSON.stringify({ ...existing, data }),
    });
  } else {
    await rancherFetch(`${ EXT_BASE }/v1/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { name: reviewObject(extension), namespace: EXT_NS },
        data,
      }),
    });
  }

  return next;
}

/** Record an answer to the code question (screen 12). */
export async function signCodeReview(
  extension: string,
  { verdict, sha, note = '' }: { verdict: string; sha: string; note?: string }
): Promise<Signoff> {
  const signer = await currentSigner();
  const signoff: Signoff = {
    verdict, principal: signer.principal, name: signer.name, at: new Date().toISOString(), note, sha,
  };

  await updateReview(extension, (record) => ({
    ...record,
    signoffs: { ...record.signoffs, code: signoff },
  }));

  return signoff;
}

/**
 * Where the two questions stand, for one extension at one commit.
 *
 * The reduced form of `gateState` in the design: it knows about the two sign-offs and the
 * commit they were given against, and it does not know about packets yet, because packets are
 * step 5 and nothing writes one. Every state it can return is a state it can actually observe.
 *
 *   unsigned          - neither question has been answered
 *   awaiting-code     - the outcome is signed off and the code is not
 *   awaiting-outcome  - the code is signed off and the outcome is not
 *   changes-requested - somebody said no, and their note is the way back
 *   same-signer       - both answers came from the same person, which is not two sign-offs
 *   stale             - both are in, and the branch has moved past what they answered about
 *   open              - two different people, both approved, both against the current commit
 */
export type GateVerdict =
  'unsigned' | 'awaiting-code' | 'awaiting-outcome' | 'changes-requested' | 'same-signer' | 'stale' | 'open';

export interface GateState {
  state:   GateVerdict;
  code:    Signoff | null;
  outcome: Signoff | null;
  /** True when that sign-off was given against a commit the branch has since moved past. */
  codeStale:    boolean;
  outcomeStale: boolean;
}

export function gateFrom(record: ReviewRecord, sha: string): GateState {
  const code = record.signoffs.code || null;
  const outcome = record.signoffs.outcome || null;
  const stale = (s: Signoff | null) => !!(s && sha && s.sha && s.sha !== sha);
  const codeStale = stale(code);
  const outcomeStale = stale(outcome);

  const approved = (s: Signoff | null) => s?.verdict === 'approved';
  const refused = code?.verdict === 'changes-requested' || outcome?.verdict === 'changes-requested';

  let state: GateVerdict = 'unsigned';

  if (refused) {
    state = 'changes-requested';
  } else if (approved(code) && approved(outcome)) {
    if (code?.principal && code.principal === outcome?.principal) {
      state = 'same-signer';
    } else {
      state = codeStale || outcomeStale ? 'stale' : 'open';
    }
  } else if (approved(code)) {
    state = 'awaiting-outcome';
  } else if (approved(outcome)) {
    state = 'awaiting-code';
  }

  return {
    state, code, outcome, codeStale, outcomeStale,
  };
}

export async function gateState(extension: string, sha: string): Promise<GateState> {
  return gateFrom(await readReview(extension), sha);
}
