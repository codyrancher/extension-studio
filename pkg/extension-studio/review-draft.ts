/**
 * The assistant's answer to a review comment, as a change nobody has applied (Figma 38:1306).
 *
 * The design's block says "The assistant has drafted a fix - 1 file, +7 -2", explains it in
 * plain language, and states that the author approves it first. Three things have to be true for
 * that block to be honest: the assistant has to have answered, the answer has to be a change with
 * a size, and the change has to still be a draft. This module is how all three become facts.
 *
 * It is the mechanism screen 08 already uses for a failed build (`components/BuildFailure.vue`),
 * pointed at a review comment instead of a build log: the assistant is asked, in one line, to
 * write JSON and nothing else to a file and to change nothing. The Studio then reads that file.
 * Asking for a file rather than for prose is what makes the answer a *record* - it has a shape,
 * it can be sized, it can be diffed, and it survives the browser being closed - and asking it not
 * to edit anything is what keeps the draft a draft.
 *
 * Where the record lives is the pod, not the browser. `/tmp` rather than the package, because a
 * file written into the package would appear in the very diff the reviewer is reading, and a
 * review that changes what it is reviewing by being opened is not a review. The consequence is
 * the good one: a draft outlives a reload, a new tab and a different reviewer, because it is in
 * the pod where the change is.
 *
 * Nothing here invents a fix, and nothing here applies one. `draftPatch` renders what would
 * change against the file as it is now, so a draft that quoted a line which has since moved shows
 * as unappliable rather than as a diff of something that is no longer there.
 */
import {
  askAssistant, extensionPod, podExecOnce, readExtensionFile, listExtensionFiles, runInPackage
} from './extensions';
import type { AssistantOrigin } from './extensions';

/** Where a draft is written in the pod. One file per comment, so two answers cannot collide. */
export function draftFile(commentId: string): string {
  return `/tmp/barn-review-${ commentId.replace(/[^\w-]/g, '') }.json`;
}

/**
 * The marker that says a draft was asked for and has not arrived.
 *
 * In the pod beside the answer, not in the browser, so "waiting" survives a reload the same way
 * the answer does. Without it a reviewer who reloads while the assistant is thinking is offered
 * the button again, as though nothing had been asked - and pressing it asks a second time.
 */
export function askedFile(commentId: string): string {
  return `/tmp/barn-review-${ commentId.replace(/[^\w-]/g, '') }.asked`;
}

/** What the assistant wrote, once it has been read back and understood. */
export interface DraftFix {
  path:   string;
  before: string;
  after:  string;
}

export interface ReviewDraft {
  commentId:   string;
  /** One short sentence in plain language: what the change does. */
  headline:    string;
  /** Two or three sentences: why. The design's explanation block (38:1313). */
  explanation: string;
  /** The change itself, or null when the assistant answered and proposed no edit. */
  fix:         DraftFix | null;
  /** What it wrote when it did not write JSON. Shown as itself rather than discarded. */
  raw:         string;
}

const MARKER = 'BARN-DRAFT';

/**
 * Ask for a draft, in the one line `askAssistant` can deliver.
 *
 * Everything about the wording is doing a job. "Do not change any file" is what makes the answer
 * a draft; naming the file and the keys is what makes it readable; "before is the exact text to
 * replace, copied character for character" is what lets the apply be a literal replacement rather
 * than a fuzzy match, which is the difference between a change you can check and a change that
 * quietly edited the wrong line.
 */
export function draftPrompt(
  { extension, commentId, file, line, text }:
  { extension: string; commentId: string; file: string; line: number; text: string }
): string {
  const where = file ? `on ${ file }${ line ? ` at line ${ line }` : '' }` : 'on this change';

  return [
    `A reviewer left this comment ${ where } in the ${ extension } extension in this pod:`,
    `"${ text.replace(/"/g, "'") }".`,
    'Do not change any file, do not run the build and do not commit anything.',
    `Work out the smallest change that answers it and write your answer as JSON and nothing else to ${ draftFile(commentId) }.`,
    'Keys: headline, one short sentence in plain language saying what the change would do;',
    'explanation, two or three sentences saying why, in the words a reviewer would use;',
    'fix, either null or an object with path, before and after, where path is the file relative to',
    'the package root, before is the exact text to replace copied character for character out of',
    'the file, and after is what to replace it with, both as short as they can be.',
    'Write that one file and stop: the change is not applied, the author approves it first.',
  ].join(' ');
}

