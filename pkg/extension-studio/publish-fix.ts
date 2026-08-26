/**
 * The change the assistant proposed for a failed build, and the one way to apply it.
 *
 * Screen 08 puts the same fix in two places: "Apply this fix" in the failure card (19:1022) and
 * "Apply the suggested fix" over the preview (19:1083), with a note on the second saying it
 * "must do the same thing" as the first. Two buttons doing the same thing is only true if they
 * run the same code, so the applying lives here rather than in either component, and the fix
 * itself is recorded where both of them can read it.
 *
 * sessionStorage for the same reason publish-failure.ts uses it: a proposed fix is about this
 * sitting with this failure, and a suggestion from a week ago resurfacing in a new tab would be
 * noise. It is cleared when it is applied, when the failure it belongs to is cleared, and when
 * the assistant is asked again.
 *
 * Nothing here invents a fix. The record is only ever written from an answer the assistant
 * wrote, and `applyProposedFix` refuses out loud when the text it quoted is not in the file as
 * written - a model quoting a line approximately is the ordinary case, and a fuzzy match that
 * edited the wrong line is exactly the silent damage this product does not do.
 */
import {
  listExtensionFiles, readExtensionFile, writeExtensionFile, createSnapshot
} from './extensions';

const KEY = 'barn.publish.fix';

/** Fired on `window` whenever the record changes. See FAILURE_EVENT for why this exists. */
export const FIX_EVENT = 'barn:publish-fix';

export interface ProposedFix {
  extension: string;
  /** The path the assistant named, as it named it. Resolved against the package when applied. */
  path:      string;
  /** The exact text to replace, copied out of the file by whoever proposed it. */
  before:    string;
  after:     string;
  at:        number;
}

function announce(): void {
  try {
    window.dispatchEvent(new CustomEvent(FIX_EVENT));
  } catch { /* no window, no listeners; nothing to tell */ }
}

/** Whether an object off the assistant is a fix this product could actually apply. */
export function isApplicable(fix: any): boolean {
  return !!fix && typeof fix === 'object'
    && typeof fix.path === 'string' && !!fix.path
    && typeof fix.before === 'string' && !!fix.before
    && typeof fix.after === 'string';
}

export function recordProposedFix(extension: string, fix: { path: string; before: string; after: string }): void {
  if (!isApplicable(fix)) {
    return;
  }

  try {
    const record: ProposedFix = {
      extension, path: fix.path, before: fix.before, after: fix.after, at: Date.now(),
    };

    window.sessionStorage.setItem(KEY, JSON.stringify(record));
  } catch { /* storage can be unavailable; the surfaces then simply have no fix to offer */ }

  announce();
}

export function readProposedFix(extension: string): ProposedFix | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const fix = raw ? JSON.parse(raw) as ProposedFix : null;

    return fix && fix.extension === extension && isApplicable(fix) ? fix : null;
  } catch {
    return null;
  }
}

export function clearProposedFix(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch { /* see recordProposedFix */ }

  announce();
}

/**
 * Apply the proposed change to the file it names, having snapshotted the tree first.
 *
 * A literal replacement of text the assistant said is in the file, checked against the file as
 * it is now rather than as it was when the answer was written. The snapshot is what makes the
 * apply itself undoable, which is the same guarantee the roll back gives.
 *
 * Returns the path it changed, so the caller can name it. Throws with the reason otherwise, and
 * every reason is a sentence a person can act on.
 */
export async function applyProposedFix(
  extension: string, fix: { path: string; before: string; after: string }
): Promise<string> {
  if (!isApplicable(fix)) {
    throw new Error('The assistant did not propose a change this screen could apply.');
  }

  const wanted = String(fix.path).replace(/^\.\//, '');
  const paths = await listExtensionFiles(extension);
  const path = paths.find((p) => p === wanted)
    || paths.find((p) => p.endsWith(`/${ wanted }`))
    || paths.find((p) => p.endsWith(`/${ wanted.split('/').pop() }`))
    || '';

  if (!path) {
    throw new Error(`The fix names ${ fix.path }, and there is no such file in this extension.`);
  }

  const text = await readExtensionFile(extension, path);

  if (!text.includes(fix.before)) {
    throw new Error(`The line the assistant quoted is not in ${ path } as written, so this cannot be applied for you. Open the file and make the change by hand.`);
  }

  // Required, not best effort, and this is the order it has to happen in: the write below
  // overwrites somebody's file with a model's suggestion, and the only thing that makes that
  // reversible is a snapshot of the file as it is now. `createSnapshot` is strict - it verifies
  // the tag it wrote - so a refusal arrives here with git's own reason, and a refusal means the
  // fix is not applied. Applying it anyway would be the panel promising a way back it has not
  // got, which is the one promise on that screen that has to be true.
  try {
    await createSnapshot(extension, 'before applying the suggested fix');
  } catch (e: any) {
    throw new Error(`${ path } has not been changed, because the tree could not be snapshotted first and applying a fix has to be undoable: ${ e?.message || e }`);
  }

  // A function, not a string. `String.replace` reads `$&`, `$1` and `` $` `` in a replacement
  // string as substitutions, and the assistant's `after` is somebody's source line - a template
  // literal or a jQuery-ish selector in it would be silently rewritten.
  await writeExtensionFile(extension, path, text.replace(fix.before, () => fix.after));

  clearProposedFix();

  return path;
}
