// The questions claude stops and asks, read off its own pane.
//
// The assistant is a TUI in a pod, and some of what it does is ask. "How is Claude doing this
// session?" arrives unbidden; `/model` and `/login` are asked because somebody asked for them;
// a permission prompt arrives when the tool it wants is not on the allow-list. Until now none of
// them existed as far as this extension was concerned: the pane sat waiting for a keypress
// nobody in the browser could make, the turn never ended, and the working card counted seconds
// against a question nobody could see.
//
// So this reads the pane and says whether the thing on it is a question. The pane arrives ASCII
// only - `assistantOutput` strips it, for the decoding reason given there - which means the
// selection caret and the box drawing are gone before this sees them. What survives is the part
// that matters: numbered options, and a footer naming the keys.

/** One thing that can be chosen, and the key that chooses it. */
export interface QuestionOption {
  /** What to send: "1", "2", "0". */
  key: string;
  /** What it says next to that key - the name only, not the columns after it. */
  label: string;
  /** Whatever followed the name on the line: the model picker's two description columns. */
  hint: string;
}

/**
 * The option's own name, split from the description columns beside it.
 *
 * A TUI menu is laid out in columns separated by runs of spaces, and the continuation lines of a
 * wrapped row get folded in by the reader above. Taken whole, "Default (recommended)" arrives as
 * "Default (recommended)   Opus 5 with 1M context  Best for everyday, complex tasks" and a button
 * wearing all of that is unreadable. The rest is kept rather than dropped, for the tooltip.
 */
function split(text: string): { label: string; hint: string } {
  const [label, ...rest] = text.split(/\s{2,}/);

  return { label: label.trim(), hint: rest.join(' ').replace(/\s+/g, ' ').trim() };
}

export interface AssistantQuestion {
  /** The line the options belong to - "Select model", "How is Claude doing this session?". */
  title: string;
  /** Anything between the title and the options. Often empty. */
  detail: string;
  options: QuestionOption[];
  /** Keys the footer names that are not numbered options: Enter, Esc, s. */
  keys: string[];
}

/**
 * How far up from the bottom a question can start.
 *
 * A question is the thing the pane is waiting on, so it is at the bottom of it. Numbered lines
 * further up are prose - the assistant listing three things it is about to do - and answering
 * those with a keypress would be answering nothing.
 */
const WINDOW = 16;

/** `1. Label`, `2: Label`, ` 10. Label` - both punctuations, because both are used. */
const OPTION = /^\s*(\d{1,2})[.:]\s+(\S.*)$/;

/** `1: Bad    2: Fine   3: Good   0: Dismiss` - the survey puts them all on one line. */
const INLINE = /(\d{1,2})[.:]\s+([^\d]+?)(?=\s{2,}\d{1,2}[.:]|\s*$)/g;

/** `Esc to cancel`, `Enter to set as default`, `s to use this session only`. */
const FOOTER = /\b(Esc|Enter|[a-z])\b\s+to\s+\S/;

const noise = (line: string) => !line.trim() || /^[\s>_|+-]*$/.test(line);

/**
 * A single line holding two or more `N: Label` pairs, as the session survey draws them.
 *
 * Only when there are two or more. One pair on a line is far more likely to be a sentence that
 * happens to contain a number and a colon than it is to be a menu with one item.
 */
function inlineOptions(line: string): QuestionOption[] {
  const found: QuestionOption[] = [];

  for (const match of line.matchAll(INLINE)) {
    found.push({ key: match[1], ...split(match[2]) });
  }

  return found.length >= 2 ? found : [];
}

/**
 * The question the pane is waiting on, or null if it is not waiting on one.
 *
 * Deliberately conservative. Getting this wrong in the direction of "there is a question" puts
 * buttons on the screen that send keystrokes into a working assistant, so the run of options has
 * to be near the bottom, has to have at least two of them, and has to look like a menu rather
 * than like prose: either a title that asks something, or a footer that names the keys.
 */
export function parseQuestion(pane: string): AssistantQuestion | null {
  const lines = String(pane || '').replace(/\r/g, '').split('\n');
  const tail = lines.slice(-WINDOW);

  // The survey shape first: one line, several pairs, and nothing else needed to recognise it.
  for (let i = tail.length - 1; i >= 0; i--) {
    const inline = inlineOptions(tail[i]);

    if (inline.length) {
      const { title, detail } = blockAbove(tail, i);

      return title ? {
        title, detail, options: inline, keys: [],
      } : null;
    }
  }

  // Then the list shape: consecutive numbered lines, allowing the wrapped continuation lines the
  // model picker uses.
  let end = -1;
  const options: QuestionOption[] = [];

  for (let i = tail.length - 1; i >= 0; i--) {
    const match = OPTION.exec(tail[i]);

    if (match) {
      if (end === -1) {
        end = i;
      }

      options.unshift({ key: match[1], ...split(match[2]) });
      continue;
    }

    if (end !== -1 && (noise(tail[i]) || /^\s{6,}\S/.test(tail[i]))) {
      // A blank line or a wrapped continuation between options does not end the run.
      continue;
    }

    if (end !== -1) {
      break;
    }
  }

  if (options.length < 2) {
    return null;
  }

  const keys = tail.slice(end + 1).filter((line) => FOOTER.test(line)).join(' ').trim();
  const { title, detail } = blockAbove(tail, tail.findIndex((line) => OPTION.test(line)));

  if (!title) {
    return null;
  }

  // A menu, or prose that happens to be numbered? A title that asks, or a footer that names the
  // keys, is what separates them.
  if (!/\?\s*$/.test(title) && !keys) {
    return null;
  }

  return {
    title,
    detail,
    options,
    keys: keys ? keys.split(/\s{2,}/).map((k) => k.trim()).filter(Boolean) : [],
  };
}

/**
 * What the options are for: the block of prose directly above them.
 *
 * The whole block, not the nearest line. `/model` writes a heading and then two lines of
 * description, and taking the nearest line gets "sessions. For other/previous model names,
 * specify with --model." - the tail of a sentence, presented as the question. The block's first
 * line is the heading; whatever else it holds is the detail under it.
 */
function blockAbove(lines: string[], from: number): { title: string; detail: string } {
  const block: string[] = [];

  for (let i = from - 1; i >= 0; i--) {
    const line = lines[i];

    if (OPTION.test(line)) {
      continue;
    }

    // A blank line is the top of the block. Anything above it belongs to whatever came before.
    if (noise(line)) {
      if (block.length) {
        break;
      }

      continue;
    }

    block.unshift(clean(line));
  }

  return { title: block[0] || '', detail: block.slice(1).join(' ').trim() };
}

/** The bullet claude puts on its own messages, and the box edges, are not part of the words. */
function clean(line: string): string {
  return line.replace(/^[^\w(]+/, '').replace(/\s+$/, '').trim();
}
