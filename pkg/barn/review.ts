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
import {
  EXT_NS, runInPackage, readExtensionFile, readSettings, publishExtensionToGithub,
  createPullRequest, commentOnPullRequest, githubDefaultBranch, provenanceFor,
  findOpenPullRequest, extensionSource, parseGithubSource,
  BASELINE_OCI_REF, BASELINE_LOCAL_REF, PublishError,
  type PublishProgress, type GithubPublishResult, type ChangedFile,
} from './extensions';

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
  /**
   * The packet this answer is about, or 0 for one given before there was a packet.
   *
   * The packet number is what the gate compares, because a packet is a fixed object and "the
   * extension" is not. `sha` stays beside it for the screens that were reading it before
   * packets existed and for a hand check with git.
   */
  packet?:   number;
  /** The Rancher principal id, e.g. `local://user-btc48`. The identity, not the label. */
  principal: string;
  /** What to put on the screen. May be empty if Rancher would only give us the id. */
  name:      string;
  at:        string;
  note:      string;
  /** The commit the answer was given against. */
  sha:       string;
}

/**
 * One hand-over: the thing the two sign-offs are about.
 *
 * A packet is a git ref and a number. The number is what a sign-off signs, what the queue
 * lists and what the `:change` route parameter has always had a slot for; the ref is what
 * makes the change readable later, because it is a real commit that does not move when the
 * branch does.
 */
export interface PacketRecord {
  n:      number;
  /** `refs/barn/packets/<n>` in the pod. */
  ref:    string;
  /** The branch it was pushed to, `barn/<extension>/<n>`. */
  branch: string;
  /** The commit the packet is at. */
  sha:    string;
  /** What the packet's diff is collapsed against. */
  base:   string;
  at:     string;
  /** Who pushed it. */
  by:     string;
  byName: string;
  /**
   * Whether a `BRIEF.md` was in the tree when the packet was assembled.
   *
   * Optional, and `undefined` means a packet written before this was recorded - which is a
   * third state and not the same as `false`. A hand-over without a brief is allowed (see
   * `assemblePacket`), so this is how a reviewer learns there is nothing to compare against
   * instead of working it out from an empty section in the pull request.
   */
  brief?: boolean;
  /** `owner/name`, when it reached GitHub. */
  repo:   string;
  pr:     { number: number; url: string } | null;
  /** Why the PR could not be opened, when it could not. Shown rather than swallowed. */
  prError: string;
  /**
   * Why the branch could not be pushed, when it could not.
   *
   * Separate from `prError` because they are different failures with different fixes: a push
   * that failed is a credential or a repository, and a PR that failed on top of a branch that
   * is up is usually a token without the scope for one. A screen that showed them as one
   * sentence would send somebody to the wrong setting.
   */
  pushError: string;
}

/**
 * One reviewer's last look, which is what makes re-review incremental.
 *
 * Keyed by a hash of the principal rather than by the principal itself, so the record does not
 * turn into a list of who has been reading what, keyed for lookup. The principal is inside the
 * value, because a look nobody can attribute is not worth keeping.
 */
export interface Look {
  principal: string;
  name:      string;
  /** The packet they last opened. */
  packet:    number;
  sha:       string;
  at:        string;
  /** Set when they said "not today". Cleared when they decide. */
  deferred:  string;
  note:      string;
  /** True for a deferral migrated out of the old per-extension git config value. */
  migrated:  boolean;
}

/** A reviewer's sentence, and whether it was put to the assistant. */
export interface ReviewComment {
  id:        string;
  packet:    number;
  file:      string;
  /** The first line of the hunk in the new file, or 0 for a comment on the change as a whole. */
  hunk:      number;
  text:      string;
  principal: string;
  name:      string;
  at:        string;
  /** When it reached the assistant. Empty means it did not. */
  sentAt:    string;
  /** How it was delivered: 'sent' straight into the session, or 'queued' for the next one. */
  sentHow:   string;
}

export interface ReviewRecord {
  /** `code` is screen 12's question, `outcome` is screen 13's. */
  signoffs: { code?: Signoff; outcome?: Signoff };
  /** Keyed by packet number, as a string, because that is what JSON keys are. */
  packets:  Record<string, PacketRecord>;
  looks:    Record<string, Look>;
  comments: ReviewComment[];
}

const EMPTY: ReviewRecord = {
  signoffs: {}, packets: {}, looks: {}, comments: [],
};

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

    return {
      signoffs: parsed.signoffs || {},
      packets:  parsed.packets || {},
      looks:    parsed.looks || {},
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    };
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

// ---------------------------------------------------------------------------
// Commit ids: one agreement, written down once.
//
// This product reads a commit id from two places that do not agree on its shape.
// `changeProvenance` in extensions.ts asks git for `%h`, which is abbreviated, and both screens
// that sign hand that straight to `signCodeReview` / `signOutcome`. `readPodPackets` below asks
// for `%(objectname)`, which is the full forty characters, and that is what a packet's `sha`
// is. Comparing the two with `===` says "different commit" about the same commit, so a sign-off
// given against a packet did not cover it, `distributionGate` reported it stale or absent, and
// the gate could never reach `open` no matter who signed what. Both halves were affected
// identically, which is why it looked like the gate was simply broken rather than like a bug
// about string lengths.
//
// The fix is at both ends, deliberately, and the two ends do different jobs:
//
//   `resolveCommit` normalises at WRITE time, so every id this product records from now on is
//   the full one and future comparisons are exact.
//
//   `sameCommit` normalises at COMPARE time, so records already in a cluster - written with
//   either shape, by a screen or by hand - still answer the question correctly.
//
// Write-time alone would leave every existing record unmatchable. Compare-time alone would work
// and would leave the ambiguity in the data for the next reader to trip over. Doing both is not
// belt and braces: it is a migration that needs no migration step.
//
// Every comparison of two commit ids in this file goes through `sameCommit`, including the ones
// where both sides come from the same producer and `===` would do. That is on purpose. The bug
// was not that one comparison was wrong; it was that there were five of them and no single
// place said what "the same commit" means.
// ---------------------------------------------------------------------------

/**
 * The shortest abbreviation this product will treat as naming a commit.
 *
 * Seven, which is what `git log --format=%h` gives by default and what git itself accepts on a
 * command line. Below it, an id is short enough to match commits that are not the one meant, so
 * it is refused rather than compared - see `sameCommit`.
 */
const MIN_SHA = 7;

/**
 * Do these two ids name the same commit?
 *
 * Compared on the shorter of the two, which is how git resolves an abbreviation, and refused
 * outright when either side is shorter than `MIN_SHA` or is not hex.
 *
 * That refusal is the load-bearing half. A comparison that answers "yes" to a blank id is the
 * failure this file just closed once already: a sign-off with no commit on it read as covering
 * every commit, for ever, and opened a gate that should have been shut. An id too short to
 * identify anything has to answer "no", so a record that cannot be matched reads as not
 * matching rather than as matching everything. Wrong in the direction of a closed gate.
 *
 * Two different commits sharing a seven-character prefix would compare equal. That is the same
 * risk `git checkout 1a2b3c4` carries and the same size of repository it is being taken in, and
 * the alternative - refusing every record written before the ids were normalised - is worse.
 */
