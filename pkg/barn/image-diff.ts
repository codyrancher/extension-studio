// Where two pictures of the same page differ, in the picture's own pixels.
//
// The last resort, and only for change sets that have nothing better. The pod's capture answers
// this question properly: it records every element of the page beside each picture, so what
// changed is a comparison of two documents and comes back as elements - exact, able to see a
// deletion, and resolvable in the live preview as well as drawable on the picture.
//
// Pixels are what is left when there is no such record. A change set photographed before the
// capture learned to take one has two pictures and nothing else, and `changeSetShot` reads the
// files a commit left behind and never re-shoots, so its outline can only ever be worked out
// from the pictures themselves. That is arithmetic, and the pane can do it.
//
// The pod used to run a copy of this as well, which meant one algorithm maintained in two
// places and a change set outlined differently depending on which side measured it. That copy
// is gone: the pod compares documents now.

/**
 * The header bar the capture draws, whose clock differs between any two shots.
 *
 * Not exported. It used to be, for taking the bar back off a region so the same point could be
 * found in a live page - which is the coordinate scaling that outlined a nav item for a change
 * to a timestamp, and which no longer exists anywhere.
 */
const HEADER_H = 52;

/** Per-channel difference that counts as a change rather than as antialiasing. */
const TOLERANCE = 24;

/** Grid the comparison is quantised to. Single pixels move about; blocks do not. */
const CELL = 8;

/** Smaller than this is a rendering artefact, not a change worth pointing at. */
const MIN_SIDE = 12;

/** Regions closer than this read as one change and are merged. */
const MERGE_GAP = 16;


/**
 * How far a region may grow while snapping to the block it sits in, as a share of the picture.
 *
 * A cap, because growth follows content and content on a dense page is connected: without one,
 * a changed word in a paragraph inside a card grows to the card, then the column, then the
 * page, and the outline is back to saying "somewhere below".
 */
const MAX_GROWTH = 0.35;

/**
 * How much bigger than the difference it came from a snapped box may be, per axis.
 *
 * Growing to the block a change sits in is the point; growing to the page is not, and the two
 * are the same operation with nothing between them but this number.
 */
const MAX_GROWTH_FACTOR = 6;

/**
 * The widest run of background a block may contain before it counts as the end of the block.
 *
 * Twelve pixels: wider than the padding inside a field or between a label and its value, and
 * narrower than the margin that separates one block from the next. See snapToBlock.
 */
const GUTTER = 12;

/** Background is sampled rather than assumed, because the studio has a light and a dark theme. */
const BACKGROUND_SAMPLE = 4;

import { tightest } from './change-regions';

export interface DiffRegion {
  x:      number;
  y:      number;
  width:  number;
  height: number;
}

export interface DiffResult {
  regions: DiffRegion[];
  /** The size the regions are measured in, which is the pictures' own. */
  width:   number;
  height:  number;
  /** Why there is nothing, when there is nothing. '' when the comparison ran. */
  why:     string;
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('a capture could not be decoded'));
    img.src = src;
  });
}

function pixels(img: HTMLImageElement, w: number, h: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas');

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    throw new Error('this browser would not give a 2d context');
  }

  ctx.drawImage(img, 0, 0);

  return ctx.getImageData(0, 0, w, h).data;
}

/** Connected components over the changed cells, so two edits stay two boxes. */
function cluster(changed: Uint8Array, cols: number, rows: number): DiffRegion[] {
  const seen = new Uint8Array(cols * rows);
  const boxes: DiffRegion[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const at = r * cols + c;

      if (!changed[at] || seen[at]) {
        continue;
      }

      let minC = c;
      let maxC = c;
      let minR = r;
      let maxR = r;
      const queue = [at];

      seen[at] = 1;

      while (queue.length) {
        const cur = queue.pop() as number;
        const cr = Math.floor(cur / cols);
        const cc = cur % cols;

        minC = Math.min(minC, cc);
        maxC = Math.max(maxC, cc);
        minR = Math.min(minR, cr);
        maxR = Math.max(maxR, cr);

        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nr = cr + dr;
          const nc = cc + dc;

          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) {
            continue;
          }

          const nat = nr * cols + nc;

          if (changed[nat] && !seen[nat]) {
            seen[nat] = 1;
            queue.push(nat);
          }
        }
      }

      boxes.push({
        x:      minC * CELL,
        y:      minR * CELL,
        width:  (maxC - minC + 1) * CELL,
        height: (maxR - minR + 1) * CELL,
      });
    }
  }

  return boxes;
}

