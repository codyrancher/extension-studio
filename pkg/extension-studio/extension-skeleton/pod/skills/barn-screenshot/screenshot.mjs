#!/usr/bin/env node
// Screenshot this extension's own dashboard, from inside its pod.
//
// The harness has a pair of skills that do this with playwright. There is no
// playwright in here and no reason to install one: node 24 has fetch and
// WebSocket, and Chromium's debugging protocol is the whole interface. So this
// is the same visual language - header bar, red outlines, labelled badges,
// Before beside After - reached the way this pod can reach it.
//
// Usage:
//   screenshot.mjs --path /ext/c/local/home --output /app/.shots/after.png
//   screenshot.mjs --compare --before-path P --after-path P --output out.png
//
// Options:
//   --path PATH           appended to https://$NODE_IP$DEV_PROXY_PATH
//   --url URL             a whole URL, when --path is not enough
//   --title TEXT          bold text in the header bar
//   --highlight SELECTOR  red outline, repeatable
//   --note SEL=TEXT       red outline plus a labelled badge, repeatable
//   --diff-against PATH   when nothing above matched, outline whatever actually
//                         changed between PATH and this capture
//   --wait-for SELECTOR   wait for this rather than for a duration
//   --viewport WxH        default 1280x720
//   --full-page           the whole scrollable page
//   --token TOKEN         a Rancher bearer token, set as R_SESS before navigating
//   --compare             two panels in one image
//   --before-path/--after-path, --before-label/--after-label
//   --output PATH         where the png goes
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIGHLIGHT = '#ff3333';

/**
 * How the rectangles beside a picture were measured.
 *
 * 1 (implied by its absence): the element's box plus the header's height, which is only right
 *   on a page whose layout answers a padding on the body by moving down. Rancher's does not.
 * 2: measured with the header's space already applied and the header itself not yet added, so
 *   the rectangle is what the picture holds and the element's path is the page's own.
 */
const GEOMETRY_VERSION = 2;
const HEADER_H = 52;

/** A size difference smaller than this is a font hinting away from being the same box. */
const SIZE_TOLERANCE = 2;

/** Past this share of the page the two renderings are not the same page any more. */
const MAX_CHANGED_SHARE = 0.4;

/**
 * A box bigger than this share of the viewport is "the page", which is not a place.
 *
 * Duplicated from MAX_REGION_SHARE in pkg/barn/change-regions.ts, and MAX_REGIONS from the cap
 * beside it, because this file runs in a pod that has no access to the extension's source -
 * it is seeded in as text and run by node with nothing else on disk. The duplication is
 * checked rather than remembered: scripts/gen-extension-seed.mjs reads both files and refuses
 * to build a seed whose numbers have drifted from the ones the browser applies to the same
 * selectors.
 */
const MAX_REGION_SHARE = 0.6;

/** More than this and the picture is hatched rather than annotated. See MAX_REGION_SHARE. */
const MAX_REGIONS = 6;

function parseArgs(argv) {
  const out = { highlight: [], note: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const next = () => argv[++i];

    if (key === 'compare' || key === 'full-page' || key === 'join') {
      out[key] = true;
    } else if (key === 'highlight') {
      out.highlight.push(next());
    } else if (key === 'note') {
      out.note.push(next());
    } else {
      out[key] = next();
    }
  }

  return out;
}

/**
 * The browser's address.
 *
 * The Service name is not usable directly: Chromium answers a debugging-port
 * request whose Host header is not an IP with a 403, so the name has to become
 * a ClusterIP before it is spoken to. That is the whole reason this pod is
 * given a Service name rather than a URL.
 */
function browserOrigin() {
  const svc = process.env.BARN_BROWSER_SERVICE;
  const port = process.env.BARN_BROWSER_CDP_PORT || '9222';

  if (!svc) {
    throw new Error('BARN_BROWSER_SERVICE is not set: this pod was not told where the browser is');
  }

  const ip = execFileSync('kubectl', [
    '-n', 'barn', 'get', 'svc', svc, '-o', 'jsonpath={.spec.clusterIP}',
  ], { encoding: 'utf8' }).trim();

  if (!ip) {
    throw new Error(`the ${ svc } Service has no ClusterIP, so there is no browser to drive`);
  }

  return `http://${ ip }:${ port }`;
}

