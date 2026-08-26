// The context line the composer writes onto a prompt, and how to take it off again.
//
// `withContext` in the assistant panel prefixes what somebody typed with the page they were
// looking at and the files they attached, so the pod's assistant knows what "this" refers to.
// The pod records the whole string, which means every screen that shows a prompt back is
// showing the product's own plumbing as though a person had said it.
//
// Both halves are wanted, just not as one sentence: the context belongs beside the message as
// the chips it was attached as, and the message belongs on its own. This is the one place that
// knows how to separate them, so the stream and the change-set rail cannot disagree about
// where a prompt ends and its plumbing begins.

export interface PromptParts {
  /** The context the composer wrote, still `;`-separated. '' when there was none. */
  context: string;
  /** What the person actually typed. */
  said:    string;
}

/**
 * Split a recorded prompt, or answer null when it does not have the shape.
 *
 * Two separators, because the log holds both. ` :: ` is what the composer writes today, chosen
 * because a path or a selector cannot contain it. Everything recorded before that ends its
 * prefix with a full stop, and those are most of the change sets that exist - so they are read
 * too, on a rule narrow enough to be safe: a full stop FOLLOWED BY a space and then a capital.
 * `pages/Home.vue` and `.base-home__stamp` both put a dot mid-word with no space after it,
 * which is exactly what made splitting on the first full stop wrong when it was tried.
 *
 * Null rather than a guess when neither matches, and the caller shows the prompt whole. A
 * prompt shown in full is right; a prompt with its first sentence eaten is not.
 */
export function splitPrompt(text: string): PromptParts | null {
  const raw = String(text || '');
  const modern = /^Context:([\s\S]*?)\s::\s([\s\S]*)$/.exec(raw);

  if (modern) {
    return { context: modern[1], said: modern[2] };
  }

  const legacy = /^Context:([\s\S]*?)\.\s+(?=[A-Z"'`‘“])([\s\S]*)$/.exec(raw);

  return legacy ? { context: legacy[1], said: legacy[2] } : null;
}

/** What a person typed, with the composer's prefix off. The whole thing when there is none. */
export function promptSaid(text: string): string {
  return splitPrompt(text)?.said ?? String(text || '');
}

/**
 * The context as the chips it was attached as.
 *
 * Shortened from the end, because a path's last segments are the identifying half and its
 * first are the part every chip on the row shares. The whole of it stays on the title.
 */
export interface ContextChip {
  /** What the chip says, spelled the way the composer spells it. */
  label: string;
  /** The whole of what it was made from, for the title. */
  title: string;
  /**
   * What clicking it should do.
   *
   * `page` names a route and takes the preview there; `element` names something in the rendered
   * page and outlines it; `image` names a picture and opens it. `plain` is anything this cannot
   * classify, which stays a label and nothing more - the safe answer, because a chip that looks
   * clickable and does nothing is worse than one that never offered.
   */
  kind:  'page' | 'element' | 'image' | 'plain';
  /** The route for `page`, the selector for `element`, the path for `image`. */
  value: string;
  /** The page this chip's own message was about, when its context named one. */
  page:  string;
}

export function promptContextChips(text: string, max = 4): ContextChip[] {
  const parts = splitPrompt(text);

  if (!parts) {
    return [];
  }

  const items = parts.context
    // Both separators: the composer joins several attached paths with a comma, and the older
    // form put a semicolon between the page and the files. Neither can appear inside a path
    // or a class selector, which is why they were chosen as separators in the first place.
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((part) => ({
      label: chipLabel(part), title: part, page: '', ...chipAction(part),
    }));

  // Every chip carries the page its own message was about.
  //
  // An element chip names something in a rendered page, and the page it was rendered in is
  // sitting right beside it in the same context line. Without that, pressing it can only try
  // the page the preview happens to be showing and give up - which for any message older than
  // the last navigation is always the wrong page.
  const page = items.find((item) => item.kind === 'page')?.value || '';

  return items.map((item) => ({ ...item, page }));
}

/**
 * What a context item points at, if anything.
 *
 * Read from the same shapes `chipLabel` reads, so what a chip says and what it does cannot
 * disagree: the one that reads `page: /x` goes to `/x`, and the one naming an element outlines
 * that element.
 */
function chipAction(part: string): { kind: ContextChip['kind']; value: string } {
  const page = /^the preview is on\s+(\S+)/.exec(part);

  if (page) {
    return { kind: 'page', value: page[1] };
  }

  const element = /\(the (.+?) element\)/.exec(part);

  if (element) {
    return { kind: 'element', value: element[1] };
  }

  if (/\.(png|jpe?g|gif|webp)$/i.test(part)) {
    return { kind: 'image', value: part };
  }

  return { kind: 'plain', value: part };
}

/**
 * One context item, spelled the way the composer spells it.
 *
 * The composer's chips read `page: /c/local/home`, `pages/Home.vue`, `cluster: local` - a short
 * prefix and the identifying end of a path, cut off by CSS when the row runs out of room. What
 * the pod records is the same facts written as prose, and showing that verbatim gave the chat
 * history chips like `… on /node-conditions/c/local/home` - a leading ellipsis where the
 * composer has none, sentence fragments where the composer has labels, and a length no rule
 * was clipping. Same facts, so they are written the same way here.
 */
function chipLabel(part: string): string {
  const page = /^the preview is on\s+(\S+)/.exec(part);

  if (page) {
    return `page: ${ page[1] }`;
  }

  // `pkg/x/pages/Home.vue (the p.base-home__stamp element)` - the element is the specific half.
  const element = /\(the (.+?) element\)/.exec(part);

  if (element) {
    return element[1];
  }

  // A path: its last two segments, which is `shortPath` in the composer.
  return part.includes('/') ? part.split('/').slice(-2).join('/') : part;
}
