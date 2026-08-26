/**
 * The last failed publish, and the last one that worked - kept where a page reload cannot lose
 * them.
 *
 * Screen 08 in the design is not a route: it is the workspace (screen 03) in its failed state,
 * with the failure drawn as a turn in the assistant's conversation and an explainer over the
 * preview. The flow map says the same thing twice - the amber arrow leaves "Build it and watch
 * it" and comes back into the *same* box - so the failure is a state this module holds, and any
 * surface that wants to draw it reads it from here.
 *
 * sessionStorage rather than localStorage because a failure is about this sitting, not about
 * this browser: a week-old build error resurfacing in a new tab would be noise, and closing the
 * tab is a reasonable way to say you are done with it.
 *
 * The one thing that is *not* here is the working tree, or the point to go back to. Rolling
 * back needs a point in the extension's own git history, which lives in the pod and outlives
 * every tab: `publishExtension` writes `refs/barn/working-build` the moment a build installs,
 * and `lastWorkingBuild` reads it back. This file used to keep that in sessionStorage too, and
 * that was the bug: the guarantee "there is always a way back" was only true in the tab that
 * had done the publishing, so a second person, a new browser or a reload had no working build
 * at all and the failure screen fell through to whichever hand-made snapshot was nearest.
 */
import { lastWorkingBuild } from './extensions';

const KEY = 'barn.publish.failure';

/**
 * Fired on `window` whenever the record changes.
 *
 * sessionStorage has no change event within the tab that wrote it, and the surface showing the
 * failure is not the code recording it: in the design the workspace is already on screen when
 * the build breaks under it. Without this, a host that stays mounted across a publish would
 * only notice the failure on a reload, and the caller would have to remember to tell it. One
 * event here means every surface that draws a failure stays in step with the record for free.
 */
export const FAILURE_EVENT = 'barn:publish-failure';

function announce(): void {
  try {
    window.dispatchEvent(new CustomEvent(FAILURE_EVENT));
  } catch { /* no window, no listeners; nothing to tell */ }
}

export interface PublishFailure {
  extension: string;
  message:   string;
  log:       string;
  /** Milliseconds since the epoch, stamped when the failure was recorded. */
  at:        number;
  /**
   * Which step of the publish died, when the caller knew (`PublishError.stage`).
   *
   * Optional because the caller has not always got it, and `failureStage` below infers it from
   * the message when it is missing. It is the design's sub-line: the difference between "it did
   * not compile" and "it compiled and installing it is what broke" is the first thing a person
   * needs and the last thing a raw log says.
   */
  stage?:    string;
}

/** The tree that last built and installed successfully, as somewhere to go back to. */
export interface WorkingBuild {
  extension: string;
  /** The commit `refs/barn/working-build` points at. `restoreSnapshot` takes it. */
  ref:       string;
  /** The version that was published, off the ref's own commit subject. '' when it says none. */
  version:   string;
  /** git's own relative wording for when that publish was, for a screen to render. */
  when:      string;
}

/**
 * Which step of the publish the message came from, when nobody recorded the step.
 *
 * `publishExtension` throws with a small, fixed set of messages, one per stage, so this is a
 * read of what actually happened rather than a guess at it. Anything it does not recognise
 * returns '' and the screen says nothing rather than something wrong - a sub-line that
 * confidently blames the wrong half of the publish is worse than no sub-line.
 */
export function failureStage(message: string): string {
  const text = String(message || '');

  if (/has no running pod/i.test(text)) {
    return 'The pod that builds this extension was not running, so nothing was built.';
  }

  if (/did not build/i.test(text)) {
    return 'The build itself failed. Nothing was installed, and this Rancher is still loading whatever it was loading before.';
  }

  if (/could not be copied/i.test(text)) {
    return 'The extension built. Putting the bundle where the pod serves it is what failed.';
  }

  if (/no settings|no repository|token/i.test(text)) {
    return 'The publish stopped before it built anything, on its settings.';
  }

  return '';
}

export function recordFailure(extension: string, message: string, log: string, stage = ''): void {
  try {
    const failure: PublishFailure = {
      extension, message, log, at: Date.now(), stage,
    };

    window.sessionStorage.setItem(KEY, JSON.stringify(failure));
  } catch { /* storage can be unavailable; the screen falls back to saying so */ }

  announce();
}

export function readFailure(extension: string): PublishFailure | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const failure = raw ? JSON.parse(raw) as PublishFailure : null;

    // A failure belonging to a different extension is not this screen's failure.
    return failure && failure.extension === extension ? failure : null;
  } catch {
    return null;
  }
}

export function clearFailure(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch { /* see recordFailure */ }

  announce();
}

/**
 * Check that the publish that just worked left a way back, and say so when it did not.
 *
 * The design's word is "guaranteed": "plain-language cause, one-click fix, guaranteed way back"
 * (23:914). The point itself is no longer this file's to take - `publishExtension` writes
 * `refs/barn/working-build` at the only moment anything can know a tree works, which is the
 * moment it has just been built and installed - so what is left here is the check, at the one
 * moment somebody is in a position to act on the answer.
 *
 * It never throws and never fails a publish: the publish already worked, and the caller does
 * not await it. The returned sentence is for a caller that wants to say something; ignoring it
 * costs nothing, because the failure screen reads the same ref later and states plainly which
 * kind of point it found (see `findWayBack` in components/BuildFailure.vue).
 */
export async function recordWorkingBuild(extension: string, version = ''): Promise<string> {
  try {
    const point = await lastWorkingBuild(extension);

    if (point) {
      return '';
    }

    return `The publish worked, but no working-build ref was written in ${ extension }'s pod${ version ? ` for ${ version }` : '' }, so a later build failure will have no proved-good build to roll back to.`;
  } catch (e: any) {
    return `The publish worked, and ${ extension }'s pod could not be asked whether a working-build ref was written: ${ e?.message || e }`;
  }
}

/**
 * The last build of this extension that worked, read out of the pod.
 *
 * Async now, and that is the point of it: the answer is a ref in the extension's repository
 * rather than something this browser remembers, so it is the same answer for everybody and it
 * survives the tab that did the publishing.
 */
export async function readWorkingBuild(extension: string): Promise<WorkingBuild | null> {
  const point = await lastWorkingBuild(extension).catch(() => null);

  if (!point?.sha) {
    return null;
  }

  // `recordBaseline` wrote the subject as "Working build <plugin> <version>". Read rather than
  // assumed: a subject that does not match yields no version and the screen says less.
  const version = /^Working build \S+ (\S+)$/.exec(point.subject)?.[1] || '';

  return {
    extension, ref: point.sha, version, when: point.when,
  };
}