/** Two lines of one paragraph are one change, not two findings. */
function merge(boxes: DiffRegion[]): DiffRegion[] {
  const near = (p: DiffRegion, q: DiffRegion) => !(
    p.x > q.x + q.width + MERGE_GAP
    || q.x > p.x + p.width + MERGE_GAP
    || p.y > q.y + q.height + MERGE_GAP
    || q.y > p.y + p.height + MERGE_GAP
  );

  const out = [...boxes];

  for (let again = true; again;) {
    again = false;

    for (let i = 0; i < out.length && !again; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!near(out[i], out[j])) {
          continue;
        }

        const x = Math.min(out[i].x, out[j].x);
        const y = Math.min(out[i].y, out[j].y);

        out[i] = {
          x,
          y,
          width:  Math.max(out[i].x + out[i].width, out[j].x + out[j].width) - x,
          height: Math.max(out[i].y + out[i].height, out[j].y + out[j].height) - y,
        };
        out.splice(j, 1);
        again = true;
        break;
      }
    }
  }

  return out;
}

/**
 * The picture's background colour, as the commonest pixel in a coarse sample.
 *
 * Sampled rather than assumed: these captures are of whatever theme the dashboard was in, and
 * a hard-coded white would make every pixel of a dark screenshot count as content.
 */
function background(px: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  const counts = new Map<number, number>();

  for (let y = HEADER_H; y < h; y += BACKGROUND_SAMPLE) {
    for (let x = 0; x < w; x += BACKGROUND_SAMPLE) {
      const i = (y * w + x) * 4;
      // Quantised, so antialiasing against the background is counted as the background.
      const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);

      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  let best = 0;
  let mode = 0;

  for (const [key, n] of counts) {
    if (n > best) {
      best = n;
      mode = key;
    }
  }

  return [((mode >> 10) & 31) << 3, ((mode >> 5) & 31) << 3, (mode & 31) << 3];
}

/**
 * Grow a region out to the block of content it belongs to.
 *
 * The comparison answers with the pixels that differ, which for an edited timestamp is the two
 * digits that moved - a box around half a word, floating in the middle of a line. What somebody
 * wants outlined is the thing that was edited, and the nearest honest approximation of that
 * from an image alone is the run of content the changed pixels sit in: expand while the rows
 * above and below, and the columns either side, still have something on them, and stop at the
 * blank space that separates one block from the next.
 *
 * It is what a DOM would answer with more precisely - the parent element's box - and it fails
 * safely, because the worst case is bounded by MAX_GROWTH and the original region is always
 * inside what comes back.
 */
function snapToBlock(region: DiffRegion, px: Uint8ClampedArray, w: number, h: number, bg: [number, number, number]): DiffRegion {
  const solid = (x: number, y: number) => {
    const i = (y * w + x) * 4;

    return Math.abs(px[i] - bg[0]) > TOLERANCE
      || Math.abs(px[i + 1] - bg[1]) > TOLERANCE
      || Math.abs(px[i + 2] - bg[2]) > TOLERANCE;
  };

  const rowHasContent = (y: number, x0: number, x1: number) => {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      if (solid(x, y)) {
        return true;
      }
    }

    return false;
  };

  const colHasContent = (x: number, y0: number, y1: number) => {
    for (let y = Math.max(HEADER_H, y0); y < Math.min(h, y1); y++) {
      if (solid(x, y)) {
        return true;
      }
    }

    return false;
  };

  const budget = Math.sqrt(w * h * MAX_GROWTH);

  let { x, y, width, height } = region;

  /**
   * How far past a blank line to keep looking before calling it the end of the block.
   *
   * This is the whole difference between a box round the changed words and a box round the
   * thing they are in. Stopping at the first blank row stops inside the element: the padding
   * between a field's text and the field's own border is background, so a changed timestamp
   * was ringed at the glyphs and the bordered field around it - the parent, and the thing
   * anybody actually wants outlined - was never reached. Crossing a gutter of this size and
   * stopping at a larger gap lands on the field: measured against a real capture, 12 gives the
   * field exactly, 8 stops short of it and 16 swallows the paragraph underneath.
   */
  const grow = (has: (at: number) => boolean, limit: number): number => {
    for (let gap = 1; gap <= GUTTER; gap++) {
      const at = limit + (gap * Math.sign(limit) || gap);

      if (has(gap)) {
        return gap;
      }
    }

    return 0;
  };

  // Vertically first: a line of text is wider than it is tall, so settling its top and bottom
  // before reaching sideways keeps the horizontal scan on the right rows.
  for (let n = 0; n < budget;) {
    const step = grow((gap) => y - gap >= HEADER_H && rowHasContent(y - gap, x, x + width), y);

    if (!step) {
      break;
    }

    y -= step;
    height += step;
    n += step;
  }

  for (let n = 0; n < budget;) {
    const step = grow((gap) => y + height + gap - 1 < h && rowHasContent(y + height + gap - 1, x, x + width), y + height);

    if (!step) {
      break;
    }

    height += step;
    n += step;
  }

  for (let n = 0; n < budget;) {
    const step = grow((gap) => x - gap >= 0 && colHasContent(x - gap, y, y + height), x);

    if (!step) {
      break;
    }

    x -= step;
    width += step;
    n += step;
  }

  for (let n = 0; n < budget;) {
    const step = grow((gap) => x + width + gap - 1 < w && colHasContent(x + width + gap - 1, y, y + height), x + width);

    if (!step) {
      break;
    }

    width += step;
    n += step;
  }

  // Grown out of proportion to what actually changed.
  //
  // The rules above stop at blank space, which is right when there is blank space to stop at
  // and unbounded when there is not: a changed word inside a bordered field inside a card with
  // no gaps grows to the card. Nothing in the picture says where the element ends, so the
  // check has to be against the only thing that is known - how much actually differed. A box
  // several times the height of the difference it came from is a guess, and the measured
  // difference is the better answer.
  if (height > region.height * MAX_GROWTH_FACTOR && width > region.width * MAX_GROWTH_FACTOR) {
    return region;
  }

  // Too big to be pointing at anything. The measured difference is the better answer then.
  if (width * height > w * h * MAX_GROWTH) {
    return region;
  }

  return {
    x, y, width, height,
  };
}

