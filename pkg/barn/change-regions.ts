// Choosing which of several matches to outline.
//
// A selector recorded by a capture names one element in the page it was recorded from, but the
// live preview is asked the same question a minute later against a page that has re-rendered,
// and a selector out of a patch - `.card`, `[role="alert"]` - was never a single element to
// begin with. So a match is a set, and something has to choose from it.
//
// The rule is the one the highlight is for: mark the region that changed, or the nearest
// element containing it. Between two matches where one contains the other, the inner one is
// the tighter true answer and the outer one is padding. And nothing that covers the page is an
// answer at all: "it changed somewhere below" is what a highlight is supposed to replace.
//
// Rectangles rather than elements, so this is arithmetic and can be checked without a browser.

/** Anything with a box. Elements are passed through as `el`, which nothing here looks at. */
export interface Box {
  x:      number;
  y:      number;
  width:  number;
  height: number;
}

/**
 * A box bigger than this share of the viewport is the page, not a place in it.
 *
 * The pod's capture applies this rule too, to the same selectors, before it draws anything on
 * a change set's picture - so a mark that names the whole page is dropped by whichever side
 * measures it, and the Changes tab and the live preview cannot end up outlining different
 * things. It cannot import this file (it is seeded into a pod as text and run by node with
 * nothing else on disk), so the number is written there as well;
 * scripts/gen-extension-seed.mjs compares the two and refuses to build a seed once they differ.
 */
export const MAX_REGION_SHARE = 0.6;

/** More than this and the page is hatched rather than annotated. See MAX_REGION_SHARE. */
const MAX_KEPT = 6;

function area(b: Box): number {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

/** Whether `outer` encloses `inner` and is the larger of the two. */
function contains(outer: Box, inner: Box): boolean {
  return area(outer) > area(inner)
    && outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

/**
 * The tightest of a set of candidate boxes, smallest first.
 *
 * Empty boxes are dropped (an element with `display: none` matches a selector and is not on
 * screen), then anything covering most of the viewport, then any box that contains another
 * surviving box. What is left is capped, because six rings is already a page that looks
 * hatched.
 *
 * `viewportArea` of zero turns the whole-page rule off rather than dropping everything, which
 * is what a caller that could not measure the page should get.
 */
export function tightest<T extends Box>(boxes: T[], viewportArea: number, limit = MAX_KEPT): T[] {
  const onScreen = boxes.filter((b) => area(b) > 0);
  const inside = viewportArea > 0
    ? onScreen.filter((b) => area(b) < viewportArea * MAX_REGION_SHARE)
    : onScreen;

  // Everything that matched is the whole page. Nothing to point at, and saying so by drawing
  // nothing is better than a ring round the viewport.
  if (!inside.length) {
    return [];
  }

  return inside
    .filter((b) => !inside.some((other) => other !== b && contains(b, other)))
    .sort((p, q) => area(p) - area(q))
    .slice(0, limit);
}

/**
 * The margin a highlight carries beyond the rectangle that was measured.
 *
 * THREE things have to agree about one rectangle, and this is how they do:
 *
 *   the red box the capture draws into the picture (`pad` in the barn-screenshot skill),
 *   the clickable overlay this pane puts on top of it,
 *   and the crop taken when somebody presses that overlay.
 *
 * They have each been wrong at least once. The overlay sat on the raw region while the crop
 * padded by 24, so the picture that landed in the conversation was larger than the box pressed
 * to get it. Padding the overlay by 24 to match fixed that and broke the other pair: the
 * overlay was then visibly bigger than the red box already drawn into the picture, which reads
 * as two regions where there is one - a parent and a child that do not exist.
 *
 * So it is the capture's own number. The skill inflates by 4 before it draws, this inflates by
 * 4 before it places and crops, and all three are the same rectangle. If the skill's `pad`
 * moves, this moves with it.
 */
export const REGION_PAD = 4;

/** A region grown by REGION_PAD, clamped to the picture it is measured against. */
export function padded(region: Box, width: number, height: number): Box {
  const x = Math.max(0, region.x - REGION_PAD);
  const y = Math.max(0, region.y - REGION_PAD);

  return {
    x,
    y,
    width:  Math.min(width - x, region.width + (REGION_PAD * 2)),
    height: Math.min(height - y, region.height + (REGION_PAD * 2)),
  };
}
