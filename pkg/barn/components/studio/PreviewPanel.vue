<script>
// The preview panel from the Studio design (Figma frame 03, node 9:233).
//
// Almost all of this one is real, which is why it is the panel to have built first: the
// toolbar's controls each map onto something the framed dashboard can actually be told to do.
// Back, forward and reload drive the iframe's own history; the route field is the path inside
// it and typing in it navigates; the live dot reports whether the dev server is answering; the
// viewport chip resizes the frame; and the last control opens the same page in a real tab.
//
// The "Hot reload" timestamp is a live reading too, now that there is somewhere to read it
// from. The frame is same-origin, so its own resource timings are readable, and webpack's hot
// module replacement fetches `*.hot-update.json` / `*.hot-update.js` every time it patches the
// running page. The newest of those entries is the moment the preview last hot-reloaded, which
// is exactly what the design's "Hot reload · 3s ago" claims. Before the first one there is
// nothing to claim, so it says "Loaded" and times the navigation instead.
//
// Three later additions, all of them readings of something:
//
//   The failed state (frame 08, 19:621). Screen 08 draws this panel with the build's state in
//   the toolbar (19:822) and an explainer over the canvas (19:830), so this panel reads the
//   failure record itself (publish-failure.ts) rather than being told about it - the record
//   announces its own changes, and the workspace that mounts this cannot pass what it does not
//   know. The explainer sits above the frame instead of replacing it: the design replaces an
//   empty iframe and this one is not empty, because a failed publish leaves the dev server
//   serving the working tree exactly as before.
//
//   "Show the last working build" (19:1087), which is the one sense of it this product can
//   render: the version this Rancher is loading. A failed build never reaches the UIPlugin, so
//   what is installed is by definition the last one that worked - and it is running, on this
//   Rancher's own pages, which the frame can be pointed at. When nothing of this extension has
//   ever been installed there is no working build anywhere and the panel says that instead of
//   offering a button.
//
//   The outline over what has changed (10:213, and the accent stroke on 10:219). The framed
//   page is same-origin and a dev build leaves `__file` on every component's options, so the
//   elements a changed file renders can be found exactly, by asking the page rather than by
//   guessing at its markup. "Changed" is measured where the rest of the product measures it,
//   against the baseline, and the marker says so rather than letting the design's "in this
//   session" stand for something nobody recorded.
import {
  SIcon, SButton
} from '../ui';
import {
  extensionProxyPath, publishedVersion, changedFiles, baselineRef, readExtensionFile,
  latestChangeSelectors, latestChangeCommit
} from '../../extensions';
import { tightest } from '../../change-regions';
import { routesFromSource } from '../../extension-routes';
import { readFailure, failureStage, FAILURE_EVENT } from '../../publish-failure';
import { readProposedFix, applyProposedFix, FIX_EVENT } from '../../publish-fix';
import { toastSuccess, toastError } from '../../toast';

// What the viewport menu offers. Widths are the common breakpoints, not the design's - the
// design only ever draws "Desktop".
const VIEWPORTS = [
  {
    id: 'desktop', label: 'Desktop', icon: 'monitor', width: null, note: 'Fills the canvas',
  },
  {
    id: 'tablet', label: 'Tablet', icon: 'monitor', width: 834, note: '834px',
  },
  {
    id: 'mobile', label: 'Mobile', icon: 'monitor', width: 390, note: '390px',
  },
];

/** A hot module replacement fetches one of these; nothing else in the page does. */
const HOT_UPDATE = /\.hot-update\.(json|js)(\?|$)/;

/**
 * The attribute the outline is hung on inside the framed page, and the stylesheet that draws it.
 *
 * Both are put into the framed document rather than into this one, because that is where the
 * elements are. An attribute plus one rule, so the outline can be lifted again by removing the
 * attribute: nothing about the framed page's own styling is touched.
 */
/** The picker's own attribute and stylesheet, kept apart from the changed-outline's. */
const PICK_MARK = 'data-barn-picking';
const PICK_STYLE = 'barn-picking-style';

/** Don't ask the pod what changed more than this often, however busy the dev server is. */
const CHANGED_MIN_MS = 8000;

/** Where the last build that installed successfully is running: this Rancher's own dashboard. */
const HOST_BASE = '/dashboard';

/**
 * What `baselineRef`'s four kinds are called in a sentence.
 *
 * The function's own `label` is a whole clause ("nothing has been published yet, so this is
 * measured against the last commit"), which reads as an explanation and not as a noun. The
 * marker needs the noun: "differ from the last commit".
 */
const BASELINE_NOUNS = {
  oci:   'the last version handed over',
  local: 'the last version published into this Rancher',
  head:  'the last commit',
  none:  '',
};

/** Clear the frame's resource timings before its buffer fills and stops recording. */
const TIMING_LIMIT = 400;