/**
 * The regions in which `after` differs from `before`.
 *
 * Both are data: URLs of captures taken at the same viewport. Different sizes means the page
 * reflowed between them, and a pixel comparison of two different layouts reports the whole
 * picture - so that answers with nothing rather than with everything.
 */
export async function regionsBetween(before: string, after: string): Promise<DiffResult> {
  const [a, b] = await Promise.all([load(before), load(after)]);

  if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) {
    return {
      regions: [], width: 0, height: 0, why: 'the two captures are different sizes',
    };
  }

  const w = a.naturalWidth;
  const h = a.naturalHeight;

  if (!w || !h) {
    return {
      regions: [], width: 0, height: 0, why: 'a capture had no size',
    };
  }

  const pa = pixels(a, w, h);
  const pb = pixels(b, w, h);
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const changed = new Uint8Array(cols * rows);

  // From under the header bar. This script drew that bar and its clock differs between any two
  // captures, so including it would report the top of every picture as changed.
  for (let y = HEADER_H; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;

      if (
        Math.abs(pa[i] - pb[i]) > TOLERANCE
        || Math.abs(pa[i + 1] - pb[i + 1]) > TOLERANCE
        || Math.abs(pa[i + 2] - pb[i + 2]) > TOLERANCE
      ) {
        changed[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
      }
    }
  }

  const bg = background(pb, w, h);
  const raw = merge(cluster(changed, cols, rows).filter((r) => r.width >= MIN_SIDE && r.height >= MIN_SIDE));

  // Snapped first, then merged again: two changed words in one line grow into the same block
  // and would otherwise be drawn as two boxes on top of each other.
  //
  // Then the tightest of what is left, by the same rule the rest of the highlighting uses: the
  // smallest boxes rather than the biggest, nothing that contains another box, and nothing
  // covering most of the picture. This used to keep the six *largest*, which is the wrong end
  // of the list - `snapToBlock` grows a box while its neighbours still have content, so on a
  // dense page the biggest boxes are the ones that grew furthest past what actually changed.
  const boxes = tightest(merge(raw.map((r) => snapToBlock(r, pb, w, h, bg))), w * h);

  return {
    regions: boxes, width: w, height: h, why: '',
  };
}
