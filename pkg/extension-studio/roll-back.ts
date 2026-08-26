/**
 * Going back to the last build that worked, as one action rather than as one per button.
 *
 * Screen 08 draws the roll back twice: in the masthead (19:959, "Roll back to last working
 * build") and in the failure panel's changes summary (19:786). The design does not mean two
 * features that resemble each other - the flow map's amber arrow leaves "It breaks" and comes
 * back into the same workspace box, once - it means one action with two affordances, the same
 * way "Apply this fix" is drawn twice and publish-fix.ts holds the applying.
 *
 * So the applying lives here. Two buttons doing the same thing is only true if they run the
 * same code, and the previous round of work refused to duplicate the panel's roll back into the
 * masthead for exactly that reason: a copy would have been a second destructive path, and the
 * weaker of the two would have been the one somebody used the day the snapshot failed.
 *
 * What the action is, in order, and none of it is optional:
 *
 *   1. Resolve where "back" is (`findWayBack`), and refuse when the pod has no history at all
 *      rather than inventing a point.
 *   2. Snapshot the tree as it is now. **Required.** The panel's note says "Every build is
 *      snapshotted. Nothing you have done is lost" (19:1092), and that sentence is only true if
 *      the failed tree is kept. `createSnapshot` is strict - it reads the tag back - so a
 *      refusal here is git's own, and a refusal means nothing is restored. This product used to
 *      report a snapshot git had declined to write, and the roll back on top of it threw work
 *      away while promising it had not.
 *   3. Restore the point.
 *   4. Clear the failure record and any fix proposed for it, so every surface drawing the
 *      failure stops drawing it. `clearFailure` announces itself, so the masthead's badge and
 *      the panel both follow without either telling the other.
 *
 * Nothing here touches the DOM or the store. It returns the sentence to say and leaves the
 * saying to the caller, because the two callers toast through their own `$store`.
 */
import {
  createSnapshot, restoreSnapshot, baselineRef, listSnapshots, countChanges
} from './extensions';
import { readWorkingBuild, clearFailure } from './publish-failure';
import { clearProposedFix } from './publish-fix';

/**
 * How good the point is. The screens say which one they landed on rather than implying the
 * best case: "the last working build" and "the last commit that exists" are both ways back and
 * only one of them is known to compile.
 */
export type WayBackKind = 'build' | 'baseline' | 'snapshot' | 'head';

export interface RollBackTarget {
  /** The commit `restoreSnapshot` is given. */
  ref:  string;
  /** What it is, as a phrase that reads after "Roll back to". */
  what: string;
  /** Where it came from and what it is worth, for the screen to print under the button. */
  note: string;
  kind: WayBackKind;
}

export interface WayBack {
  /** Null when this extension has no history in its pod at all. */
  target:  RollBackTarget | null;
  /** Files differing from the baseline, or -1 when the pod could not be asked. */
  changes: number;
}

/**
 * Where "back" is, in the order of how well each candidate answers "the last working build".
 *
 *   1. `refs/barn/working-build`, written in the pod by the publish that installed. This is the
 *      only candidate that is literally the last build that worked, and being a ref in the
 *      extension's own repository it is the same answer for a second person, a new browser and
 *      a tab opened next week.
 *   2. The baseline the publish path writes: the tree last handed over, or last installed here.
 *   3. The most recent snapshot somebody took by hand, which is a point a person chose and not
 *      necessarily a build.
 *   4. HEAD, which always exists (`ensureRepo` commits the seeded tree).
 *
 * Every read is independently catchable: a pod that will not answer one of them should still
 * offer the ones it did answer.
 */
export async function findWayBack(extension: string): Promise<WayBack> {
  const [working, base, snaps, changes] = await Promise.all([
    readWorkingBuild(extension).catch(() => null),
    baselineRef(extension).catch(() => null),
    listSnapshots(extension).catch(() => []),
    countChanges(extension).catch(() => -1),
  ]);

  if (working) {
    return {
      changes,
      target: {
        ref:  working.ref,
        what: `the last working build${ working.version ? ` (${ working.version })` : '' }`,
        note: `Recorded in the pod when that publish succeeded, ${ working.when || 'earlier' }. It is a ref in the extension's own repository, so it is the same point for everybody and it survives this tab.`,
        kind: 'build',
      },
    };
  }

  if (base && (base.kind === 'oci' || base.kind === 'local')) {
    return {
      changes,
      target: {
        ref:  base.sha,
        what: base.kind === 'oci' ? 'the last version handed over' : 'the last version published into this Rancher',
        note: 'Recorded by the publish that put it there, so it is a tree that built.',
        kind: 'baseline',
      },
    };
  }

  if (snaps.length) {
    return {
      changes,
      target: {
        ref:  snaps[0].ref,
        what: `the snapshot "${ snaps[0].label }"`,
        note: `Taken ${ snaps[0].when }. A snapshot is a point somebody chose, not necessarily a build that worked.`,
        kind: 'snapshot',
      },
    };
  }

  if (base && base.sha) {
    return {
      changes,
      target: {
        ref:  base.sha,
        what: 'the last commit',
        note: 'No snapshot was taken before this build, so this is the last committed state rather than the last build that worked.',
        kind: 'head',
      },
    };
  }

  return { target: null, changes };
}