export async function askForDraft(
  extension: string,
  comment: { id: string; file: string; hunk: number; text: string },
  origin?: AssistantOrigin
): Promise<'sent' | 'queued'> {
  const prompt = draftPrompt({
    extension,
    commentId: comment.id,
    file:      comment.file,
    line:      comment.hunk,
    text:      comment.text,
  });

  // A file left over from a previous ask would be read as this ask's answer the moment the
  // screen polls, so the slate is cleared before the question goes out - and the marker is put
  // down in the same breath, so the wait is recorded from the instant the question is asked
  // rather than from whenever the screen next happens to look.
  await runInPackage(
    extension,
    `rm -f ${ draftFile(comment.id) } ; : > ${ askedFile(comment.id) }`
  ).catch(() => {});

  return askAssistant(extension, prompt, origin);
}

/** Whether an object the assistant wrote is a change this product could actually render. */
export function isDraftFix(fix: any): fix is DraftFix {
  return !!fix && typeof fix === 'object'
    && typeof fix.path === 'string' && !!fix.path
    && typeof fix.before === 'string' && !!fix.before
    && typeof fix.after === 'string';
}

/**
 * One answer file, read into a draft.
 *
 * Tolerant about what surrounds the JSON and strict about the JSON itself: a model asked for
 * "JSON and nothing else" very often writes it inside a fence, and refusing that would throw away
 * a perfectly good answer over punctuation. Anything that is not an object at all is kept as
 * `raw`, because "it answered in prose" is a state the screen has to be able to show.
 */
export function parseDraft(commentId: string, body: string): ReviewDraft | null {
  const text = (body || '').trim();

  if (!text) {
    return null;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed: any = null;

  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      commentId, headline: '', explanation: '', fix: null, raw: text,
    };
  }

  return {
    commentId,
    headline:    String(parsed.headline || '').trim(),
    explanation: String(parsed.explanation || parsed.cause || '').trim(),
    fix:         isDraftFix(parsed.fix) ? {
      path: parsed.fix.path, before: parsed.fix.before, after: parsed.fix.after,
    } : null,
    raw:         isDraftFix(parsed.fix) || parsed.headline ? '' : text,
  };
}

/**
 * Every draft this pod is holding, in one exec.
 *
 * One read for the whole screen rather than one per comment: a pod exec is most of a second and
 * a thread with four comments on it would spend four of them saying "nothing yet".
 *
 * Newlines are flattened before the file comes back, which is safe by construction: a literal
 * newline inside a JSON string is illegal JSON, so every newline in a well-formed answer is
 * between tokens and means nothing.
 */
export async function readDrafts(extension: string): Promise<Record<string, ReviewDraft | null>> {
  const pod = await extensionPod(extension);

  if (!pod) {
    return {};
  }

  const out = await podExecOnce(pod, ['/bin/sh', '-c', [
    // The waits first, so an answer read in the same pass overwrites its own marker rather
    // than the other way round.
    'for f in /tmp/barn-review-*.asked ; do',
    '[ -f "$f" ] || continue ;',
    `printf '${ MARKER }:%s:\\n' "$(basename "$f" .asked)" ;`,
    'done ;',
    'for f in /tmp/barn-review-*.json ; do',
    '[ -f "$f" ] || continue ;',
    `printf '${ MARKER }:%s:' "$(basename "$f" .json)" ;`,
    "tr '\\n' ' ' < \"$f\" ;",
    "printf '\\n' ;",
    'done',
  ].join(' ') ]).catch(() => '');

  const drafts: Record<string, ReviewDraft | null> = {};

  out.split('\n').forEach((line) => {
    const m = new RegExp(`^${ MARKER }:barn-review-([\\w-]+):(.*)$`).exec(line.trim());

    if (!m) {
      return;
    }

    // An empty body is the marker: asked, nothing back yet. `null` is that state, and it is
    // distinct from the key being absent, which means nobody has asked.
    drafts[m[1]] = m[2].trim() ? parseDraft(m[1], m[2]) : null;
  });

  return drafts;
}

