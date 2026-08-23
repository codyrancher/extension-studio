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
 * The one thing that is *not* here is the working tree. Rolling back needs a point in the
 * extension's own git history, which lives in the pod and outlives every tab - see
 * `recordWorkingBuild` below and `createSnapshot` / `baselineRef` in extensions.ts.
 */
import { createSnapshot } from './extensions';

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

/** Per extension: the snapshot taken of the tree that last published successfully. */
const WORKING_KEY = 'barn.publish.working';

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
  /** A git ref in the pod - the tag `createSnapshot` wrote. `restoreSnapshot` takes it. */
  ref:       string;
  /** The version that was published, for the label. */
  version:   string;
  at:        number;
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
 * Remember the tree that just published, as the point a failed build can be rolled back to.
 *
 * The design's word is "guaranteed": "plain-language cause, one-click fix, guaranteed way back"
 * (23:914), and the preview's note spells out what would make it one - "Every build is
 * snapshotted. Nothing you have done is lost." A guarantee is a snapshot taken *before* the
 * change, so it has to be taken by whoever ran the successful publish, at the moment it
 * succeeded. Nothing else in the product can go back and take it later.
 *
 * Best effort, and deliberately not awaited by its caller: a publish that worked is not undone
 * by a tag that could not be written. The cost of a failure here is that the failure screen
 * offers the next-best point it can find (see `findWayBack` in components/BuildFailure.vue)
 * and says which one it is, rather than claiming a working build it has not got.
 */
export async function recordWorkingBuild(extension: string, version = ''): Promise<void> {
  try {
    const label = version ? `working build ${ version }` : 'working build';
    const ref = await createSnapshot(extension, label);

    if (!ref) {
      return;
    }

    const all = readWorkingBuilds();

    all[extension] = {
      extension, ref, version, at: Date.now(),
    };
    window.sessionStorage.setItem(WORKING_KEY, JSON.stringify(all));
  } catch { /* see the note above: this never fails a publish */ }
}

export function readWorkingBuild(extension: string): WorkingBuild | null {
  const found = readWorkingBuilds()[extension];

  return found && found.ref ? found : null;
}

function readWorkingBuilds(): Record<string, WorkingBuild> {
  try {
    const raw = window.sessionStorage.getItem(WORKING_KEY);
    const all = raw ? JSON.parse(raw) as Record<string, WorkingBuild> : {};

    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}