/**
 * How the button reads, given what there actually is to go back to.
 *
 * Shared so the masthead and the panel cannot drift into promising different things: the
 * design's masthead label is "Roll back to last working build", and printing that over a pod
 * whose only point is a hand-made snapshot would be the button lying about where it goes.
 */
export function rollBackLabel(target: RollBackTarget | null): string {
  return target ? `Roll back to ${ target.what }` : 'Roll back';
}

/**
 * What happened, in the words the caller should use.
 *
 * A result rather than an exception, and deliberately: both callers want the same two toasts,
 * and the interesting failure - the safety snapshot being refused - is not an error in the
 * caller's flow but the action correctly declining to run. Returning it keeps the two callers
 * from each having to reconstruct the sentence, which is how they would drift apart.
 */
export interface RollBackOutcome {
  ok:      boolean;
  /** Toast title. */
  title:   string;
  /** Toast body. What was kept, or why nothing moved. */
  message: string;
  /** The snapshot of the failed tree. '' when it is that snapshot that could not be taken. */
  safety:  string;
  /** Where it went, as a phrase. '' when it did not go anywhere. */
  what:    string;
}

/**
 * Put the tree back to the last build that worked, having first snapshotted what it is now.
 *
 * `target` is optional so a caller that has already resolved one (the panel, which prints its
 * note) does not resolve it twice, and a caller that has not (the masthead) does not have to.
 *
 * Never throws. Every way this can go wrong is a sentence somebody can act on, and a caller
 * that forgot a `.catch` would otherwise leave the button spinning over a tree it had already
 * half moved.
 */
export async function rollBack(extension: string, target?: RollBackTarget | null): Promise<RollBackOutcome> {
  const point = target || (await findWayBack(extension).catch(() => ({ target: null, changes: -1 }))).target;

  if (!point) {
    return {
      ok:      false,
      title:   'There is nothing to roll back to',
      message: `${ extension } has no history in its pod - no working build, no published version, no snapshot and no commit - so there is no point to put the tree back to.`,
      safety:  '',
      what:    '',
    };
  }

  // First, and it decides whether the rest happens at all. This is the one action in the
  // Studio that throws work away, and what makes it safe is that the tree it replaces is kept.
  // If it cannot be kept, the roll back does not happen: a restore that silently discarded the
  // failed tree is the worst outcome available here, and it is the one this used to produce
  // back when `createSnapshot` reported success for a tag git had refused to write.
  let safety = '';

  try {
    safety = await createSnapshot(extension, 'the failed build, before rolling back');
  } catch (e: any) {
    return {
      ok:      false,
      title:   'The roll back did not happen',
      message: `Nothing has been rolled back. The tree could not be snapshotted first, and the Studio will not replace a tree it cannot put back: ${ e?.message || e }`,
      safety:  '',
      what:    point.what,
    };
  }

  try {
    await restoreSnapshot(extension, point.ref);
  } catch (e: any) {
    // git's own reason, and its own reason is never punctuated the same way twice, so the
    // sentence is built around it rather than appended to it.
    const why = String(e?.message || e).replace(/\s*\.?\s*$/, '');

    return {
      ok:      false,
      title:   'The roll back did not happen',
      message: `Nothing was replaced: ${ why }. The tree as you left it was snapshotted first either way, so it is in the Snapshots menu.`,
      safety,
      what:    point.what,
    };
  }

  // The failure is over, and both surfaces that draw it hear about it from the record rather
  // than from each other. The fix goes with it: a suggestion for a build that no longer exists
  // would still be offered over the preview.
  clearFailure();
  clearProposedFix();

  return {
    ok:      true,
    title:   `Rolled back to ${ point.what }`,
    message: 'The tree as you left it was snapshotted first, so nothing is lost. It is in the Snapshots menu.',
    safety,
    what:    point.what,
  };
}
