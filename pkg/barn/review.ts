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
  BASELINE_OCI_REF, BASELINE_LOCAL_REF,
  type PublishProgress, type GithubPublishResult,
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

/** Record an answer to the code question (screen 12). */
export async function signCodeReview(
  extension: string,
  {
    verdict, sha, note = '', packet = 0,
  }: { verdict: string; sha: string; note?: string; packet?: number }
): Promise<Signoff> {
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

// ---------------------------------------------------------------------------
// The packet: the thing that is handed over.
//
// Steps 5 and 6 of scripts/feature-audit/REVIEW-SYSTEM.md. The gate is one boundary with two
// halves at the same place. Entering it - the push - assembles the packet and produces the
// pull request; leaving it - the distribution - is refused until two different principals have
// signed the two different questions against that packet.
//
// The two halves need different checks, and that difference is the point. Pushing requires a
// brief and something to hand over. It does not require a sign-off, because pushing is how you
// *ask* for one.
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
 * It refuses without a brief, which is how rule 14 becomes structural rather than a button
 * somebody remembered to press: a change with nothing to compare it against cannot be handed
 * to anybody, so the requirement lives at the boundary and not on the brief screen.
 */
export async function assemblePacket(extension: string): Promise<PacketRecord> {
  // Anything still uncommitted goes in first. Usually there is nothing: the assistant's Stop
  // hook commits each turn as it ends. What is left is what a person typed in the Terminal
  // tab, and a packet that quietly left it out would be a hand-over of something other than
  // what is in the pod.
  await runInPackage(extension, [
    'git add -A',
    `git diff --cached --quiet || git -c user.email=barn@rancher.local -c user.name=barn commit -q -m ${ shellSingleQuote('Uncommitted work, swept in at the hand-over') }`,
  ].join(' ; ')).catch(() => '');

  const [state, signer] = await Promise.all([readPodPackets(extension), currentSigner()]);

  if (!state.head) {
    throw new Error(`${ extension } has no git history in its pod, so there is nothing to hand over`);
  }

  if (!state.brief) {
    throw new Error(
      'This change has no brief. The brief is what a reviewer compares the change against and what the outcome sign-off walks, so a change cannot be handed over without one. Write it on the brief screen first.'
    );
  }

  const numbers = Object.keys(state.packets).map(Number);
  const latest = numbers.length ? Math.max(...numbers) : 0;

  if (latest && state.packets[latest] === state.head) {
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
 */
export async function handOverForReview(
  extension: string, repo: string, onProgress?: PublishProgress
): Promise<Packet> {
  const total = HANDOVER_STAGES.length;
  const report = (stage: number) => onProgress?.(stage, HANDOVER_STAGES[stage - 1], total);

  report(1);

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
    brief.trim() || '_There is no brief in the tree, which should not have been possible._',
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
  return !!signoff.sha && signoff.sha === sha;
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
    return answer('no-brief', 'This change has no brief, so there is nothing to compare it against and nothing to hand over.');
  }

  if (!packet) {
    return answer(
      'no-packet',
      'This change has never been handed over, so nobody has been asked to review it. Push it for review first.'
    );
  }

  if (state.head && sha && state.head !== sha) {
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