export function sameCommit(a: string, b: string): boolean {
  const x = (a || '').trim().toLowerCase();
  const y = (b || '').trim().toLowerCase();
  const hex = /^[0-9a-f]+$/;

  if (x.length < MIN_SHA || y.length < MIN_SHA || !hex.test(x) || !hex.test(y)) {
    return false;
  }

  const n = Math.min(x.length, y.length);

  return x.slice(0, n) === y.slice(0, n);
}

/**
 * The full object id for a commit the pod knows about, or what was given.
 *
 * One `rev-parse` in the pod, at the moment a decision is recorded, so what goes into the record
 * is unambiguous. `^{commit}` rather than a bare rev so a tag or a branch name resolves to the
 * commit it points at rather than to itself.
 *
 * It falls back to what it was handed rather than throwing. A sign-off is a person's answer and
 * it is not worth losing to a pod that will not answer or an id from a repository this Studio
 * cannot reach; `sameCommit` compares an abbreviated id correctly anyway, which is exactly the
 * case this fallback leaves behind.
 */
async function resolveCommit(extension: string, sha: string): Promise<string> {
  const out = await runInPackage(
    extension, `git rev-parse --verify -q ${ shellSingleQuote(`${ sha }^{commit}`) } 2>/dev/null`
  ).catch(() => '');
  const full = (out.trim().split('\n').pop() || '').trim();

  return /^[0-9a-f]{40}$/.test(full) ? full : sha;
}

/**
 * The commit an answer is about, or a refusal.
 *
 * A sign-off with no commit on it is worse than no sign-off at all, and this is not
 * hypothetical: screen 12's approve() commits with `commitExtension` and signs against the last
 * line of its output, and when there is nothing to commit that call makes no commit, leaves HEAD
 * where it was and hands back git's "nothing to commit, working tree clean" instead of a hash.
 * Signed anyway, the record carried an empty (or prose) `sha`, and an empty sha never compares
 * unequal to the current commit - so the approval silently covered every commit that came after
 * it. Refusing here puts the check in the function every sign-off goes through rather than in
 * the one screen that was seen getting it wrong.
 *
 * Abbreviated ids are accepted, because `%h` is what the screens have to give. They are not
 * *stored* abbreviated: `resolveCommit` expands them at the point of writing, and `sameCommit`
 * compares whatever shape is already on record. See the note above those two.
 */
function requireSha(sha: string): string {
  const value = (sha || '').trim();

  if (!/^[0-9a-f]{7,40}$/.test(value)) {
    throw new Error(
      'This decision cannot be recorded, because nothing said which commit it is about. A sign-off is against the commit that was on the branch when it was given, and one with no commit on it would go on covering every change made afterwards. Commit the change first, then decide.'
    );
  }

  return value;
}

/** Record an answer to the code question (screen 12). */
export async function signCodeReview(
  extension: string,
  {
    verdict, sha, note = '', packet = 0,
  }: { verdict: string; sha: string; note?: string; packet?: number }
): Promise<Signoff> {
  // Validated first, then expanded to the full object id, so the record does not depend on
  // which producer the calling screen happened to read the commit from.
  sha = await resolveCommit(extension, requireSha(sha));

  const signer = await currentSigner();
  const signoff: Signoff = {
    verdict, principal: signer.principal, name: signer.name, at: new Date().toISOString(), note, sha, packet,
  };

  await updateReview(extension, (record) => ({
    ...record,
    signoffs: { ...record.signoffs, code: signoff },
  }));

  return signoff;
}

/**
 * Who the brief says asked for this change, when it says.
 *
 * Rancher tells us a principal and its groups. It does not tell us that this person is "the
 * person who asked", so that has to have been written down when it was known. The brief is
 * where it is written down, in a `## Who asked` section holding a principal id.
 *
 * Empty is a real answer and the one every extension that predates this gives. It must be
 * reported as "the requester was never recorded" and never quietly satisfied by whoever is
 * standing there, which would turn the second sign-off into a second copy of the first.
 */
export async function whoAsked(extension: string): Promise<string> {
  const brief = await readExtensionFile(extension, 'BRIEF.md').catch(() => '');
  const lines = brief.split('\n');
  const start = lines.findIndex((line) => /^##\s+Who asked\s*$/i.test(line.trim()));

  if (start < 0) {
    return '';
  }

  // To the next heading, walked rather than matched: a regex that spans sections has to
  // express "up to the next ## or the end of the file", and every form of that is harder to
  // read than the loop.
  const body: string[] = [];

  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    body.push(lines[i]);
  }

  // The first thing in the section that looks like a principal id. The section is written by a
  // screen, but a brief is a file a person can edit, so this reads rather than assumes.
  return (/([a-z][\w-]*:\/\/\S+)/.exec(body.join('\n'))?.[1] || '').trim();
}

/**
 * Record an answer to the outcome question (screen 13): does it actually do the job?
 *
 * The half of the gate the brief owns. When the brief recorded who asked, this refuses anybody
 * else and says who it is waiting for; when it did not, it records whoever signed and the
 * packet says the requester was never recorded. Those are the only two honest behaviours, and
 * "accept anyone as the requester" is not one of them.
 */