/** Throw the draft away, in the pod. The reviewer asked again, or does not want it. */
export async function discardDraft(extension: string, commentId: string): Promise<void> {
  await runInPackage(extension, `rm -f ${ draftFile(commentId) } ${ askedFile(commentId) }`).catch(() => {});
}

/** The path the draft names, resolved against the package the way `applyProposedFix` resolves it. */
export async function resolveDraftPath(extension: string, wanted: string): Promise<string> {
  const asked = String(wanted || '').replace(/^\.\//, '');
  const paths = await listExtensionFiles(extension);

  return paths.find((p) => p === asked)
    || paths.find((p) => p.endsWith(`/${ asked }`))
    || paths.find((p) => p.endsWith(`/${ asked.split('/').pop() }`))
    || '';
}

export interface DraftPatch {
  /** A unified diff of exactly what would change, for DiffView. '' when it cannot be made. */
  patch:   string;
  path:    string;
  added:   number;
  removed: number;
  /** Why there is no patch, when there is none. A sentence, not a code. */
  problem: string;
}

/**
 * The draft as a diff of the file as it is now.
 *
 * Whole lines, always. The assistant's `before` is frequently part of a line - an attribute, a
 * default, half a condition - and a diff that showed the fragment would be a diff of something
 * that is not in the file. So the replacement is widened to the lines it touches, and the two
 * versions of those lines are what the hunk shows. The line numbers are the file's own.
 *
 * Read against the current file rather than against a copy taken when the answer was written, so
 * a draft whose quoted text has since been edited away reports that instead of rendering a change
 * that could not be made.
 */
export async function draftPatch(extension: string, fix: DraftFix): Promise<DraftPatch> {
  const empty = (problem: string): DraftPatch => ({
    patch: '', path: '', added: 0, removed: 0, problem,
  });

  const path = await resolveDraftPath(extension, fix.path);

  if (!path) {
    return empty(`The draft names ${ fix.path }, and there is no such file in this extension.`);
  }

  const text = await readExtensionFile(extension, path);
  const at = text.indexOf(fix.before);

  if (at < 0) {
    return empty(`The text the assistant quoted is not in ${ path } as it stands now, so there is nothing to show as a diff. The file has been edited since the draft was written, or the quote is not exact.`);
  }

  // Widen to whole lines: the start of the line the replacement begins on, and the end of the
  // line it ends on.
  const from = text.lastIndexOf('\n', at) + 1;
  const endOfMatch = at + fix.before.length;
  const nextBreak = text.indexOf('\n', endOfMatch);
  const to = nextBreak === -1 ? text.length : nextBreak;

  const oldBlock = text.slice(from, to);
  const newBlock = text.slice(from, at) + fix.after + text.slice(endOfMatch, to);

  const oldLines = oldBlock.split('\n');
  const newLines = newBlock.split('\n');
  const before = text.slice(0, from);
  const startLine = before ? before.split('\n').length : 1;

  // Three lines of context each side, the same as the diffs everywhere else on this screen.
  const all = text.split('\n');
  const headFrom = Math.max(1, startLine - 3);
  const head = all.slice(headFrom - 1, startLine - 1);
  const tail = all.slice(startLine - 1 + oldLines.length, startLine - 1 + oldLines.length + 3);

  const body = [
    ...head.map((l) => ` ${ l }`),
    ...oldLines.map((l) => `-${ l }`),
    ...newLines.map((l) => `+${ l }`),
    ...tail.map((l) => ` ${ l }`),
  ];

  const oldCount = head.length + oldLines.length + tail.length;
  const newCount = head.length + newLines.length + tail.length;

  const patch = [
    `diff --git a/${ path } b/${ path }`,
    `--- a/${ path }`,
    `+++ b/${ path }`,
    `@@ -${ headFrom },${ oldCount } +${ headFrom },${ newCount } @@`,
    ...body,
    '',
  ].join('\n');

  return {
    patch, path, added: newLines.length, removed: oldLines.length, problem: '',
  };
}

/** `1 file, +7 -2`, the design's own summary of the draft's size (38:1306). */
export function draftSize(patch: DraftPatch): string {
  if (!patch.patch) {
    return '';
  }

  return `1 file, +${ patch.added } −${ patch.removed }`;
}