export default {
  name: 'PreviewPanel',

  components: {
    SIcon, SButton
  },

  props: {
    /** The dev server URL to frame. Empty while the pod is still coming up. */
    url: {
      type:    String,
      default: '',
    },

    extension: {
      type:     String,
      required: true,
    },

    /**
     * The change set the Changes tab has selected, or null.
     *
     * The outline is about a particular change, so it has to be about the same particular
     * change the other pane is showing. Reading HEAD instead meant the preview could be
     * outlining one change set while the Changes tab displayed another - and after an approve
     * or a reject, HEAD is not a change set at all. The tab selects the newest by default, so
     * the ordinary case is still "the latest change".
     */
    change: {
      type:    Object,
      default: null,
    },
  },

  // The path inside the frame, for anything outside that needs to say where the preview is
  // pointed - the verification screen records it against each verdict.
  emits: ['route', 'pick'],

  data() {
    return {
      // The path inside the framed dashboard. Kept in sync by a poll rather than by the
      // iframe's load event, because the thing in there is a single-page app: it changes its
      // URL with pushState and never loads again.
      address:        '',
      addressFocused: false,
      addressTimer:   null,
      // When the frame last navigated, for the live-state readout.
      loadedAt:       null,
      // When the dev server last hot-reloaded the framed page, and the timing entry that said
      // so. The entry's startTime is monotonic within the framed document, so it survives the
      // buffer being cleared and is what stops one update being counted twice.
      hotAt:          null,
      lastHotStart:   0,
      // Re-read on a timer so "12s ago" counts up rather than freezing at "just now".
      now:            Date.now(),
      nowTimer:       null,
      viewport:       'desktop',
      // The element picker: on while somebody is choosing something in the framed page.
      picking:        false,


      // The recorded publish failure for this extension, when there is one. Read from the same
      // record the failure panel reads (publish-failure.ts), because the design draws the
      // failure over the preview as well as in the conversation: screen 08 is this panel's
      // failed state, not a page somewhere else.
      failure:      null,
      // The change the assistant proposed for it, from the record both surfaces share.
      proposedFix:  null,
      applying:     false,

      // What this Rancher is loading for this extension, which is the last build that
      // installed successfully. '' when nothing of this extension has ever been installed.
      installed:     '',
      installedRead: false,

      // 'live' - the pod's dev server, which is what the preview normally is.
      // 'working' - this Rancher's own pages, where the installed build is running.
      showing:    'live',
      workingSrc: '',

      // What differs from the baseline, for the outline over this session's work.
      changed:     [],
      changedRead: false,
      changedAt:   0,
      baseline:    '',
      // How many blocks in the framed page the outline is currently hung on. Zero whenever
      // the outline is off, which is most of the time.
      // The extension's own routing table, so "nothing here comes from what changed" can say
      // where something does. Read once per extension; empty until it comes back.
      routes:      [],
      tick:        0,
    };
  },

  computed: {
    viewports() {
      return VIEWPORTS;
    },

    currentViewport() {
      return VIEWPORTS.find((v) => v.id === this.viewport) || VIEWPORTS[0];
    },

    /**
     * The frame's width, when the viewport is a fixed one.
     *
     * `flex` as well as `width`, and that is the whole of the bug this had: the canvas is a
     * flex row and the frame's stylesheet says `flex: 1 1 auto`, so flex-grow re-expanded it to
     * the full canvas and the width was measured back at 970px in every viewport. A flex item
     * only keeps the width it is given if it is told not to grow.
     */
    frameStyle() {
      const w = this.currentViewport.width;

      // `maxWidth` so a 834px tablet in a 700px pane shrinks rather than running off the end
      // of the canvas, which `flex-shrink: 0` on its own would let it do.
      return w ? {
        width: `${ w }px`, maxWidth: '100%', flex: '0 0 auto', margin: '0 auto'
      } : {};
    },

    /** The viewport menu: the three widths, with the one in force marked. */
    viewportItems() {
      return VIEWPORTS.map((v) => ({
        id:    v.id,
        label: v.label,
        note:  v.id === this.viewport ? 'Showing' : v.note,
        icon:  v.id === this.viewport ? 'check' : v.icon,
      }));
    },

    /**
     * What the frame's paths are relative to: the pod's dev server, or this Rancher itself
     * while the preview is showing the last build that installed.
     */
    frameBase() {
      return this.showing === 'working' ? HOST_BASE : extensionProxyPath(this.extension);
    },

    /** What the frame is pointed at. The dev server, unless the installed build is on show. */
    frameSrc() {
      return this.showing === 'working' ? this.workingSrc : this.url;
    },

    popoutUrl() {
      return this.frameSrc ? `${ this.frameBase }${ this.path }` : '';
    },

    path() {
      return this.address.startsWith('/') ? this.address : `/${ this.address }`;
    },

    // The design draws a green dot and a timestamp. Green means the dev server answered and
    // the frame has something in it; before that it is still starting.
    live() {
      return !!this.url && !!this.loadedAt;
    },

    /**
     * Which of the three things the readout is reporting, which is also the dot's colour.
     *
     * The build comes first. The design's failed state puts "Build failed · 12:08" here
     * (19:822), and a green dot next to a build that did not compile is the readout telling
     * the truth about the wrong subject: whether the frame has loaded is not news while the
     * thing you asked for was never built.
     */
    liveTone() {
      if (this.showing === 'working') {
        return 'info';
      }

      if (this.failure) {
        return 'error';
      }

      return this.live ? 'ok' : 'off';
    },

    /**
     * The design's "Hot reload · 3s ago", and the honest fallback for before there has been one.
     *
     * Two different facts wearing the same shape: once the dev server has patched the page in
     * place there is a hot reload to time, and until then the only thing that has happened is
     * the navigation.
     */
    liveLabel() {
      if (this.showing === 'working') {
        return this.installed ? `Last working build · v${ this.installed }` : 'Last working build';
      }

      // The design's "Build failed · 12:08", from the clock the failure was recorded on. This
      // is the time the publish failed rather than the time a build started, because a start
      // is not recorded anywhere and the failure is.
      if (this.failure) {
        return `Build failed · ${ this.failureAt }`;
      }

      if (!this.url) {
        return 'Starting the dev server';
      }

      if (!this.loadedAt) {
        return 'Connecting';
      }

      const what = this.hotAt ? 'Hot reload' : 'Loaded';
      const secs = Math.max(0, Math.round((this.now - (this.hotAt || this.loadedAt)) / 1000));

      if (secs < 5) {
        return `${ what } · just now`;
      }

      if (secs < 60) {
        return `${ what } · ${ secs }s ago`;
      }

      return `${ what } · ${ Math.round(secs / 60) }m ago`;
    },

    liveTitle() {
      if (this.showing === 'working') {
        return 'The frame is on this Rancher\'s own pages, where the version it is loading runs. That is the last build of this extension that installed successfully.';
      }

      if (this.failure) {
        return `The last publish failed at ${ this.failureAt }, and nothing was installed. The frame below is still the pod's dev server, which serves the working tree - the tree the build failed on.`;
      }

      return this.hotAt
        ? 'The dev server last patched this page without reloading it, which is what hot reload is. Timed from the frame\'s own hot-update requests.'
        : 'Timed from the last time the frame navigated. It will say "Hot reload" once the dev server patches the page in place.';
    },

    /** The clock time the failure was recorded at, which is the design's "12:08". */
    failureAt() {
      if (!this.failure?.at) {
        return '';
      }

      return new Date(this.failure.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    /**
     * The explainer's headline (19:830).
     *
     * The design's is "This page renders blank", which is a sentence about what the person is
     * looking at. So is this one, and it is the sentence that is true here: what is framed is
     * the dev server, and the build that failed never became anything anyone could look at.
     */
    failureHeadline() {
      if (this.showing === 'working') {
        return this.installed
          ? `This is v${ this.installed }, not the build that failed`
          : 'This is the installed build, not the build that failed';
      }

      return 'This is not the build you asked for';
    },

    /** The paragraph under it: why, in the words of whatever the publish actually reported. */
    failureBody() {
      if (this.showing === 'working') {
        return 'The frame is on this Rancher\'s own pages, where the version it is loading runs. That version is the last build of this extension that installed - the failed one never replaced it.';
      }

      const stage = this.failure?.stage || failureStage(this.failure?.message || '');
      const why = stage || `The publish reported: ${ this.failure?.message || 'no reason' }.`;

      return `${ why } What is framed below is the pod's dev server, which serves the working tree as it is now - the same tree the build failed on, compiled by a different build.`;
    },

    /** Why "Show the last working build" is not offered, when it is not. */
    noWorkingBuild() {
      if (this.installed || !this.installedRead || this.showing === 'working') {
        return '';
      }

      return 'No version of this extension is installed in this Rancher, so there is no working build to show. The last build that installed is the only one this product can render, because a build lives in the Rancher it was installed into and nowhere else.';
    },

    /** The commit the outline is about: the selected change set, or nothing. */
    outlineCommit() {
      return this.change?.commit || '';
    },

    /** The changed files that could put something on a page: components, and nothing else. */
    changedComponents() {
      return this.changed.filter((f) => f.path.endsWith('.vue'));
    },


  },

  watch: {
    // Immediate, because a preview that opens on `/` and never moves still has a route, and a
    // listener that only hears about changes would never learn what it is.
    path: {
      handler(to) {
        this.$emit('route', to);
        // The regions are resolved against whatever page is framed, so a different page needs
        // them looked up again.
      },
      immediate: true,
    },

    // A different change set is a different set of pictures and a different diff.

    extension() {
      // A different extension: everything read about the last one is about the last one.
      this.showing = 'live';
      this.workingSrc = '';
      this.installed = '';
      this.installedRead = false;
      this.changed = [];
      this.changedRead = false;
      this.changedAt = 0;
      this.baseline = '';
      this.loadRoutes();
      this.readRecords();
      this.readInstalled();
      this.readChanged();
    },
  },

  mounted() {
    this.readRecords();
    this.readInstalled();
    this.readChanged();
    this.loadRoutes();
    // The failure and the fix are recorded by other parts of the product while this panel is
    // already on screen - which is the design's whole case, the workspace watching its own
    // build break - so both records announce themselves rather than being polled for.
    window.addEventListener(FAILURE_EVENT, this.readRecords);
    window.addEventListener(FIX_EVENT, this.readRecords);

    this.addressTimer = setInterval(() => {
      this.readAddress();
      this.readHotReload();
      this.tick += 1;
    }, 1000);
    this.nowTimer = setInterval(() => {
      this.now = Date.now();
    }, 1000);
  },

  beforeUnmount() {
    this.stopPick();
    clearInterval(this.addressTimer);
    clearInterval(this.nowTimer);
    window.removeEventListener(FAILURE_EVENT, this.readRecords);
    window.removeEventListener(FIX_EVENT, this.readRecords);
  },

  methods: {
    onLoad() {
      this.loadedAt = Date.now();
      // A navigation is a new document, so the hot updates the last one took are not this
      // one's and its timing entries are gone with it.
      this.hotAt = null;
      this.lastHotStart = 0;
      this.readAddress();
    },

    /**
     * When the dev server last hot-reloaded the page in the frame.
     *
     * Read rather than assumed: the frame is same-origin, so its resource timings are ours to
     * look at, and webpack's hot module replacement fetches `<hash>.hot-update.json` and then
     * the chunk beside it every time it patches the running page. Nothing else does, so the
     * newest such entry is the moment of the last hot reload - and it fires where an iframe
     * `load` event does not, which is why the readout used to count from the navigation while
     * the page under it changed.
     */
    readHotReload() {
      try {
        const perf = this.$refs.frame?.contentWindow?.performance;

        if (!perf) {
          return;
        }

        const entries = perf.getEntriesByType('resource');
        let newest = this.lastHotStart;

        entries.forEach((entry) => {
          if (HOT_UPDATE.test(entry.name) && entry.startTime > newest) {
            newest = entry.startTime;
          }
        });

        if (newest > this.lastHotStart) {
          this.lastHotStart = newest;
          // Wall clock, because everything else on this panel is one. `timeOrigin` is the
          // framed document's, so the sum is the same instant in this window's terms.
          this.hotAt = Math.round(perf.timeOrigin + newest);
          // A hot update is the dev server saying a file changed, which is the one moment
          // worth asking the pod what differs from the baseline. Nothing else polls it.
          this.readChanged();
        }

        // The buffer is 250 entries by default and stops recording silently when it is full,
        // which would make a long-lived preview stop noticing hot reloads. Clearing it is safe
        // for the reading above: startTime is monotonic within the document, so a cleared
        // buffer cannot re-deliver an update that has already been counted.
        if (entries.length > TIMING_LIMIT) {
          perf.clearResourceTimings();
        }
      } catch { /* mid-navigation, or not framed yet */ }
    },

    readAddress() {
      if (this.addressFocused) {
        return;
      }

      try {
        const href = this.$refs.frame?.contentWindow?.location?.href;

        if (href) {
          this.address = href
            .replace(window.location.origin, '')
            .replace(extensionProxyPath(this.extension), '')
            .replace(new RegExp(`^${ HOST_BASE }`), '') || '/';

          if (!this.loadedAt) {
            this.loadedAt = Date.now();
          }
        }
      } catch { /* mid-navigation, or not framed yet */ }
    },

    history(delta) {
      try {
        this.$refs.frame?.contentWindow?.history?.go(delta);
      } catch { /* mid-navigation */ }
    },

    reload() {
      try {
        this.$refs.frame?.contentWindow?.location?.reload();
        this.loadedAt = Date.now();
      } catch {
        // Cross-origin or mid-navigation: `contentWindow.location` throws, and assigning `src` to
        // itself is what reloads the frame. It reads as a no-op and is not: setting the property
        // starts a navigation even when the value is unchanged, and the getter returns the
        // resolved absolute URL, so this is the one reload available without same-origin access.
        //
        // Kept as the plain self-assignment rather than laundered through a temporary variable,
        // because a temporary would hide from the next reader exactly what the lint rule is
        // pointing at, and the rule is right that it looks wrong.
        const f = this.$refs.frame;

        if (f) {
          // eslint-disable-next-line no-self-assign
          f.src = f.src;
        }
      }
    },

    go() {
      if (!this.$refs.frame) {
        return;
      }

      this.$refs.frame.contentWindow.location.href = `${ this.frameBase }${ this.path }`;
      this.$refs.address?.blur();
    },

    // -----------------------------------------------------------------------
    // The element picker (devtools' inspect, inside the framed page)
    // -----------------------------------------------------------------------

    togglePick() {
      if (this.picking) {
        this.stopPick();
      } else {
        this.startPick();
      }
    },

    /**
     * Listen in the framed document.
     *
     * Everything here is on the frame's own document, not this one, because that is where the
     * pointer is. Capture phase on the click, and `preventDefault` with it: the page under the
     * cursor is a working dashboard, and picking a nav item must not also navigate it.
     */
    startPick() {
      const doc = this.$refs.frame?.contentDocument;

      if (!doc?.body) {
        return;
      }

      this.picking = true;

      if (!doc.getElementById(PICK_STYLE)) {
        const style = doc.createElement('style');

        style.id = PICK_STYLE;
        // `!important` for the same reason the changed-outline needs it: this is one attribute
        // selector against a whole dashboard's stylesheet.
        style.textContent = `[${ PICK_MARK }]{outline:2px solid #3D98D3!important;outline-offset:2px!important;background:rgb(61 152 211 / 12%)!important;cursor:crosshair!important;}`;
        doc.head?.appendChild(style);
      }

      doc.addEventListener('mouseover', this.onPickOver, true);
      doc.addEventListener('click', this.onPickClick, true);
      doc.addEventListener('keydown', this.onPickKey, true);
      // Esc has to work whichever document has focus, and the frame may not.
      document.addEventListener('keydown', this.onPickKey, true);
    },

    stopPick() {
      this.picking = false;

      try {
        const doc = this.$refs.frame?.contentDocument;

        doc?.querySelectorAll(`[${ PICK_MARK }]`).forEach((el) => el.removeAttribute(PICK_MARK));
        doc?.getElementById(PICK_STYLE)?.remove();
        doc?.removeEventListener('mouseover', this.onPickOver, true);
        doc?.removeEventListener('click', this.onPickClick, true);
        doc?.removeEventListener('keydown', this.onPickKey, true);
      } catch { /* the frame navigated away mid-pick */ }

      document.removeEventListener('keydown', this.onPickKey, true);
    },

    onPickOver(e) {
      const doc = this.$refs.frame?.contentDocument;

      doc?.querySelectorAll(`[${ PICK_MARK }]`).forEach((el) => el.removeAttribute(PICK_MARK));
      e.target?.setAttribute?.(PICK_MARK, '');
    },

    onPickKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.stopPick();
      }
    },

    onPickClick(e) {
      e.preventDefault();
      e.stopPropagation();

      const el = e.target;

      if (!el?.getBoundingClientRect) {
        this.stopPick();

        return;
      }

      // The component that drew it, when this extension drew it at all. Walked up rather than
      // read off the clicked node: the thing under the cursor is usually a leaf inside a
      // component, and the file worth naming is the component's. See emitPick.
      this.emitPick(el);
      this.stopPick();
    },

    /** The nearest ancestor drawn by a component of this extension, as its file path. */
    componentFor(el) {
      for (let node = el; node; node = node.parentElement) {
        const file = node.__vueParentComponent?.type?.__file;

        if (file) {
          return file;
        }
      }

      return '';
    },

    /**
     * A selector that finds this element again.
     *
     * Preferred in the order a person would choose: an id, then a test id, then a class, then
     * position among its siblings. It only has to be good enough to find the element in the
     * same page a moment later - this is not a durable address, and nothing stores it.
     */
    selectorFor(el) {
      if (el.id) {
        return `#${ el.id }`;
      }

      const testid = el.getAttribute?.('data-testid');

      if (testid) {
        return `[data-testid="${ testid }"]`;
      }

      const parts = [];

      for (let node = el; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
        const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];

        if (cls) {
          parts.unshift(`${ node.tagName.toLowerCase() }.${ CSS.escape(cls) }`);
          break;
        }

        const index = [...(node.parentElement?.children || [])].indexOf(node) + 1;

        parts.unshift(`${ node.tagName.toLowerCase() }:nth-child(${ index })`);
      }

      return parts.join(' > ') || el.tagName.toLowerCase();
    },



    /**
     * The extension's routing table, for `changedRoute`.
     *
     * Best effort and read once: a routing table this cannot parse means the banner falls back
     * to its old wording, which is the behaviour before any of this existed.
     */
    async loadRoutes() {
      this.routes = [];

      const [routing, product] = await Promise.all([
        readExtensionFile(this.extension, 'routing/index.ts').catch(() => ''),
        readExtensionFile(this.extension, 'product.ts').catch(() => ''),
      ]);

      try {
        this.routes = routesFromSource(routing, product) || [];
      } catch {
        this.routes = [];
      }
    },

    setViewport(id) {
      if (VIEWPORTS.some((v) => v.id === id)) {
        this.viewport = id;
      }
    },

    // -----------------------------------------------------------------------
    // The failed state (Figma 19:621), which is this panel's and not a page's.
    // -----------------------------------------------------------------------

    /** The two records this panel draws from, both of which announce their own changes. */
    readRecords() {
      this.failure = readFailure(this.extension);
      this.proposedFix = readProposedFix(this.extension);

      // A failure that has been dealt with takes the explainer with it, and there is nothing
      // left to compare the installed build against.
      if (!this.failure && this.showing === 'working') {
        this.showLive();
      }
    },

    /** What this Rancher is loading for this extension, which is the last build that installed. */
    async readInstalled() {
      const name = this.extension;
      const version = await publishedVersion(name).catch(() => '');

      if (name !== this.extension) {
        return;
      }

      this.installed = version;
      this.installedRead = true;
    },

    /**
     * Show the build that worked, which is the one this Rancher is running.
     *
     * Not a roll back and it changes nothing in the pod: the frame moves to this Rancher's own
     * pages, where the installed version of this extension is loaded, at the same path the
     * preview was on. That version is the last one that built and installed - a failed build
     * never reaches the UIPlugin - so it is the last working build in the only sense this
     * product can render one.
     */
    showWorking() {
      if (!this.installed) {
        return;
      }

      this.workingSrc = `${ HOST_BASE }${ this.path }`;
      this.showing = 'working';
      this.loadedAt = null;
      this.hotAt = null;
      this.lastHotStart = 0;
    },

    /** Back to the pod's dev server, which is what the preview normally is. */
    showLive() {
      this.showing = 'live';
      this.workingSrc = '';
      this.loadedAt = null;
      this.hotAt = null;
      this.lastHotStart = 0;
    },

    /**
     * The design's second Apply (19:1083), which "must do the same thing" as the one in the
     * failure card - so it calls the same function, on the same recorded fix.
     */
    async applyFix() {
      if (this.applying || !this.proposedFix) {
        return;
      }

      this.applying = true;

      try {
        const path = await applyProposedFix(this.extension, this.proposedFix);

        toastSuccess(this.$store, `${ path } changed. Publish again to build it.`, { title: 'Fix applied' });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'The fix was not applied' });
      } finally {
        this.applying = false;
        this.readRecords();
      }
    },

    // -----------------------------------------------------------------------
    // The outline over what has changed (10:213 and the accent stroke on 10:219).
    // -----------------------------------------------------------------------

    /** What differs from the baseline, at most once every CHANGED_MIN_MS. */
    async readChanged() {
      const name = this.extension;

      if (Date.now() - this.changedAt < CHANGED_MIN_MS) {
        return;
      }

      this.changedAt = Date.now();

      const [files, base] = await Promise.all([
        changedFiles(name).catch(() => []),
        this.baseline ? Promise.resolve(null) : baselineRef(name).catch(() => null),
      ]);

      if (name !== this.extension) {
        return;
      }

      this.changed = files;
      this.changedRead = true;

      if (base) {
        // The marker wants the noun, not `baselineRef`'s whole sentence: "differ from nothing
        // has been published yet, so this is measured against the last commit" is not English.
        this.baseline = BASELINE_NOUNS[base.kind] || '';
      }

    },




    /**
     * Show an element, going to its page first if that is where it lives.
     *
     * A chip on an old message names something in the page that message was about, which is
     * usually not the page the preview is showing now. Trying the current document and giving
     * up was therefore wrong for every message older than the last navigation - the element
     * was fine, it was simply somewhere else. So: if the chip knows its page and the preview
     * is not on it, go there, wait for the element to exist, and then outline it.
     *
     * Polled rather than hooked to the frame's load, because this is a single-page app: it
     * changes its URL with pushState and fires no load event, so the only honest signal that
     * the page has arrived is the thing being looked for turning up in it.
     */
    async showElement(selector, page) {
      if (!selector) {
        return false;
      }

      if (this.highlightSelector(selector)) {
        return true;
      }

      if (!page || page === this.path) {
        return false;
      }

      this.goToPath(page);

      for (let i = 0; i < 24; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 250));

        if (this.highlightSelector(selector)) {
          return true;
        }
      }

      return false;
    },

    /**
     * Point the preview at a path, from a chip that already knows which one.
     *
     * The chips on a message say where it was about. The pane that page is in is a few
     * centimetres away, so saying it and going there are the same gesture.
     */
    goToPath(to) {
      this.address = to;
      this.$nextTick(() => this.go());
    },

    /**
     * Outline something in the framed page, from a chip that names it.
     *
     * Scrolled into view as well as outlined: a selector resolving to something below the fold
     * would otherwise "highlight" a part of the page nobody can see. Answers whether it found
     * anything, so a caller can say "not on this page" rather than appearing to do nothing -
     * which matters here, because the element a message was about may belong to another page
     * entirely.
     */
    highlightSelector(selector) {
      try {
        const doc = this.$refs.frame?.contentDocument;
        const el = selector && doc?.querySelector(selector);

        doc?.querySelectorAll(`[${ PICK_MARK }]`).forEach((node) => node.removeAttribute(PICK_MARK));

        if (!el) {
          return false;
        }

        if (!doc.getElementById(PICK_STYLE)) {
          const style = doc.createElement('style');

          style.id = PICK_STYLE;
          style.textContent = `[${ PICK_MARK }]{outline:2px solid #3D98D3!important;outline-offset:2px!important;background:rgb(61 152 211 / 12%)!important;}`;
          doc.head?.appendChild(style);
        }

        el.setAttribute(PICK_MARK, '');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });

        clearTimeout(this.pickClear);
        this.pickClear = setTimeout(() => {
          try {
            el.removeAttribute(PICK_MARK);
          } catch { /* the page navigated out from under it */ }
        }, 2600);

        return true;
      } catch {
        return false;
      }
    },

    /**
     * Hand an element to the conversation.
     *
     * Shared by the picker and by the changed-outline, so a thing chosen with the crosshair and
     * a thing the last change touched arrive as the same kind of context - a component path
     * when this extension drew it, a picture of it when nothing here did.
     */
    emitPick(el) {
      if (!el?.getBoundingClientRect) {
        return;
      }

      const rect = el.getBoundingClientRect();

      this.$emit('pick', {
        file:     this.componentFor(el),
        selector: this.selectorFor(el),
        label:    (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        tag:      el.tagName.toLowerCase(),
        route:    this.path,
        rect:     {
          x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
        },
      });
    },


  },
};
</script>