export async function signOutcome(
  extension: string,
  {
    verdict, sha, note = '', packet = 0,
  }: { verdict: string; sha: string; note?: string; packet?: number }
): Promise<Signoff> {
  sha = await resolveCommit(extension, requireSha(sha));

  const [signer, asked] = await Promise.all([currentSigner(), whoAsked(extension)]);

  if (asked && asked !== signer.principal) {
    throw new Error(
      `The brief records ${ asked } as the person who asked for this, and the outcome sign-off is theirs to give. You are signed in as ${ signer.principal }.`
    );
  }

  const signoff: Signoff = {
    verdict, principal: signer.principal, name: signer.name, at: new Date().toISOString(), note, sha, packet,
  };

  await updateReview(extension, (record) => ({
    ...record,
    signoffs: { ...record.signoffs, outcome: signoff },
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
  // A sign-off that names no commit reads as stale, not as current. `requireSha` stops any new
  // one being written, but records already in the cluster from before that check have to be
  // read honestly rather than treated as covering whatever is on the branch today.
  //
  // `sameCommit` rather than `!==` because the two sides reach here in different shapes: screen
  // 12 passes `changeProvenance`'s abbreviated `%h`, the queue passes a full object id, and the
  // record holds whichever was written. An unknown current commit is still not staleness - it is
  // a question this cannot answer - so `sha` being empty leaves every sign-off alone.
  const stale = (s: Signoff | null) => !!(s && sha && !sameCommit(s.sha, sha));
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

// ---------------------------------------------------------------------------
// The packet: the thing that is handed over.
//
// Steps 5 and 6 of scripts/feature-audit/REVIEW-SYSTEM.md. The gate is one boundary with two
// halves at the same place. Entering it - the push - assembles the packet and produces the
// pull request; leaving it - the distribution - is refused until two different principals have
// signed the two different questions against that packet.
//
// The two halves need different checks, and that difference is the point. Pushing requires
// something to hand over and somebody the cluster can name, and nothing else: not a sign-off,
// because pushing is how you *ask* for one, and not a brief, because a brief-less change that
// cannot even be shown to a reviewer is a change nobody can help with. The brief is required
// at the other half, where it decides whether other people get the extension.
// ---------------------------------------------------------------------------

/** Where a packet lives in the pod. `<n>` is the packet number. */
const PACKET_REFS = 'refs/barn/packets';

/** Where the blame-resolved provenance index for a packet is attached. */
const PROVENANCE_NOTES = 'refs/notes/barn-provenance';

/** The branch a packet is pushed on. One per packet, so a re-push is a new branch. */
export function packetBranch(extension: string, n: number): string {
  return `barn/${ extension }/${ n }`;
}

export const HANDOVER_STAGES = [
  'Reading the brief',
  'Assembling the packet',
  'Pushing the branch',
  'Opening the pull request',
];

export interface Packet extends PacketRecord {
  /** How the hand-over went, for the strip that reported it. */
  log: string;
}

/**
 * What the pod knows about this extension's packets, in one exec.
 *
 * The tip, the baseline, whether there is a brief, and every packet ref with its commit. Every
 * question the gate asks is answered from these four readings, so it is one shell into the pod
 * per gate check rather than one per question.
 */
interface PodPackets {
  head:    string;
  base:    string;
  brief:   boolean;
  /**
   * True when the working tree holds something HEAD does not.
   *
   * Read the same way `COUNT_SH` in extensions.ts reads it - the union of "tracked paths that
   * differ" and "files git has never seen" - rather than with `git status`, which takes
   * `index.lock`. This reading is on the gate's path and two of them racing on one pod would
   * leave one silently doing nothing.
   */
  dirty:   boolean;
  /** packet number -> the commit it is at. */
  packets: Record<number, string>;
}

async function readPodPackets(extension: string): Promise<PodPackets> {
  const out = await runInPackage(extension, [
    'test -f BRIEF.md && echo BRIEF=yes',
    `echo "HEAD=$(git rev-parse --verify -q HEAD)"`,
    [
      `echo "BASE=$(git rev-parse --verify -q ${ BASELINE_OCI_REF }`,
      `|| git rev-parse --verify -q ${ BASELINE_LOCAL_REF }`,
      '|| git rev-parse --verify -q HEAD)"',
    ].join(' '),
    [
      'echo "DIRTY=$({ git diff --name-only --no-renames HEAD 2>/dev/null',
      '; git ls-files -o --exclude-standard 2>/dev/null ; } | head -1)"',
    ].join(' '),
    `git for-each-ref --format='PACKET=%(refname:strip=3) %(objectname)' ${ PACKET_REFS }/ 2>/dev/null`,
  ].join(' ; ')).catch(() => '');

  const packets: Record<number, string> = {};

  out.split('\n').forEach((line) => {
    const m = /^PACKET=(\d+)\s+([0-9a-f]+)/.exec(line.trim());

    if (m) {
      packets[parseInt(m[1], 10)] = m[2];
    }
  });

  return {
    head:  (/HEAD=(\S+)/.exec(out)?.[1] || '').trim(),
    base:  (/BASE=(\S+)/.exec(out)?.[1] || '').trim(),
    brief: out.includes('BRIEF=yes'),
    dirty: !!(/DIRTY=(\S+)/.exec(out)?.[1] || '').trim(),
    packets,
  };
}

/**
 * Assemble a packet at the current tip.
 *
 * Cross-screen rule 6: the packet accumulates in the background while the author works and is
 * only assembled at the push. What accumulates is the provenance log and the commits; what is
 * assembled here is the ref, the note and the branch.
 *
 * READ EVERYTHING, REFUSE, AND ONLY THEN WRITE. The order is the point, and getting it wrong
 * cost real work: this used to sweep the whole working tree into a commit as its first act and
 * check the preconditions afterwards, so a hand-over that was going to be refused anyway had
 * already moved HEAD by the time it said no. With no baseline ref in the pod the baseline
 * resolves to HEAD, so the Changes tab and screens 04 and 12 then showed nothing at all for
 * work that was still uncommitted a second earlier. Nothing below the "past this line" comment
 * may move above it.
 *
 * A MISSING BRIEF NO LONGER REFUSES, and that is a deliberate reversal. The refusal made a
 * capability that used to work stop working - "Push the source to GitHub" pushed brief or no
 * brief, the brief screen still offers "Skip the brief", and an extension imported from GitHub
 * has never had a BRIEF.md - while buying nothing, because pushing is how you *ask* for a
 * review and refusing to let somebody ask is not a safety property. Rule 14 stays structural
 * where it is load bearing: `distributionGate` refuses `no-brief` at the distribution boundary,
 * which is the one hard gate rule 1 names. What a brief-less hand-over does instead is say so -
 * in the packet record, in the provenance note and in the pull request body - so the reviewer
 * finds out from the packet rather than from its absence.
 */
export async function assemblePacket(extension: string): Promise<PacketRecord> {
  // Every precondition, up front, before a single byte is written to the pod. `currentSigner`
  // is in here rather than beside the write because a hand-over nobody can be attributed to is
  // refused, and finding that out after the sweep is the same bug in a smaller coat.
  const [before, signer] = await Promise.all([readPodPackets(extension), currentSigner()]);

  if (!before.head && !before.dirty) {
    throw new Error(`${ extension } has no git history in its pod, so there is nothing to hand over`);
  }

  const numbersBefore = Object.keys(before.packets).map(Number);
  const latestBefore = numbersBefore.length ? Math.max(...numbersBefore) : 0;

  // Nothing uncommitted and the newest packet already at the tip: there is genuinely nothing
  // new, and the sweep below would have found nothing to sweep. Refuse here, where refusing is
  // free, rather than after HEAD has moved.
  if (!before.dirty && latestBefore && sameCommit(before.packets[latestBefore], before.head)) {
    throw new Error(`Packet ${ latestBefore } is already at this commit, so there is nothing new to hand over.`);
  }

  // ---- past this line the pod is written to ----

  let state = before;

  if (before.dirty) {
    // Anything still uncommitted goes in. Usually there is nothing: the assistant's Stop hook
    // commits each turn as it ends. What is left is what a person typed in the Terminal tab,
    // and a packet that quietly left it out would be a hand-over of something other than what
    // is in the pod.
    await runInPackage(extension, [
      'git add -A',
      `git diff --cached --quiet || git -c user.email=barn@rancher.local -c user.name=barn commit -q -m ${ shellSingleQuote('Uncommitted work, swept in at the hand-over') }`,
    ].join(' ; ')).catch(() => '');

    // Re-read rather than assume: the sweep moved HEAD, and it may also have created the very
    // first commit in a pod that had none.
    state = await readPodPackets(extension);
  }

  if (!state.head) {
    throw new Error(`${ extension } has no git history in its pod, so there is nothing to hand over`);
  }

  const numbers = Object.keys(state.packets).map(Number);
  const latest = numbers.length ? Math.max(...numbers) : 0;

  if (latest && sameCommit(state.packets[latest], state.head)) {
    throw new Error(`Packet ${ latest } is already at this commit, so there is nothing new to hand over.`);
  }

  const n = latest + 1;
  const ref = `${ PACKET_REFS }/${ n }`;
  const branch = packetBranch(extension, n);

  // The note is written before the ref, and both before anything leaves the cluster: a packet
  // that exists is a packet whose provenance is attached, so a reviewer never opens one whose
  // index has not been built yet.
  const attribution = await provenanceFor(extension).catch(() => null);

  const note = JSON.stringify({
    packet: n,
    base:   state.base,
    sha:    state.head,
    at:     new Date().toISOString(),
    by:     signer.principal,
    // Whether anybody wrote down what this change is for. Recorded rather than enforced: the
    // hand-over no longer refuses without one, so the fact has to travel with the packet or
    // the reviewer has no way to know it was never written.
    brief:  state.brief,
    // Recorded even when it is empty, because "we looked and there was nothing" and "we never
    // looked" are different facts and the screen says which.
    attribution,
  });

  const out = await runInPackage(extension, [
    `git update-ref ${ ref } ${ state.head }`,
    // A note, not a commit: it travels with the object, it is pushed only if asked for, and it
    // does not put a file in the tree that the next diff would show as a change.
    `printf %s ${ shellSingleQuote(note) } | git -c user.email=barn@rancher.local -c user.name=barn notes --ref=${ PROVENANCE_NOTES } add -f -F - ${ state.head } 2>&1`,
    `git branch -f ${ branch } ${ state.head } 2>&1`,
    'echo BARN-PACKET-OK',
  ].join(' ; ')).catch(() => '');

  if (!out.includes('BARN-PACKET-OK')) {
    throw new Error(`the packet could not be assembled: ${ out.trim().slice(0, 200) || 'no output' }`);
  }

  return {
    n,
    ref,
    branch,
    sha:     state.head,
    base:    state.base,
    at:      new Date().toISOString(),
    by:      signer.principal,
    byName:  signer.name,
    brief:     state.brief,
    repo:      '',
    pr:        null,
    prError:   '',
    pushError: '',
  };
}

/** Single-quote for `sh`. The same form extensions.ts uses, which this file cannot import. */
function shellSingleQuote(value: string): string {
  return `'${ value.split("'").join(`'\\''`) }'`;
}

/**
 * Hand the change over: the entry to the gate.
 *
 * Assemble the packet, push its branch, open the pull request, and write all three into the
 * review record. The PR is the hand-off record (cross-screen rule 5) and the record is what
 * the queue reads, so the queue stops being a list of people with dirty working trees and
 * becomes a list of changes somebody actually asked about.
 *
 * The push and the PR are separately reported. A packet whose branch is up and whose PR could
 * not be opened is a real state - a token without pull-request scope produces exactly it - and
 * it is recorded as itself rather than being rolled back or hidden.
 *
 * What is checked before the packet exists, and why: assembling one writes to the pod (a ref, a
 * note, a branch, and the sweep of anything uncommitted). A hand-over with no token or a
 * repository that is not `owner/name` cannot possibly reach GitHub, so those two are read here,
 * before `assemblePacket`, rather than being discovered inside the push with a packet already
 * on disk. Anything that could plausibly succeed - a bad token, a repository that does not
 * exist, a token without pull-request scope - is still found by the push and recorded as
 * `pushError` on the packet it belongs to.
 */
export async function handOverForReview(
  extension: string, repo: string, onProgress?: PublishProgress
): Promise<Packet> {
  const total = HANDOVER_STAGES.length;
  const report = (stage: number) => onProgress?.(stage, HANDOVER_STAGES[stage - 1], total);

  report(1);

  const settings = await readSettings(extension).catch(() => ({ hasToken: false, repo: '' }));

  if (!settings.hasToken) {
    throw new PublishError(
      'No GitHub token is configured, so this change cannot be handed over. Add one in the editor settings.',
      HANDOVER_STAGES[0],
      ''
    );
  }

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new PublishError(`"${ repo }" is not owner/name`, HANDOVER_STAGES[0], '');
  }

  const packet = await assemblePacket(extension);

  report(2);

  let push: GithubPublishResult;

  try {
    report(3);
    push = await publishExtensionToGithub(extension, repo, undefined, packet.branch, packet.sha);
  } catch (e: any) {
    // The packet stays. It is a real object in the pod, the reviewer can read it there, and
    // the next attempt pushes the same one rather than making a second.
    await updateReview(extension, (record) => ({
      ...record,
      packets: { ...record.packets, [packet.n]: { ...packet, pushError: e?.message || String(e) } },
    }));

    throw e;
  }

  report(4);

  const brief = await readExtensionFile(extension, 'BRIEF.md').catch(() => '');
  const body = [
    `Handed over from the Rancher Extension Studio as packet ${ packet.n }.`,
    '',
    `- Collapsed against \`${ packet.base.slice(0, 12) }\`, the last version other people could get.`,
    `- Two sign-offs are outstanding: the code review and the outcome sign-off. They are recorded in the \`barn-review-${ extension }\` ConfigMap in the \`barn\` namespace, and the distribution is refused until two different people have given them.`,
    '- These sign-offs are recorded and auditable, not cryptographically attested. This product has no server of its own, so every write is a browser write with the signer\'s own Rancher session.',
    '',
    '## The brief',
    '',
    // Said plainly rather than left as an empty heading. A hand-over without a brief is
    // allowed, so the reviewer has to be told they are reading a change with nothing written
    // down about what it is for, and told what that costs them at the outcome sign-off.
    brief.trim() || [
      'There is no `BRIEF.md` in this extension, so nobody wrote down what this change is for.',
      '',
      'The hand-over went ahead anyway - a brief is not required to *ask* for a review - but two',
      'things follow from it. The outcome sign-off has no acceptance criteria to walk, and no',
      'requester is recorded, so it will be given by whoever is standing there rather than by the',
      'person who asked. Distribution is refused until a brief exists.',
    ].join('\n'),
  ].join('\n');

  const record: PacketRecord = { ...packet, repo };

  try {
    const pr = await createPullRequest(extension, repo, {
      head:  packet.branch,
      base:  await githubDefaultBranch(extension, repo).catch(() => 'main'),
      title: `${ extension }: packet ${ packet.n }`,
      body,
    });

    record.pr = { number: pr.number, url: pr.url };
  } catch (e: any) {
    record.prError = e?.message || String(e);
  }

  await updateReview(extension, (existing) => ({
    ...existing,
    packets: { ...existing.packets, [record.n]: record },
  }));

  return { ...record, log: push.log };
}

/**
 * The pull request that is the record of this hand-over.
 *
 * Cross-screen rule 5: "the hand-off to review is a PR, and the PR is the record". The record
 * half was already true - `handOverForReview` writes the PR into the packet - and the reading
 * half was not, because the only surface that asked looked for the wrong thing. Screen 12's
 * `checkPullRequest` searched GitHub for an open PR whose head is `listBranches().current`,
 * and a packet's branch is created with `git branch -f` and never checked out, so the branch it
 * searched for was never the packet's. It could not have found the PR the hand-over makes.
 *
 * So this answers from the record first and GitHub second, which is also the right order for
 * what the rule claims. The packet is the hand-off; the PR the hand-off opened is written into
 * it at the moment it is opened; reading it back needs nothing from GitHub and works with no
 * token, offline, and after the PR is merged and no longer open. GitHub is asked only when the
 * record has no PR in it - a hand-over whose PR failed, or a packet pushed before this was
 * recorded - and it is asked about the *packet's* branch.
 */
export interface PacketPullRequest {
  /**
   * Which of them this is about, and how sure it is.
   *
   * `recorded`    the packet carries the PR the hand-over opened. The record, read back.
   * `found`       the record had none and GitHub has an open one on the packet's branch.
   * `failed`      the hand-over tried to open one and GitHub refused. `error` says why.
   * `none`        the packet was handed over and there is no PR for it.
   * `unasked`     there is a packet with no PR recorded and nothing could ask GitHub.
   * `no-packet`   nothing has been handed over, so there is no hand-off to have a record of.
   */
  state:   'recorded' | 'found' | 'failed' | 'none' | 'unasked' | 'no-packet';
  /** The packet number, 0 when there is none. */
  packet:  number;
  /** The branch the packet was pushed on. '' with no packet. */
  branch:  string;
  /** The commit the packet is at. */
  sha:     string;
  /** `owner/name`, from the packet or from where the extension came from. */
  repo:    string;
  pr:      { number: number; url: string } | null;
  /** Why there is no PR, when the reason is known. '' otherwise. */
  error:   string;
  /** A whole sentence a chip can render. A state with no reason is not acceptable. */
  sentence: string;
}

export async function packetPullRequest(extension: string): Promise<PacketPullRequest> {
  const record = await readReview(extension);
  const numbers = Object.keys(record.packets).map(Number).filter((n) => n > 0);

  if (!numbers.length) {
    return {
      state:    'no-packet',
      packet:   0,
      branch:   '',
      sha:      '',
      repo:     '',
      pr:       null,
      error:    '',
      sentence: 'This has never been handed over, so there is no pull request to be its record yet.',
    };
  }

  const n = Math.max(...numbers);
  const packet = record.packets[String(n)];
  const branch = packet.branch || packetBranch(extension, n);
  const base = {
    packet: n, branch, sha: packet.sha || '', repo: packet.repo || '',
  };

  if (packet.pr) {
    return {
      ...base,
      state:    'recorded' as const,
      pr:       packet.pr,
      error:    '',
      sentence: `Packet ${ n } was handed over as pull request #${ packet.pr.number }.`,
    };
  }

  if (packet.prError) {
    return {
      ...base,
      state:    'failed' as const,
      pr:       null,
      error:    packet.prError,
      sentence: `Packet ${ n } is pushed to ${ branch }, but the pull request could not be opened: ${ packet.prError }`,
    };
  }

  // Nothing recorded. Ask GitHub about the packet's own branch - which is the branch the
  // hand-over pushed, and never the one the pod happens to have checked out.
  const settings = await readSettings(extension).catch(() => ({ hasToken: false, repo: '' }));
  const source = await extensionSource(extension).catch(() => '');
  const repo = packet.repo || settings.repo || parseGithubSource(source)?.repo || '';

  if (!settings.hasToken || !repo) {
    return {
      ...base,
      repo,
      state:    'unasked' as const,
      pr:       null,
      error:    '',
      sentence: settings.hasToken
        ? `Packet ${ n } records no pull request, and no repository is remembered for ${ extension }, so nothing can be asked about it.`
        : `Packet ${ n } records no pull request, and there is no GitHub token configured, so nothing can be asked about it.`,
    };
  }

  try {
    const found = await findOpenPullRequest(extension, repo, branch);

    return found ? {
      ...base,
      repo,
      state:    'found' as const,
      pr:       { number: found.number, url: found.url },
      error:    '',
      sentence: `Pull request #${ found.number } is open on ${ branch }, the branch packet ${ n } was pushed to.`,
    } : {
      ...base,
      repo,
      state:    'none' as const,
      pr:       null,
      error:    '',
      sentence: `Packet ${ n } is pushed to ${ branch } and there is no open pull request on it.`,
    };
  } catch (e: any) {
    return {
      ...base,
      repo,
      state:    'unasked' as const,
      pr:       null,
      error:    e?.message || String(e),
      sentence: `Packet ${ n } records no pull request, and GitHub could not be asked about ${ branch }: ${ e?.message || String(e) }`,
    };
  }
}

/**
 * Which of these extensions have actually been handed over.
 *
 * Cross-screen rule 6: the packet accumulates in the background and is assembled at the push,
 * so a queue is a list of hand-overs and not a list of people with dirty working trees. The
 * review queue enumerates every extension in the namespace and enriches each one, which puts
 * somebody who has never asked for a review into somebody else's queue - a row that explains
 * itself in words is still a row.
 *
 * One ConfigMap read per extension, in parallel, and no exec into any pod: this is on the
 * queue's first paint. An extension whose record cannot be read is treated as not handed over,
 * which is the same answer as an extension with no record at all.
 */
export async function handedOverExtensions(names: string[]): Promise<string[]> {
  const answers = await Promise.all(names.map(async(name) => {
    const record = await readReview(name).catch(() => null);
    const handed = !!record && Object.keys(record.packets || {}).some((n) => Number(n) > 0);

    return handed ? name : '';
  }));

  return answers.filter(Boolean);
}

// ---------------------------------------------------------------------------
// How much attention a change wants
// ---------------------------------------------------------------------------

/** Markdown that is prose rather than code. */
const PROSE = /\.(md|markdown|txt)$/i;
/** The files that decide what the extension depends on. */
const MANIFEST = /(^|\/)package(-lock)?\.json$/;
/** The files Rancher loads first - a mistake in one of these takes the whole extension down. */
const ENTRY = /(^|\/)(index|product|routing)\.(ts|js)$/;

export interface Risk {
  level:  'none' | 'low' | 'medium' | 'high';
  /** Three clauses, each of them a reading rather than a judgement. */
  reason: string;
}

/**
 * How much of a reviewer's attention this change wants, and the one line saying why.
 *
 * It lives here because two screens rate the same change and they were rating it differently.
 * Screen 11's queue read the paths and the diff sizes; screen 12's masthead counted files and
 * nothing else, so one minute's work on eight lines of an entry point was "medium (8 lines,
 * touches the entry point)" in the queue and "low risk" in the masthead. Two readings of one
 * change, from one set of files, in one product. There is one reading now and both screens
 * call it.
 *
 * A file count cannot tell a ten-file documentation pass from ten files of the entry point, so
 * this reads what it already has: whether anything but prose changed, whether the dependency
 * manifest moved, whether the files Rancher loads first are among them, and how many lines.
 *
 * The reason is three clauses because that is what the design draws ("Read-only · no new
 * dependencies · one page").
 */
export function assessRisk(files: ChangedFile[]): Risk {
  if (!files.length) {
    return { level: 'none', reason: 'Nothing uncommitted since the last commit' };
  }

  const lines = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  const proseOnly = files.every((f) => PROSE.test(f.path));
  const deps = files.some((f) => MANIFEST.test(f.path));
  const entry = files.some((f) => ENTRY.test(f.path));

  let level: Risk['level'] = 'low';

  if (files.length > 8 || lines > 400) {
    level = 'high';
  } else if (deps || entry || files.length > 3 || lines > 80) {
    level = 'medium';
  }

  if (proseOnly) {
    // Prose cannot break the extension, however much of it there is.
    level = 'low';
  }

  const reason = [
    proseOnly ? 'Prose only, no code' : `${ lines } line${ lines === 1 ? '' : 's' } changed`,
    deps ? 'moves the dependencies' : 'no dependency changes',
    entry ? 'touches the entry point' : `${ files.length } file${ files.length === 1 ? '' : 's' }`,
  ];

  return { level, reason: reason.join(' · ') };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Where the distribution boundary stands.
 *
 * The full form, which knows about packets. `gateFrom` above is the reduced one screen 12 was
 * built on before packets existed; it still answers that screen's question - where the two
 * sign-offs stand at one commit - and this answers the one the gate asks.
 */
export type GateStage =
  'no-brief' | 'no-packet' | 'stale-packet' | 'awaiting-code' | 'awaiting-outcome' |
  'changes-requested' | 'same-signer' | 'open';

export interface DistributionGate {
  state:   GateStage;
  /** The packet the sign-offs would have to be against. 0 when there is none. */
  packet:  number;
  /** The packet's commit. */
  sha:     string;
  /** The tip of the branch now, which is what a distribution would carry. */
  head:    string;
  code:    Signoff | null;
  outcome: Signoff | null;
  /** True when that sign-off is on record but not against this packet. */
  codeStale:    boolean;
  outcomeStale: boolean;
  /** Whether a distribution may proceed. The single thing a screen has to read. */
  open:    boolean;
  /** A whole sentence, naming what it is waiting for. A disabled control with no reason is not acceptable. */
  reason:  string;
}

/** Does this answer cover this packet? */
function covers(signoff: Signoff | null, packet: number, sha: string): boolean {
  if (!signoff) {
    return false;
  }

  if (signoff.packet) {
    return signoff.packet === packet;
  }

  // A sign-off given before packets existed carries only a commit. It counts when it is the
  // packet's own commit, which is the same question asked with less information.
  //
  // This is the comparison the gate turned on and the one that was wrong: the sign-off's sha
  // came from `%h` and the packet's from `%(objectname)`, so it answered "no" about a sign-off
  // given against that exact packet and the gate could never open. `sameCommit` is the
  // agreement between the two producers.
  return sameCommit(signoff.sha, sha);
}

function who(signoff: Signoff | null): string {
  return signoff?.name || signoff?.principal || 'somebody Rancher did not name';
}

export async function distributionGate(extension: string): Promise<DistributionGate> {
  const [record, state] = await Promise.all([readReview(extension), readPodPackets(extension)]);
  const numbers = Object.keys(state.packets).map(Number);
  const packet = numbers.length ? Math.max(...numbers) : 0;
  const sha = packet ? state.packets[packet] : '';
  const code = record.signoffs.code || null;
  const outcome = record.signoffs.outcome || null;
  const codeStale = !!code && !covers(code, packet, sha);
  const outcomeStale = !!outcome && !covers(outcome, packet, sha);

  const answer = (stage: GateStage, reason: string): DistributionGate => ({
    state:   stage,
    packet,
    sha,
    head:    state.head,
    code,
    outcome,
    codeStale,
    outcomeStale,
    open:    stage === 'open',
    reason,
  });

  if (!state.brief) {
    // Still a refusal, and now the only one the brief makes. The hand-over stopped requiring a
    // brief because refusing it broke a capability that worked; the distribution keeps
    // requiring one because this is the boundary rule 1 names, and past it the extension is
    // installable by people who cannot ask what it was for. The sentence has to say both, or a
    // reader takes "no brief" to mean the change is stuck where it is.
    return answer(
      'no-brief',
      'This change has no brief, so there is nothing written down for the outcome sign-off to be given against. It can still be handed over for review; it cannot be distributed until somebody writes one.'
    );
  }

  if (!packet) {
    return answer(
      'no-packet',
      'This change has never been handed over, so nobody has been asked to review it. Push it for review first.'
    );
  }

  if (state.head && sha && !sameCommit(state.head, sha)) {
    return answer(
      'stale-packet',
      `The extension has moved on since packet ${ packet } was handed over, so any sign-off on record is about a different change. Hand the new work over as a new packet.`
    );
  }

  if (code?.verdict === 'changes-requested' && covers(code, packet, sha)) {
    return answer('changes-requested', `${ who(code) } asked for changes in the code review: ${ code.note || 'no reason was recorded' }`);
  }

  if (outcome?.verdict === 'changes-requested' && covers(outcome, packet, sha)) {
    return answer('changes-requested', `${ who(outcome) } asked for changes at the outcome sign-off: ${ outcome.note || 'no reason was recorded' }`);
  }

  const codeIn = code?.verdict === 'approved' && covers(code, packet, sha);
  const outcomeIn = outcome?.verdict === 'approved' && covers(outcome, packet, sha);

  if (!codeIn) {
    return answer(
      'awaiting-code',
      outcomeIn
        ? `The outcome is signed off by ${ who(outcome) }. The code review of packet ${ packet } is still outstanding.`
        : `Packet ${ packet } is waiting on both sign-offs: the code review, and the outcome sign-off from the person who asked.`
    );
  }

  if (!outcomeIn) {
    return answer(
      'awaiting-outcome',
      `The code review is signed off by ${ who(code) }. The outcome sign-off on packet ${ packet } is still outstanding.`
    );
  }

  if (code && outcome && code.principal && code.principal === outcome.principal) {
    return answer(
      'same-signer',
      `Both sign-offs on packet ${ packet } carry the same person, ${ who(code) }. The two questions are "is it safe?" and "does it work?", and they are two sign-offs precisely because one person answering both is one opinion recorded twice.`
    );
  }

  return answer(
    'open',
    `Packet ${ packet } is signed off by ${ who(code) } for the code and ${ who(outcome) } for the outcome.`
  );
}

/** Thrown by the gate. Carries the state, so a screen can say the same thing the check knew. */
export class GateError extends Error {
  gate: DistributionGate;

  constructor(gate: DistributionGate) {
    super(gate.reason);
    this.name = 'GateError';
    this.gate = gate;
  }
}

/**
 * The check. Everything that makes this extension installable by other people goes through it.
 *
 * Deliberately not in a page. `editor.vue` is where the UI reacts and where the button is
 * drawn, but the load-bearing check has to be somewhere no screen - and no future screen - can
 * route around, which is here, in the function that does the distributing.
 *
 * What it enforces, and the limit of it: it compares the two principals and refuses when they
 * are equal, which stops one person ticking both boxes, in the one place every distribution
 * goes through. It does not stop somebody with `kubectl` writing both entries by hand, because
 * this extension has no server and there is nothing between the page and etcd that could sign
 * anything. What exists below the gate is the Kubernetes audit log: tamper evidence, not tamper
 * resistance. No screen may use language that implies otherwise.
 */
export async function assertGateOpen(extension: string): Promise<DistributionGate> {
  const gate = await distributionGate(extension);

  if (!gate.open) {
    throw new GateError(gate);
  }

  return gate;
}

/** Where a distribution can go, and whether this Studio can actually get there. */
export interface Destination {
  id:        string;
  label:     string;
  /** False when the product cannot perform it. The reason is shown instead of a disabled control. */
  available: boolean;
  reason:    string;
}

/**
 * The destinations, honestly.
 *
 * `repository` is the one this product can perform: the packet goes onto the repository's
 * default branch, which is what a chart workflow builds a release from, and that is the point
 * at which the extension becomes something other people install.
 *
 * `oci` is listed and is not available, and that is a statement rather than a stub. A push to
 * an OCI registry needs a Helm chart built from the extension and a registry client to push it
 * with. The pod has neither - no helm, no oras, no chart template - and no registry or
 * credential is configured anywhere in this product. Building an OCI client that has never
 * been pointed at a registry would be a control that lies, which is the one thing this product
 * does not ship. The gate in front of it is real; the destination behind it is not built.
 */
export async function distributionDestinations(extension: string): Promise<Destination[]> {
  const settings = await readSettings(extension).catch(() => ({ hasToken: false, repo: '' }));

  let repository = 'Puts the reviewed packet on the repository\'s default branch, which is what a release is built from.';

  if (!settings.hasToken) {
    repository = 'No GitHub token is configured, so this Studio cannot push anywhere. Add one in the editor settings.';
  } else if (!settings.repo) {
    repository = 'No repository is remembered for this extension yet. Hand a change over for review once and the repository it went to becomes the one it is distributed to.';
  }

  return [
    {
      id:        'repository',
      label:     'The connected repository',
      available: !!settings.hasToken && !!settings.repo,
      reason:    repository,
    },
    {
      id:        'oci',
      label:     'An OCI registry',
      available: false,
      reason:    'Not built. Pushing to an OCI registry means building a Helm chart from the extension and pushing it with a registry client, and this Studio has neither in the pod and no registry configured. The gate in front of it works; the push itself does not exist, and a button that pretended otherwise would be worse than this sentence.',
    },
  ];
}

export interface Distribution {
  destination: string;
  repo:        string;
  branch:      string;
  packet:      number;
  url:         string;
  log:         string;
}

/**
 * Leave the gate.
 *
 * The one place an extension becomes installable by other people, and therefore the one place
 * the two sign-offs are enforced. `assertGateOpen` is the first line on purpose: a caller that
 * forgot to look at `distributionGate()` first still cannot get past it.
 *
 * The local publish and the developer load do NOT come through here and are deliberately
 * ungated - see the comment on `publishExtension`. Cross-screen rule 2 is as load bearing as
 * rule 1.
 */
export async function distributeExtension(
  extension: string, destination: string, onProgress?: PublishProgress
): Promise<Distribution> {
  const gate = await assertGateOpen(extension);
  const available = (await distributionDestinations(extension)).find((d) => d.id === destination);

  if (!available) {
    throw new Error(`"${ destination }" is not somewhere this Studio can distribute to`);
  }

  if (!available.available) {
    throw new Error(available.reason);
  }

  const settings = await readSettings(extension);
  const branch = await githubDefaultBranch(extension, settings.repo);
  // The packet's own commit, not the tip: what leaves has to be the thing that was signed off.
  // `gate.sha` is the packet's commit and the gate has already refused if the tip moved past it.
  const push = await publishExtensionToGithub(extension, settings.repo, onProgress, branch, gate.sha);

  // The baseline moves only after the push has landed. It is what every later diff is
  // collapsed against, so recording a distribution that did not happen would make the next
  // reviewer's screen show nothing at all.
  await runInPackage(extension, `git update-ref ${ BASELINE_OCI_REF } ${ gate.sha }`).catch(() => '');

  // Best effort, and said out loud when it fails: the review lives in the cluster and the PR
  // is a mirror of it.
  const packet = (await readReview(extension)).packets[String(gate.packet)];

  if (packet?.pr && settings.repo) {
    await commentOnPullRequest(
      extension,
      settings.repo,
      packet.pr.number,
      `Distributed to \`${ branch }\` after both sign-offs. ${ gate.reason }`
    ).catch(() => null);
  }

  return {
    destination,
    repo:   settings.repo,
    branch,
    packet: gate.packet,
    url:    `https://github.com/${ settings.repo }/tree/${ branch }`,
    log:    push.log,
  };
}

// ---------------------------------------------------------------------------
// Since your last look, and the comments that route back.
//
// Steps 7 and 8. Both are per reviewer, which is the thing the old deferral could not be: it
// lived in the pod's git config, and git config has no idea who set a value.
// ---------------------------------------------------------------------------

/**
 * A short, stable key for a principal.
 *
 * djb2, which is not a security property and is not used as one. It is here so the record's
 * keys are a fixed shape rather than principal ids with schemes and slashes in them; the
 * principal itself is in the value, where it is readable.
 */
function principalKey(principal: string): string {
  let hash = 5381;

  for (let i = 0; i < principal.length; i++) {
    hash = (((hash << 5) + hash) ^ principal.charCodeAt(i)) >>> 0;
  }

  return `p${ hash.toString(36) }`;
}

/**
 * Record that this reviewer has read this packet.
 *
 * Called when a reviewer opens one. It is what makes re-review incremental: the next time they
 * come back, what landed since is the difference between this packet and the current one, and
 * the queue can say how many.
 */
export async function markLook(extension: string, packet: number, sha: string): Promise<Look> {
  const signer = await currentSigner();
  const key = principalKey(signer.principal);
  let look: Look = {
    principal: signer.principal,
    name:      signer.name,
    packet,
    sha,
    at:        new Date().toISOString(),
    deferred:  '',
    note:      '',
    migrated:  false,
  };

  await updateReview(extension, (record) => {
    // A deferral is the reviewer saying "not today" and survives them reading it again; it is
    // ended by deciding, not by looking.
    const existing = record.looks[key];

    look = {
      ...look, deferred: existing?.deferred || '', note: existing?.note || '', migrated: existing?.migrated || false,
    };

    return { ...record, looks: { ...record.looks, [key]: look } };
  });

  return look;
}

/** This reviewer's last look, or null if they have never opened one. */
export async function lastLook(extension: string): Promise<Look | null> {
  const [record, signer] = await Promise.all([readReview(extension), currentSigner()]);

  return record.looks[principalKey(signer.principal)] || null;
}

/** "I am not deciding today", recorded against the reviewer rather than against the extension. */
export async function deferPacket(extension: string, packet: number, note = ''): Promise<void> {
  const signer = await currentSigner();
  const key = principalKey(signer.principal);

  await updateReview(extension, (record) => {
    const existing = record.looks[key];

    return {
      ...record,
      looks: {
        ...record.looks,
        [key]: {
          principal: signer.principal,
          name:      signer.name,
          packet,
          sha:       existing?.sha || '',
          at:        existing?.at || new Date().toISOString(),
          deferred:  new Date().toISOString(),
          note,
          migrated:  false,
        },
      },
    };
  });
}

/** Answering ends the deferral. Anything that records a decision calls this. */
export async function clearOwnDeferral(extension: string): Promise<void> {
  const signer = await currentSigner().catch(() => null);

  if (!signer) {
    return;
  }

  const key = principalKey(signer.principal);

  await updateReview(extension, (record) => {
    const existing = record.looks[key];

    if (!existing?.deferred) {
      return record;
    }

    return {
      ...record,
      looks: {
        ...record.looks, [key]: {
          ...existing, deferred: '', note: '', migrated: false,
        },
      },
    };
  }).catch(() => null);
}

export interface SinceLastLook {
  /** True when this reviewer has looked at an earlier packet than the current one. */
  behind:  boolean;
  /** How many packets have been handed over since their last look. */
  packets: number;
  /** The packet they last read, 0 if never. */
  lastPacket: number;
  /** The current packet, 0 if there is none. */
  packet:  number;
  /** The commit their last look was at, which is what a "since your last look" diff is against. */
  sha:     string;
  /** A whole sentence for the banner, or '' when there is nothing to say. */
  banner:  string;
}

/**
 * What landed since this reviewer last looked.
 *
 * Cross-screen rule 9. A reviewer who has never looked is not "behind" - they are new to it,
 * which is a different sentence and a different control.
 */
export async function sinceLastLook(extension: string): Promise<SinceLastLook> {
  const [record, look, state] = await Promise.all([
    readReview(extension), lastLook(extension).catch(() => null), readPodPackets(extension),
  ]);
  const numbers = Object.keys(state.packets).map(Number);
  const packet = numbers.length ? Math.max(...numbers) : 0;
  const lastPacket = look?.packet || 0;
  const since = numbers.filter((n) => n > lastPacket).length;
  const behind = !!lastPacket && packet > lastPacket;

  return {
    behind,
    packets:    since,
    lastPacket,
    packet,
    sha:        record.packets[String(lastPacket)]?.sha || look?.sha || '',
    banner:     behind
      ? `${ since } change${ since === 1 ? '' : 's' } landed since you last looked at packet ${ lastPacket }.`
      : '',
  };
}

/**
 * Bring the old per-extension deferral into the per-reviewer record, once.
 *
 * `git config --local barn.review.deferred` was the right home for a deferral when there was
 * nowhere better, and the wrong home for anything with a person attached. Migrating it
 * attributes an old deferral to whoever first opens the queue after the upgrade, which is a
 * guess - so the record says `migrated: true` and the UI has to say "deferred before this
 * Studio recorded who defers" rather than putting somebody's name on it.
 *
 * Reading the config is left to the caller (`readDeferral` in extensions.ts owns that key), so
 * this file does not grow a second reader of it.
 */
export async function migrateDeferral(
  extension: string, deferral: { at: string; note: string } | null
): Promise<boolean> {
  if (!deferral?.at) {
    return false;
  }

  const signer = await currentSigner();
  const key = principalKey(signer.principal);
  let migrated = false;

  await updateReview(extension, (record) => {
    if (record.looks[key]?.deferred || record.looks[key]?.migrated) {
      return record;
    }

    migrated = true;

    return {
      ...record,
      looks: {
        ...record.looks,
        [key]: {
          principal: signer.principal,
          name:      signer.name,
          packet:    0,
          sha:       '',
          at:        deferral.at,
          deferred:  deferral.at,
          note:      deferral.note,
          migrated:  true,
        },
      },
    };
  });

  return migrated;
}

/**
 * A reviewer's sentence about one hunk.
 *
 * Recorded before it is sent, and separately from being sent, because the two fail
 * independently: a comment that reached the record and not the assistant is a comment the
 * author can still read, and one that vanished because the pod was down would be the reviewer
 * writing it twice.
 */
export async function addComment(
  extension: string, { packet = 0, file = '', hunk = 0, text }: { packet?: number; file?: string; hunk?: number; text: string }
): Promise<ReviewComment> {
  const body = text.trim();

  if (!body) {
    throw new Error('there is nothing in the comment');
  }

  const signer = await currentSigner();
  const comment: ReviewComment = {
    id:        `c${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 6) }`,
    packet,
    file,
    hunk,
    text:      body,
    principal: signer.principal,
    name:      signer.name,
    at:        new Date().toISOString(),
    sentAt:    '',
    sentHow:   '',
  };

  await updateReview(extension, (record) => ({ ...record, comments: [...record.comments, comment] }));

  return comment;
}

/** Record that a comment reached the assistant, and how. */
export async function markCommentSent(extension: string, id: string, how: string): Promise<void> {
  await updateReview(extension, (record) => ({
    ...record,
    comments: record.comments.map((c) => (c.id === id ? { ...c, sentAt: new Date().toISOString(), sentHow: how } : c)),
  }));
}

/** One comment by id, for the workspace to show when it is opened with `?comment=<id>`. */
export async function readComment(extension: string, id: string): Promise<ReviewComment | null> {
  return (await readReview(extension)).comments.find((c) => c.id === id) || null;
}

/**
 * The origin stamp for a prompt this product is about to send.
 *
 * Built here because this is the file that knows who the caller is, and consumed by
 * `askAssistant`'s optional third argument, so that extensions.ts never has to read a Rancher
 * principal and the two files never form a cycle.
 *
 * A screen that does not pass one is not punished for it: the turn is recorded with no name,
 * which is the truth about a prompt nobody attributed.
 */
export async function originStamp(screen: string): Promise<{ screen: string; principal: string; name: string }> {
  const signer = await currentSigner().catch(() => ({ principal: '', name: '' }));

  return { screen, principal: signer.principal, name: signer.name };
}