/** This extension's dashboard, as somebody outside the page has to spell it. */
function baseUrl() {
  const ip = process.env.NODE_IP;
  const proxy = process.env.DEV_PROXY_PATH;

  if (!ip || !proxy) {
    throw new Error('NODE_IP and DEV_PROXY_PATH are what name this extension\'s dashboard, and one of them is unset');
  }

  return `https://${ ip }${ proxy.replace(/\/$/, '') }`;
}

/** One CDP session against a fresh tab, closed whatever happens. */
async function withTab(origin, fn) {
  const made = await fetch(`${ origin }/json/new?about:blank`, { method: 'PUT' });

  if (!made.ok) {
    throw new Error(`the browser refused a new tab: ${ made.status } ${ await made.text() }`);
  }

  const target = await made.json();
  // The endpoint it hands back names 127.0.0.1, which is the browser's own
  // loopback and not an address this pod can reach. Only the host part is wrong.
  const ws = target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${ new URL(origin).host }`);
  const socket = new WebSocket(ws);
  let id = 0;
  const waiting = new Map();

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const pending = waiting.get(msg.id);

    if (pending) {
      waiting.delete(msg.id);
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not open a CDP socket to the browser')), { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;

    waiting.set(mine, { resolve, reject });
    socket.send(JSON.stringify({ id: mine, method, params }));
  });

  try {
    return await fn(send);
  } finally {
    socket.close();
    await fetch(`${ origin }/json/close/${ target.id }`).catch(() => {});
  }
}

/** Evaluate in the page and return the value, throwing what the page threw. */
async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });

  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || 'the page threw');
  }

  return result.value;
}

/**
 * Finding an element again by name, in the page, for both scripts below.
 *
 * One helper rather than two, because the snapshot and the annotation have to agree: the
 * snapshot records a segment per element and the comparison joins those segments into a
 * selector, which the annotation then resolves back to an element. If the two spellings
 * differed by so much as a combinator the outline would land on nothing.
 *
 * An id or a test id is an address on its own and ends the path. Otherwise it is the tag plus
 * its position among same-tag siblings, which is what `nth-of-type` means, so inserting a
 * different element beside it does not renumber it.
 */
const PATH_HELPERS = `
  const segmentOf = (el) => {
    const id = el.getAttribute('id');
    if (id && /^[A-Za-z][\\w-]*$/.test(id)) { return '#' + id; }
    const tid = el.getAttribute('data-testid');
    if (tid && !/["\\\\]/.test(tid)) { return '[data-testid="' + tid + '"]'; }
    const tag = el.tagName.toLowerCase();
    let seen = 0;
    let mine = 0;
    const kin = el.parentElement ? el.parentElement.children : [];
    for (const sib of kin) {
      if (sib.tagName === el.tagName) { seen += 1; if (sib === el) { mine = seen; } }
    }
    return seen > 1 ? tag + ':nth-of-type(' + mine + ')' : tag;
  };
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const seg = segmentOf(n);
      parts.unshift(seg);
      if (seg.charAt(0) === '#' || seg.charAt(0) === '[' || n === document.body) { break; }
    }
    return parts.join(' > ');
  };
`;

/**
 * The header bar, the outlines and the badges, drawn into the page itself.
 *
 * In the page rather than composited afterwards, so what is highlighted is
 * highlighted in the pixels somebody looks at, and lines up however the page
 * reflows. Everything is fixed-position and pointer-events: none, so nothing
 * here changes what the page under it does.
 *
 * `note` arrives as `{ selector, label }` objects rather than as `SELECTOR=LABEL` strings.
 * It used to be split here on the first `=`, which cut `[data-testid="x"]=changed here` in
 * half - `querySelectorAll('[data-testid')` throws, the whole script throws, and the capture
 * came back with no picture at all. The split belongs where the argument is parsed, and it is
 * done there now.
 */
function annotationScript({ title, url, highlight, note }) {
  return `(() => {
    for (const old of document.querySelectorAll('[data-barn-shot]')) { old.remove(); }
    // And the space the last run's header bar was pushing the page down by.
    //
    // This script runs twice on the same tab whenever the patch's own marks find nothing and
    // the snapshot comparison has to answer instead - which is the case the comparison exists
    // for. Removing the chrome without removing the padding left every element 52px lower than
    // it had been, and the box below adds the header height a second time, so the fallback
    // drew its ring 48px under the thing that changed and recorded the hotspot there too.
    //
    // removeProperty rather than assigning '', which is the same thing by the CSSOM's rules and
    // is not the same thing in every implementation of them. What is being undone is the inline
    // declaration this script wrote, so taking that declaration off is what to ask for - and it
    // leaves any padding the page's own stylesheet gives its body exactly as it was.
    document.body.style.removeProperty('padding-top');

    // The chrome's SPACE goes on before anything is measured; the chrome itself goes on after.
    //
    // Both halves of that matter, and they were each got wrong once.
    //
    // The space first, because every box used to be recorded as the element's rectangle plus
    // the header's height - a prediction that the padding below would push the page down by
    // exactly that much. Rancher's dashboard does not move: its layout is full-height and
    // ignores a padding on the body, so nothing shifted and every outline was drawn 52px
    // under the thing it was meant to circle. Setting the padding and then measuring needs no
    // prediction: whatever the page does with it, the rectangles are what the picture holds.
    //
    // The header element itself last, because it is a <div> child of <body>, and an element
    // recorded while it is there gets a path counted past it - "body > div:nth-of-type(2)"
    // for something that is the first div in the page as anyone else will ever see it. That
    // path is the one the live preview and the next capture resolve against a document with
    // no chrome in it, so it has to be the page's own numbering. Measuring with the space but
    // without the element is the only order in which both are true.
    document.body.style.paddingTop = '${ HEADER_H }px';
    // Force the layout to settle before anything reads a rectangle off it.
    void document.body.offsetHeight;
    ${ PATH_HELPERS }

    const found = [];
    const mark = (el, label, matched) => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) { return; }
      // One rectangle, used for both the outline drawn here and the region recorded
      // for the pane to place a hotspot on. They used to be computed separately - the
      // outline inflated by 4px on every edge and the region left as the raw element
      // box - so the clickable area never covered the thing the picture had circled.
      // Anything that moves one of these now moves the other by construction.
      const pad = 4;
      const box = {
        x: Math.round(r.left - pad),
        y: Math.round(r.top - pad),
        width: Math.round(r.width + pad * 2),
        height: Math.round(r.height + pad * 2),
      };
      // In the captured image's coordinates. The chrome is already on the page when this
      // measures, so the rectangle is what the picture will show - no offset is added and
      // none should be.
      //
      // The recorded selector is this element's own path, not the pattern that found it: the
      // live
      // preview resolves what is recorded here against the same page, and a pattern can
      // match six things or - for a "text:" mark - not be a CSS selector at all. The
      // pattern is kept beside it as match, for anyone asking why this was outlined.
      found.push({ selector: pathOf(el), match: matched, label, ...box });
      const outline = document.createElement('div');
      outline.setAttribute('data-barn-shot', '');
      Object.assign(outline.style, {
        position: 'fixed', left: box.x + 'px', top: box.y + 'px',
        width: box.width + 'px', height: box.height + 'px',
        border: '2px solid ${ HIGHLIGHT }', borderRadius: '3px',
        pointerEvents: 'none', zIndex: 2147483646,
      });
      document.body.appendChild(outline);
      if (!label) { return; }
      const tag = document.createElement('div');
      tag.setAttribute('data-barn-shot', '');
      tag.textContent = label;
      // Sat on the outline's own top-left corner, so the badge moves with the box
      // rather than with the element the box was inflated from.
      Object.assign(tag.style, {
        position: 'fixed', left: box.x + 'px', top: (box.y - 22) + 'px',
        background: '${ HIGHLIGHT }', color: '#fff', font: '600 11px/1.6 Lato, sans-serif',
        padding: '1px 6px', borderRadius: '3px', pointerEvents: 'none', zIndex: 2147483647,
      });
      document.body.appendChild(tag);
    };

    // A "text:" selector names a string rather than an element, for a change that edited what
    // something says and so left no attribute to key on. The element it resolves to is the one
    // holding the text node, which is the tightest thing that can honestly be said to have
    // changed - going up to a container would circle the whole page.
    const byText = (needle) => {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];

      while (walk.nextNode()) {
        const node = walk.currentNode;

        // Skip our own chrome, and anything not being displayed.
        if (node.parentElement?.closest('[data-barn-shot]')) { continue; }
        if (String(node.nodeValue || '').trim().includes(needle) && node.parentElement) {
          hits.push(node.parentElement);
        }
      }

      // One match is an answer; several is an ambiguity, and outlining all of them says
      // "somewhere among these" rather than pointing at the wrong one.
      return hits.slice(0, 3);
    };

    // A selector out of a patch is a guess at CSS, so it is allowed to be nonsense: an
    // unparseable one is that mark finding nothing, never this script throwing and the
    // capture coming back with no picture.
    const resolve = (sel) => {
      try {
        return sel.startsWith('text:') ? byText(sel.slice(5)) : [...document.querySelectorAll(sel)];
      } catch (e) {
        return [];
      }
    };

    // Everything the marks name, and then only the tightest of it.
    //
    // A mark out of a patch is a pattern, not a place: marksFor() takes the first class of any
    // added class="..." line, so a commit that puts class="trends-page" on a component root
    // names the whole page, and a commit touching class="card" names every card there is.
    // Drawn as they came, that is a hotspot covering the picture, or twelve badges on it.
    //
    // The same three rules the live preview applies to the same selectors (tightest() in
    // change-regions.ts): nothing covering more than MAX_REGION_SHARE of the viewport, nothing
    // that contains another match, smallest first, capped. They have to be the same rules or
    // the two panes outline different things for one change set - which they did.
    const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
    const contains = (outer, inner) => area(outer) > area(inner)
      && outer.left <= inner.left && outer.top <= inner.top
      && outer.right >= inner.right && outer.bottom >= inner.bottom;

    const wanted = [];
    const want = (el, label, matched) => {
      if (wanted.some((w) => w.el === el)) { return; }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { return; }
      wanted.push({ el, label, matched, r });
    };

    for (const sel of ${ JSON.stringify(highlight || []) }) {
      resolve(sel).forEach((el) => want(el, '', sel));
    }
    for (const pair of ${ JSON.stringify(note || []) }) {
      resolve(pair.selector).forEach((el) => want(el, pair.label || '', pair.selector));
    }

    const viewport = window.innerWidth * window.innerHeight;
    const onPage = wanted.filter((w) => area(w.r) < viewport * ${ MAX_REGION_SHARE });

    onPage
      .filter((w) => !onPage.some((other) => other !== w && contains(w.r, other.r)))
      .sort((p, q) => area(p.r) - area(q.r))
      .slice(0, ${ MAX_REGIONS })
      .forEach((w) => mark(w.el, w.label, w.matched));


    // Now the chrome, once every rectangle and every path has been taken.
    const bar = document.createElement('div');
    bar.setAttribute('data-barn-shot', '');
    Object.assign(bar.style, {
      position: 'fixed', left: 0, top: 0, right: 0, height: '${ HEADER_H }px',
      background: '#141419', color: '#fff', display: 'flex', alignItems: 'center',
      gap: '10px', padding: '0 16px', font: '400 12px/1.5 Lato, sans-serif',
      pointerEvents: 'none', zIndex: 2147483647,
    });
    bar.innerHTML =
      '<span style="font-weight:600;font-size:14px">' + ${ JSON.stringify(title || '') } + '</span>' +
      '<span style="opacity:.6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        ${ JSON.stringify(url || '') } + '</span>' +
      '<span style="opacity:.6">' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '</span>';
    document.body.appendChild(bar);

    // The stamp is what lets a reader tell a rectangle measured by this script from one
    // measured by the version of it that added the header's height to every box on the
    // assumption the page moved down by that much. It does not, on the page this photographs,
    // so those rectangles all sit 52px below what they name. Nothing can repair them from the
    // outside, and nothing can re-take them either - the rendering they belong to is gone -
    // so what reads them checks this and falls back to measuring the pictures instead.
    return {
      v: ${ GEOMETRY_VERSION }, regions: found, width: window.innerWidth, height: window.innerHeight,
    };
  })()`;
}

/**
 * Every element on the page, with where it is and what it says.
 *
 * This is the thing that makes "what changed" answerable exactly, and it replaces a pixel
 * comparison that could only ever answer "where". A rendering is photographed twice - once as
 * the prompt arrives and once after the turn commits - and a snapshot is taken beside each
 * picture. Comparing the two snapshots names the elements that changed, which is an answer a
 * picture cannot give: it survives a page that reflowed, it catches a deletion (there is no
 * "after" pixel to notice), it catches a change that only a computed property made, and the
 * selector it comes back with can be resolved in the live preview as well as drawn on the
 * picture.
 *
 * Taken before the annotation runs, so the header bar this script adds - and the padding it
 * pushes the body down by - are not in it.
 *
 * Recorded per element:
 *   p  the index of the nearest recorded ancestor, or -1. Ancestry rather than a whole path
 *      string per element, because a path is repeated by every one of its descendants and a
 *      dashboard page has thousands of them.
 *   s  this element's own path segment, which the comparison joins into a selector.
 *   t  the text of this element's own text nodes, not its descendants'. Own text is what makes
 *      an edited word land on the element holding the word rather than on every ancestor of it.
 */
function snapshotScript() {
  return `(() => {
    ${ PATH_HELPERS }

    const nodes = [];
    // Enough for any page this photographs, and a wall rather than a silent slide if not: a
    // depth-first walk that stops at the cap stops at a different element in two renderings
    // the moment anything is inserted, so the tail of the earlier one reads as deleted and is
    // charged to whichever ancestors survived. A page over the cap says so instead - see the
    // cut flag below - and is not compared at all.
    const LIMIT = 4000;
    // An svg is one picture however many elements it is made of, and a dashboard icon set is
    // thousands of them.
    const OPAQUE = { SVG: 1, CANVAS: 1, VIDEO: 1, IFRAME: 1 };

    const walk = (el, parent) => {
      if (nodes.length >= LIMIT) { return; }
      if (el.hasAttribute('data-barn-shot')) { return; }

      const r = el.getBoundingClientRect();
      let mine = parent;

      // A wrapper with no box of its own - display: contents, or a fragment root - is not
      // worth a record, but its children are, so this walks past it rather than stopping.
      if (r.width > 0 && r.height > 0) {
        let t = '';

        for (const kid of el.childNodes) {
          if (kid.nodeType === 3) { t += kid.nodeValue; }
        }

        mine = nodes.length;
        nodes.push({
          p: parent,
          s: segmentOf(el),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          t: t.replace(/\\s+/g, ' ').trim().slice(0, 200),
        });
      }

      if (OPAQUE[el.tagName.toUpperCase()]) { return; }

      for (const kid of el.children) { walk(kid, mine); }
    };

    walk(document.body, -1);

    return {
      width: window.innerWidth,
      height: window.innerHeight,
      cut: nodes.length >= LIMIT,
      nodes,
    };
  })()`;
}

/** The selector each recorded element is found by, built from its ancestors' segments. */
function selectorPaths(nodes) {
  const out = new Array(nodes.length);

  for (let i = 0; i < nodes.length; i++) {
    const seg = String(nodes[i].s || '');
    const parent = nodes[i].p >= 0 ? out[nodes[i].p] : '';

    // An id or a test id is an address by itself, so it starts the path over.
    out[i] = (!parent || seg.charAt(0) === '#' || seg.charAt(0) === '[') ? seg : `${ parent } > ${ seg }`;
  }

  return out;
}

function sameText(a, b) {
  return String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();
}

/**
 * Which elements differ between two snapshots of the same page, tightest first.
 *
 * Pure arithmetic over two recordings, so it is the same answer wherever it is run and it can
 * be checked without a browser.
 *
 * What counts as changed:
 *   added    a selector in the after that was not in the before.
 *   removed  a selector in the before that is not in the after, charged to the nearest
 *            ancestor that survived - which is the containing parent the outline should mark.
 *   text     an element whose own text differs. A retitled heading, a reformatted timestamp,
 *            a computed property that renders differently: none of them touch an attribute,
 *            and all of them land here.
 *   size     an element whose box changed shape. Only its shape: position moves with every
 *            reflow above it and would report a page rather than an element.
 *
 * Then the pruning, which is what keeps a highlight from being the whole page:
 *   - the outermost element of an insertion, not every new node inside it;
 *   - the innermost element of everything else, because an edited word changes the size of
 *     every ancestor it has and only the element holding the word is where it happened;
 *   - nothing covering more than MAX_REGION_SHARE of the viewport;
 *   - nothing at all when more than MAX_CHANGED_SHARE of the page differs, because two
 *     renderings that far apart are not one change and saying "here" would be a guess.
 */
function changedSelectors(before, after, options = {}) {
  const limit = options.limit || MAX_REGIONS;
  const was = (before && before.nodes) || [];
  const now = (after && after.nodes) || [];

  if (!was.length || !now.length) {
    return [];
  }

  // One of the two stopped short of the end of its page. What is missing from it is not what
  // the change removed, it is what the walk never reached, and there is no way to tell those
  // apart from here - so this says nothing rather than pointing at the last element it saw.
  if (before.cut || after.cut) {
    return [];
  }

  const keyWas = selectorPaths(was);
  const keyNow = selectorPaths(now);
  const indexWas = new Map();
  const indexNow = new Map();

  keyWas.forEach((k, i) => { if (!indexWas.has(k)) { indexWas.set(k, i); } });
  keyNow.forEach((k, i) => { if (!indexNow.has(k)) { indexNow.set(k, i); } });

  // Only when the two were shot at the same size. A box is a different shape at a different
  // viewport for reasons that have nothing to do with the change.
  const comparable = before.width === after.width && before.height === after.height;
  const changed = new Map();

  for (let i = 0; i < now.length; i++) {
    const at = indexWas.get(keyNow[i]);

    if (at === undefined) {
      changed.set(i, 'added');
    } else if (!sameText(was[at].t, now[i].t)) {
      changed.set(i, 'text');
    } else if (comparable && (Math.abs(was[at].w - now[i].w) > SIZE_TOLERANCE || Math.abs(was[at].h - now[i].h) > SIZE_TOLERANCE)) {
      changed.set(i, 'size');
    }
  }

  for (let i = 0; i < was.length; i++) {
    if (indexNow.has(keyWas[i])) {
      continue;
    }

    // Gone. Its nearest ancestor that is still there is the region that lost something.
    let up = was[i].p;

    while (up >= 0 && !indexNow.has(keyWas[up])) {
      up = was[up].p;
    }

    if (up >= 0) {
      const j = indexNow.get(keyWas[up]);

      if (!changed.has(j)) {
        changed.set(j, 'removed');
      }
    }
  }

  if (changed.size > now.length * MAX_CHANGED_SHARE) {
    return [];
  }

  const started = [...changed.keys()];

  // An inserted subtree is one insertion: keep its outermost element.
  for (const i of started) {
    for (let up = now[i].p; up >= 0; up = now[up].p) {
      if (changed.get(up) === 'added') {
        changed.delete(i);
        break;
      }
    }
  }

  // Everything else is charged to the innermost element it happened in. Skipping what the
  // pass above already dropped, or an inserted child would take its own inserted parent with it.
  for (const i of started) {
    if (!changed.has(i)) {
      continue;
    }

    for (let up = now[i].p; up >= 0; up = now[up].p) {
      changed.delete(up);
    }
  }

  const area = (n) => Math.max(0, n.w) * Math.max(0, n.h);
  const viewport = Math.max(1, (after.width || 0) * (after.height || 0));
  const kept = [...changed.keys()]
    .filter((i) => area(now[i]) > 0 && area(now[i]) < viewport * MAX_REGION_SHARE);

  return kept
    .sort((a, b) => area(now[a]) - area(now[b]))
    .slice(0, limit)
    .map((i) => ({ selector: keyNow[i], kind: changed.get(i) }));
}

/** One capture, as a base64 png. */
async function capture(send, opts) {
  const [w, h] = String(opts.viewport || '1280x720').split('x').map(Number);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: false,
  });

  if (opts.token) {
    // The session a fresh profile does not have. Set before navigating, or the
    // first navigation lands on the login page and captures that instead.
    await send('Network.enable');
    await send('Network.setCookie', {
      name: 'R_SESS', value: opts.token, domain: new URL(opts.url).hostname, path: '/', secure: true,
    });
  }

  await send('Page.navigate', { url: opts.url });

  const deadline = Date.now() + 120000;
  const want = opts.waitFor;

  // Wait for the thing that means the page has arrived.
  //
  // Without a selector, "the document finished" is the wrong test: what is being
  // shot is a single-page app behind a proxy, and it holds connections open, so
  // readyState never reaches complete and a page that had been rendered for a
  // minute was still reported as never having rendered. Painted text is the
  // honest floor - the app has put something on the screen - and a selector is
  // still the better answer whenever the caller knows one.
  for (;;) {
    const ready = await evaluate(send, want
      ? `!!document.querySelector(${ JSON.stringify(want) })`
      : 'document.readyState !== "loading" && !!document.body && document.body.innerText.trim().length > 0')
      .catch(() => false);

    if (ready) {
      break;
    }

    if (Date.now() > deadline) {
      throw new Error(want
        ? `${ want } never appeared at ${ opts.url }`
        : `${ opts.url } never finished rendering`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  // A dev build pushes its recompile over the hot-reload socket, so a page that
  // has just rendered may still be a frame behind the change.
  await new Promise((r) => setTimeout(r, 600));

  // Before anything is drawn on it. The annotation adds a header bar and pushes the body down
  // by it, and a snapshot taken after that would record a page nobody is looking at.
  const snapshot = await evaluate(send, snapshotScript()).catch(() => null);

  let marked = await evaluate(send, annotationScript({
    title: opts.title, url: opts.url, highlight: opts.highlight, note: opts.note,
  }));

  // Nothing in the patch named anything that is in this page. Compare this rendering against
  // the one recorded before the prompt and outline the elements that actually differ - which
  // needs no cooperation from the change at all, and answers with elements rather than with a
  // region of pixels, so both the picture and the live preview can be pointed at the same
  // thing. Only when the selectors found nothing: a change that named something has already
  // been outlined exactly, and this would add a second, vaguer box around the same edit.
  if (opts.beforeSnapshot && snapshot && !(marked?.regions || []).length) {
    const changed = changedSelectors(opts.beforeSnapshot, snapshot);

    if (changed.length) {
      marked = await evaluate(send, annotationScript({
        title:     opts.title,
        url:       opts.url,
        highlight: [],
        note:      changed.map((c) => ({ selector: c.selector, label: opts.diffLabel || 'changed here' })),
      })).catch(() => marked);
    }
  }

  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: !!opts.fullPage,
  });

  return { data: shot.data, marked, snapshot };
}

/**
 * Two captures in one picture.
 *
 * Built as a page and shot, rather than composited: there is no image library
 * here, and a page lays two panels out with labels and a shared scale for free.
 */
async function compose(send, opts) {
  const { before, after } = opts;
  const [w, h] = String(opts.viewport || '1280x720').split('x').map(Number);
  const panel = (label, data) => `
    <figure style="margin:0;flex:1;min-width:0">
      <figcaption style="font:600 13px/2.2 Lato,sans-serif;color:#141419;padding-left:2px">${ label }</figcaption>
      <img src="data:image/png;base64,${ data }" style="width:100%;display:block;border:1px solid #DCDDE3;border-radius:4px">
    </figure>`;

  const html = `<!doctype html><meta charset="utf-8">
    <body style="margin:0;padding:16px;background:#F4F5F8;font-family:Lato,sans-serif">
      <div style="display:flex;gap:16px;align-items:flex-start">
        ${ panel(opts.beforeLabel || 'Before', before) }
        ${ panel(opts.afterLabel || 'After', after) }
      </div>
    </body>`;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: w * 2 + 48, height: h + 80, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: `data:text/html;base64,${ Buffer.from(html).toString('base64') }` });
  await new Promise((r) => setTimeout(r, 800));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });

  return shot.data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Two pictures that already exist, joined. This is the path the change sets use: the pair was
  // taken by the pod's hooks, one as the prompt arrived and one after the turn committed, and
  // nothing here re-renders anything. Neither panel is a re-shoot, which is the whole reason
  // the Before in it is true.
  if (args.join) {
    const before = await readFile(args['before-image']);
    const after = await readFile(args['after-image']);
    const joined = await withTab(browserOrigin(), (send) => compose(send, {
      before:      before.toString('base64'),
      after:       after.toString('base64'),
      beforeLabel: args['before-label'] || 'Before this prompt',
      afterLabel:  args['after-label'] || 'After it',
      viewport:    args.viewport,
    }));

    const target = args.output || '/app/.shots/joined.png';

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(joined, 'base64'));
    console.log(target);

    return;
  }

  const origin = browserOrigin();
  const base = baseUrl();
  const out = args.output || '/app/.shots/screenshot.png';

  // The other rendering to compare against - its snapshot, not its pixels. Read now so a
  // missing file is simply no comparison rather than an error at the end of a capture that
  // otherwise worked. A capture taken before this file recorded snapshots has none, and then
  // there is nothing to compare and no outline, which is the honest answer for it.
  let beforeSnapshot = null;

  if (args['diff-against']) {
    beforeSnapshot = await readFile(snapshotPath(args['diff-against']), 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
  }

  const shared = {
    title:     args.title || process.env.EXTENSION_NAME || '',
    highlight: args.highlight,
    note:      args.note.map(parseNote),
    waitFor:   args['wait-for'],
    viewport:  args.viewport,
    fullPage:  args['full-page'],
    token:     args.token,
    beforeSnapshot,
    diffLabel: args['diff-label'] || 'changed here',
  };

  let data;
  let regions = null;
  let snapshot = null;

  if (args.compare) {
    const beforeUrl = args['before-url'] || `${ base }${ args['before-path'] || args.path || '/' }`;
    const afterUrl = args['after-url'] || `${ base }${ args['after-path'] || args.path || '/' }`;

    const before = (await withTab(origin, (send) => capture(send, { ...shared, url: beforeUrl }))).data;
    const after = (await withTab(origin, (send) => capture(send, { ...shared, url: afterUrl }))).data;

    data = await withTab(origin, (send) => compose(send, {
      ...shared,
      before,
      after,
      beforeLabel: args['before-label'],
      afterLabel:  args['after-label'],
    }));
  } else {
    const url = args.url || `${ base }${ args.path || '/' }`;
    const shot = await withTab(origin, (send) => capture(send, { ...shared, url }));

    data = shot.data;
    regions = shot.marked;
    snapshot = shot.snapshot;
  }

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(data, 'base64'));

  // Where each outline landed, beside the picture. A PNG cannot say which of its pixels are the
  // change; this can, so whatever shows the picture can make those parts answer to a pointer.
  if (regions) {
    await writeFile(`${ out }.json`, `${ JSON.stringify(regions, null, 2) }\n`);
  }

  // And what the page was, beside it. This is what the next capture of the same page compares
  // itself against; it is a file of its own rather than part of the regions above because the
  // regions are read back over an exec channel by the tab that shows the picture, and a page's
  // worth of elements does not belong in that answer.
  if (snapshot) {
    await writeFile(snapshotPath(out), `${ JSON.stringify(snapshot) }\n`);
  }

  console.log(out);
}

/**
 * `--note SELECTOR` or `--note SELECTOR=LABEL`, told apart without cutting the selector.
 *
 * The separator is the first `=` that is not inside brackets or quotes, because that is the
 * only place a CSS selector can put one: `[data-testid="x"]` holds an `=` and so does
 * `[href="a=b"]`. Splitting at the first `=` anywhere cut those in half - the resulting
 * `[data-testid` threw out of querySelectorAll and took the whole capture with it - and
 * splitting at the last one only looked right because every caller happened to append a
 * label. `--note '[data-testid="x"]', the form SKILL.md documents, is one selector and no
 * label, and this is what says so.
 */
function parseNote(pair) {
  let depth = 0;
  let quote = '';

  for (let i = 0; i < pair.length; i++) {
    const ch = pair[i];

    if (quote) {
      if (ch === quote) {
        quote = '';
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' || ch === '(') {
      depth += 1;
    } else if (ch === ']' || ch === ')') {
      depth -= 1;
    } else if (ch === '=' && depth <= 0) {
      return { selector: pair.slice(0, i), label: pair.slice(i + 1) };
    }
  }

  return { selector: pair, label: '' };
}

/** Where a capture's snapshot sits, given the capture. One spelling, used by both ends. */
function snapshotPath(image) {
  return `${ image }.snapshot.json`;
}

// Only when this was run rather than imported. The comparison above is pure and worth being
// able to exercise on its own, which importing this file is the way to do.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || String(e));
    process.exit(1);
  });
}

export { changedSelectors, selectorPaths, snapshotPath, parseNote };