<template>
  <div class="preview-panel">
    <!-- preview toolbar (9:234) -->
    <div class="preview-panel__toolbar">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        :disabled="!url"
        title="Back"
        @click="history(-1)"
      />
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronRight"
        icon-only
        :disabled="!url"
        title="Forward"
        @click="history(1)"
      />
      <SButton
        variant="ghost"
        size="sm"
        icon="refresh"
        icon-only
        :disabled="!url"
        title="Reload the preview"
        @click="reload"
      />

      <!--
        The element picker, the same control every browser's devtools puts here and drawn with
        the same crosshair, because what it does is the thing people already know it for:
        point at something in the page and get told what it is.
      -->
      <SButton
        variant="ghost"
        size="sm"
        icon="target"
        icon-only
        :class="{ 'preview-panel__pick--on': picking }"
        :disabled="!url"
        :title="picking
          ? 'Pick an element in the preview - Esc to cancel'
          : 'Select an element in the preview to put it in the conversation'"
        aria-label="Select an element in the preview"
        data-testid="barn-preview-pick"
        @click="togglePick"
      />

      <!-- route (9:242): the path inside the frame, and a way to type another one -->
      <div class="preview-panel__route">
        <SIcon name="lock" :size="13" />
        <input
          ref="address"
          v-model="address"
          class="preview-panel__address"
          spellcheck="false"
          aria-label="Path inside the preview"
          :disabled="!url"
          @focus="addressFocused = true"
          @blur="addressFocused = false"
          @keydown.enter="go"
        >
      </div>

      <!-- live state (9:247), which in the failed state is the build state (19:822) -->
      <div
        class="preview-panel__live"
        :title="liveTitle"
        data-testid="barn-preview-state"
      >
        <span
          class="preview-panel__dot"
          :class="`preview-panel__dot--${ liveTone }`"
        />
        {{ liveLabel }}
      </div>

      <!--
        The width chooser - Desktop, Tablet, Mobile - used to sit here. Taken out: the preview
        is the extension running, and the pane it runs in is already whatever width somebody
        dragged it to. A fixed 375px frame inside a variable-width pane answers a question about
        the frame rather than about the extension.

        `viewportItems`, `currentViewport` and `setViewport` are left below, so restoring it is
        restoring this menu. The frame keeps whatever width was last chosen, which for anybody
        who never opened this menu is the pane's own.
      -->

      <a
        class="preview-panel__popout"
        :class="{ 'preview-panel__popout--disabled': !url }"
        :href="popoutUrl"
        target="_blank"
        rel="noopener"
        title="Open this page on its own"
        aria-label="Open this page on its own"
      >
        <SIcon name="external" :size="16" />
      </a>
    </div>

    <!-- preview canvas (9:260) -->
    <div class="preview-panel__canvas">
      <!--
        The failed state's explainer (19:830). Above the frame rather than instead of it: the
        design replaces an empty iframe, and this one is not empty - the dev server is still
        serving the working tree, and hiding a live page to say a build failed would take away
        the one thing left to look at.
      -->
      <div
        v-if="failure"
        class="preview-panel__explain"
        data-testid="barn-preview-explainer"
      >
        <span class="preview-panel__explain-icon">
          <SIcon name="alert" :size="16" />
        </span>
        <div class="preview-panel__explain-text">
          <div
            class="preview-panel__explain-head"
            data-testid="barn-preview-explain-headline"
          >
            {{ failureHeadline }}
          </div>
          <p class="preview-panel__explain-body">
            {{ failureBody }}
          </p>
          <p v-if="noWorkingBuild" class="preview-panel__explain-note">
            {{ noWorkingBuild }}
          </p>
          <p v-else-if="!proposedFix && showing === 'live'" class="preview-panel__explain-note">
            No fix has been proposed yet. "Ask the assistant to explain this" in the failure
            panel, and the change it comes back with can be applied from here.
          </p>
        </div>

        <div class="preview-panel__explain-actions">
          <!-- 19:1083. The same fix and the same function as the card's Apply (19:1022). -->
          <SButton
            v-if="proposedFix"
            variant="primary"
            size="sm"
            icon="check"
            :loading="applying"
            data-testid="barn-preview-apply-fix"
            @click="applyFix"
          >
            Apply the suggested fix
          </SButton>

          <!-- 19:1087. Only what is installed can be rendered, so only that is offered. -->
          <SButton
            v-if="installed && showing === 'live'"
            variant="secondary"
            size="sm"
            icon="clock"
            data-testid="barn-preview-show-working"
            @click="showWorking"
          >
            Show the last working build
          </SButton>

          <SButton
            v-if="showing === 'working'"
            variant="secondary"
            size="sm"
            icon="refresh"
            data-testid="barn-preview-show-live"
            @click="showLive"
          >
            Back to the live preview
          </SButton>
        </div>
      </div>

      <!-- what this session changed, and where it is on the page (10:213) -->
      <!--
        The changed-component banner was here (10:213), with its outline toggle and its link to
        the page a changed component renders. Taken out: what it could truthfully say was
        "something on this page is drawn by a file that differs", which is a fact about the
        build rather than about the change, and every attempt to make it point at the change
        itself either outlined the whole page or outlined nothing. The Changes tab answers the
        same question with two pictures and a box on the part that moved, which is the answer
        somebody actually wanted from this.
      -->

      <div class="preview-panel__stage">
        <iframe
          v-if="frameSrc"
          ref="frame"
          class="preview-panel__frame"
          :style="frameStyle"
          :src="frameSrc"
          :title="extension"
          @load="onLoad"
        />

        <div v-else class="preview-panel__frame preview-panel__waiting">
          <SIcon name="spinner" :size="24" class="preview-panel__spin" />
          <span>Starting the dev server for {{ extension }}</span>
          <span class="preview-panel__waiting-note">
            A first boot installs and compiles, which takes a few minutes.
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.preview-panel {
  display:        flex;
  flex-direction: column;
  flex:           1 1 auto;
  min-width:      0;
  min-height:     0;
  background:     var(--studio-surface);

  &__toolbar {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) var(--studio-space-12);
    border-bottom: 1px solid var(--studio-border);
    flex:          0 0 auto;
  }

  &__route {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    flex:          1 1 auto;
    min-width:     0;
    padding:       5px 10px;
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);
    color:         var(--studio-text-secondary);
  }

  &__address {
    flex:       1 1 auto;
    min-width:  0;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    font:       var(--studio-mono-12);
    color:      var(--studio-text-secondary);
  }

  &__live {
    display:     flex;
    align-items: center;
    gap:         6px;
    padding:     0 var(--studio-space-4);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-secondary);
    white-space: nowrap;
    flex:        0 0 auto;
  }

  &__dot {
    width:         7px;
    height:        7px;
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-success);

    &--ok    { background: var(--studio-success); }
    &--off   { background: var(--studio-text-tertiary); }
    &--error { background: var(--studio-error); }
    &--info  { background: var(--studio-info); }
  }

  // The chip is the trigger, so the trigger contributes nothing of its own but the hit area.
  &__viewport :deep(.s-menu__trigger) {
    padding: 2px var(--studio-space-4);
    gap:     var(--studio-space-4);
  }

  &__popout {
    display:       inline-flex;
    align-items:   center;
    padding:       5px;
    border-radius: var(--studio-radius);
    color:         var(--studio-text-secondary);

    &:hover { background: var(--studio-surface-subtle); color: var(--studio-text); }

    &--disabled { opacity: 0.4; pointer-events: none; }
  }

  // The canvas is a padded well; the page inside it is a bordered card, which is what
  // makes a 390px-wide mobile preview read as a device rather than as a broken layout.
  &__canvas {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
    flex:           1 1 auto;
    padding:        var(--studio-space-16);
    min-height:     0;
    background:     var(--studio-surface);
  }

  // The frame's own row, so the explainer and the marker can sit above it without the frame
  // losing the flex behaviour the viewport widths depend on.
  &__stage {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
  }

  // The failed state's explainer (19:830), and the marker below it (10:213). Both are bands
  // across the top of the canvas: what they say is about the page under them.
  &__explain {
    display:       flex;
    align-items:   flex-start;
    gap:           var(--studio-space-12);
    flex:          0 0 auto;
    padding:       var(--studio-space-12) 14px;
    border:        1px solid var(--studio-error);
    border-radius: var(--studio-radius);
    background:    var(--studio-error-bg);
  }

  &__explain-icon {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           22px;
    height:          22px;
    flex:            0 0 auto;
    border-radius:   var(--studio-radius-pill);
    background:      var(--studio-surface);
    color:           var(--studio-error);
  }

  &__explain-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    flex:           1 1 auto;
    min-width:      0;
  }

  &__explain-head {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__explain-body {
    margin: 0;
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }

  &__explain-note {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
  }

  &__explain-actions {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex:        0 0 auto;
    flex-wrap:   wrap;
  }

  &__marker {
    display:       flex;
    align-items:   flex-start;
    gap:           var(--studio-space-8);
    flex:          0 0 auto;
    padding:       var(--studio-space-8) var(--studio-space-12);
    border:        1px solid var(--studio-accent);
    border-radius: var(--studio-radius);
    background:    var(--studio-surface-subtle);
    color:         var(--studio-accent-text);
  }

  &__marker-text {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    min-width:      0;
  }

  &__marker-title {
    font:  var(--studio-caption-12);
    color: var(--studio-text);
  }

  &__marker-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  // The picker's button while it is armed, so it is obvious the next click goes to the page.
  &__pick--on {
    color:      var(--studio-blue-600);
    background: var(--studio-surface-subtle);
  }

  &__marker-link {
    padding:    0;
    border:     0;
    background: none;
    font:       var(--studio-caption-12);
    color:      var(--studio-blue-600);
    cursor:     pointer;

    &:hover { text-decoration: underline; }
  }

  // Desktop fills the well. The other two viewports override both of these inline (see
  // frameStyle), because a flex item that is still allowed to grow ignores the width it is
  // given - which is why the chip appeared to work and changed nothing.
  &__frame {
    flex:          1 1 auto;
    width:         100%;
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    background:    var(--studio-surface);
  }

  &__waiting {
    display:         flex;
    flex-direction:  column;
    align-items:     center;
    justify-content: center;
    gap:             var(--studio-space-8);
    color:           var(--studio-text-secondary);
    font:            var(--studio-body-14);
  }

  &__waiting-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__spin { animation: preview-spin 0.9s linear infinite; }
}

@keyframes preview-spin {
  to { transform: rotate(360deg); }
}
</style>
