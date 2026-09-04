<script>
// A terminal onto the DevExtension pod, modelled on the Claude Harness's.
//
// The harness runs a node-pty per browser socket, and that pty's command is
// `tmux new-session -A` running claude in a loop. There is no server to run one
// here, so the pty comes from Kubernetes instead: the exec subresource gives a
// real TTY in the pod, through Rancher's cluster proxy, authenticated by the
// session cookie the page already has. Everything on the far side of it is the
// same idea, and lives in seed/pod/: tmux for a session that outlives
// the browser tab, and claude looping inside it.
//
// The protocol is `base64.channel.k8s.io`, which is what the dashboard's own
// container shell speaks: each frame is a channel digit followed by base64.
// Channel 0 is stdin, 1 stdout, 2 stderr, 3 error, and 4 carries a JSON
// {Width, Height} on resize.
import { allHash } from '@shell/utils/promise';
import { base64Decode, base64Encode } from '@shell/utils/crypto';
import Socket, {
  EVENT_CONNECTED,
  EVENT_CONNECTING,
  EVENT_DISCONNECTED,
  EVENT_MESSAGE,
  EVENT_CONNECT_ERROR,
} from '@shell/utils/socket';
import {
  extensionPod, extensionShellUrl, writeImageToPod, readPodFileBase64, DEFAULT_EXTENSION
} from '../extensions';
import { agentPod, agentShellUrl, AGENT_CONTAINER } from '../agent';
import PodFileViewer from './PodFileViewer';

// The dashboard's own build pulls this in globally; an extension's does not, so
// without it a built extension renders the terminal unstyled.
import 'xterm/css/xterm.css';

// Channel prefixes, as above.
const STDIN = '0';
const STDOUT = '1';
const STDERR = '2';
const ERROR = '3';
const RESIZE = '4';

// How often to look for a running pod while there isn't one. A cold pod is
// pulling an image and installing, so this is a wait of a minute or two.
const POD_POLL_MS = 3000;

// Where a pasted image lands in the pod. Under /app, so it is on the hostPath and survives a
// restart, and dotted so it stays out of the extension's own source tree and out of the file
// browser that lists it.
const IMAGE_DIR = '/app/.images';

// The agent pod has no /app: its writable tree - and the one its own shell starts in - is
// /workspace, owned by the same uid the exec drops to.
const AGENT_IMAGE_DIR = '/workspace/.images';

const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]]+/g;
// A path has to contain a separator, so a bare word, a flag, or a sentence is never a link. The
// optional :line:col suffix is stripped off the opened path but kept in the underlined text,
// because that is how an agent prints a location and how a person expects to click it.
const PATH_RE = /(?:^|[\s"'`(<[=])((?:~|\.{1,2})?\/[\w.@+\-]+(?:\/[\w.@+\-]+)*\/?)(:\d+(?::\d+)?)?/g;
// What a slash between words is not: a date, a fraction, and the few English constructions
// that use one. Without this every "and/or" in a sentence lights up as a file.
const NOT_A_PATH = /^(?:\d+\/\d+(?:\/\d+)?|(?:and|or|either|his|her|its|s?he|yes|no|on|off|true|false|w|n|km|mi)\/[a-z]{1,3})$/i;
// Trailing punctuation belongs to the sentence the path sits in, not to the name.
const TRAILING = /[.,;:!?)\]}'"`]+$/;
// A path that points at an image. Anything under the paste directory counts, and so does any
// path ending in an image extension - an agent prints both.
// Round to the display's own pixel grid, so DOM text drawn over the canvas rasterizes on whole
// device pixels rather than halfway across one - which is what makes an overlay look soft next
// to the crisp canvas under it.
function snapPx(v) {
  const dpr = window.devicePixelRatio || 1;

  return Math.round(v * dpr) / dpr;
}

// A box border in the last column belongs to the TUI's frame, not to the sentence: collapsing it
// inward would visibly bend the composer's box, so it is left where the terminal drew it.
// A grid smaller than this is a measurement taken before the box was laid out, not a real size.
const MIN_COLS = 20;
const MIN_ROWS = 5;

// A phone at 13px gets about twenty columns - far too narrow for a TUI that assumes eighty. Nine
// gets it to a usable width without becoming unreadable. Matched live rather than measured once,
// so rotating the phone or resizing a window re-fits.
const MOBILE_TERMINAL = '(max-width: 760px)';
const mobileQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(MOBILE_TERMINAL) : null;

function terminalFontSize() {
  return mobileQuery?.matches ? 9 : 13;
}

// How far one wheel notch scrolls tmux's scrollback on a touch drag.
const TOUCH_LINE_PX = 24;

const BOX_EDGE = /[\u2502\u2503\u2551\u258f\u2595|]/;







// Anchored at the separator that starts a path. Without that anchor the leading character class
// swallows whatever is glued to the left of it - a TUI's own prompt glyph, or a word somebody
// typed - and the result is a path that does not exist, read once, and given up on for good.
/** The 256-colour palette, so a re-rendered run keeps the colour the terminal gave it. */
function paletteColor(i) {
  const ansi = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5',
  ];

  if (i < 16) {
    return ansi[i];
  }

  if (i < 232) {
    const n = i - 16;
    const lvl = (v) => (v ? (v * 40) + 55 : 0);

    return `rgb(${ lvl(Math.floor(n / 36) % 6) },${ lvl(Math.floor(n / 6) % 6) },${ lvl(n % 6) })`;
  }

  const g = ((i - 232) * 10) + 8;

  return `rgb(${ g },${ g },${ g })`;
}

function rgbHex(v) {
  return `#${ (v & 0xffffff).toString(16).padStart(6, '0') }`;
}

function fgOf(c) {
  if (c.isFgDefault()) {
    return '';
  }

  return c.isFgRGB() ? rgbHex(c.getFgColor()) : (c.isFgPalette() ? paletteColor(c.getFgColor()) : '');
}

function bgOf(c) {
  if (c.isBgDefault()) {
    return '';
  }

  return c.isBgRGB() ? rgbHex(c.getBgColor()) : (c.isBgPalette() ? paletteColor(c.getBgColor()) : '');
}

/**
 * Paint cells [from, to) as spans, one per run of identical styling.
 *
 * This is what closes the gap the image leaves: the tail of the line is drawn here, right after
 * the image, rather than left where the terminal put it - the terminal cannot reflow, so the
 * text that followed the path would otherwise sit stranded where the path used to end.
 */
function appendRuns(el, line, from, to, cellBuf, theme) {
  let run = '';
  let sig = null;
  let style = {};
  let runStart = from;
  const flush = (upto) => {
    if (!run) {
      runStart = upto;

      return;
    }

    const span = document.createElement('span');

    span.textContent = run;
    if (style.fg) {
      span.style.color = style.fg;
    }
    if (style.bg) {
      span.style.background = style.bg;
    }
    if (style.bold) {
      span.style.fontWeight = 'bold';
    }
    if (style.dim) {
      span.style.opacity = '0.6';
    }
    if (style.italic) {
      span.style.fontStyle = 'italic';
    }
    if (style.underline) {
      span.style.textDecoration = 'underline';
    }
    // Buffer columns, not characters: the caret is placed by counting these.
    span.dataset.cols = String(upto - runStart);
    el.appendChild(span);
    run = '';
    runStart = upto;
  };

  for (let x = from; x < to; x++) {
    const c = cellBuf ? line.getCell(x, cellBuf) && cellBuf : line.getCell(x);

    if (!c || c.getWidth() === 0) {
      continue;
    }

    const next = {
      fg:        c.isInverse() ? theme.background : fgOf(c),
      bg:        c.isInverse() ? theme.foreground : bgOf(c),
      bold:      c.isBold() ? '1' : '',
      dim:       c.isDim() ? '1' : '',
      italic:    c.isItalic() ? '1' : '',
      underline: c.isUnderline() ? '1' : '',
    };
    const nextSig = Object.values(next).join('|');

    if (nextSig !== sig) {
      flush(x);
      sig = nextSig;
      style = next;
    }

    run += c.getChars() || ' ';
  }

  flush(to);
}

/**
 * Where the caret belongs in a collapsed line, and how wide it should be.
 *
 * Walk the overlay's children counting the buffer columns each stands for. A column inside the
 * image gets the image's whole box: those columns are a picture now, and a thin bar sliding
 * through it in fractions of a pixel would just look stuck.
 */
function caretBox(el, start, col, cellW) {
  let acc = start;

  for (const child of Array.from(el.children)) {
    const cols = Number(child.dataset.cols || 0);

    if (col < acc + cols) {
      return child.tagName === 'IMG'
        ? { x: child.offsetLeft, w: child.offsetWidth }
        : { x: child.offsetLeft + ((col - acc) * cellW), w: cellW };
    }

    acc += cols;
  }

  const last = el.lastElementChild;
  const contentEnd = last ? last.offsetLeft + last.offsetWidth : 0;

  return { x: contentEnd + (Math.max(0, col - acc) * cellW), w: cellW };
}

const IMAGE_PATH_RE = /(?:~|\.{1,2})?\/[\w.@+/-]*\.(?:png|jpe?g|gif|webp|bmp)\b/gi;

// The row a phone keyboard is missing. Termux, Blink and iSH all ship one for
// the same reason: without arrows there is no way to go back and fix a typo,
// and without Esc there is no way out of a menu.
const KEY_BAR = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  {
    label: '\u2190', seq: '\x1b[D', title: 'Left'
  },
  {
    label: '\u2192', seq: '\x1b[C', title: 'Right'
  },
  {
    label: '\u2191', seq: '\x1b[A', title: 'Up / previous'
  },
  {
    label: '\u2193', seq: '\x1b[B', title: 'Down / next'
  },
  {
    label: '\u21e4', seq: '\x01', title: 'Start of line (Ctrl+A)'
  },
  {
    label: '\u21e5', seq: '\x05', title: 'End of line (Ctrl+E)'
  },
  {
    label: '\u232b', seq: '\x17', title: 'Delete the word before the cursor (Ctrl+W)'
  },
  {
    label: '\u21b5', seq: '\r', title: 'Enter'
  },
];

/**
 * The control code for a letter, so an armed Ctrl can be applied to it.
 */
function ctrlByteFor(key) {
  if (key.length !== 1) {
    return null;
  }

  const code = key.toUpperCase().charCodeAt(0);

  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}

export default {
  name: 'PodTerminal',

  components: { PodFileViewer },

  props: {
    // Which tmux session to attach to. One pane, one session; it is a prop so a
    // second pane would be a second conversation rather than a fight over one.
    session: {
      type:    String,
      default: 'editor',
    },

    // Which extension's pod to open the session in. There can be several, and a
    // terminal that always went to the same one would be a terminal in the wrong
    // pod as soon as you were editing anything else.
    extension: {
      type:    String,
      default: DEFAULT_EXTENSION,
    },

    // Which kind of pod this pane opens into. 'extension' is one extension's dev server,
    // addressed by the prop above; 'agent' is the single global agent pod, which belongs to no
    // extension and so has no name to be given.
    //
    // A prop rather than a second component, because everything below is the same for both:
    // xterm, the channel protocol, the backlog, the resize frames, the reconnect. A copy of all
    // of that for one different URL is a copy that stops matching the first time either is
    // fixed. The two lines that actually differ are in connectWhenPodIsUp and connect.
    target: {
      type:      String,
      default:   'extension',
      validator: (value) => ['extension', 'agent'].includes(value),
    },

    // What the pane runs: the assistant's claude session, or a plain login
    // shell. The Terminal tab asks for a shell - it is a terminal, and a tab
    // that dropped you into the assistant's TUI meant a line typed here became
    // a turn there.
    mode: {
      type:      String,
      default:   'claude',
      validator: (value) => ['claude', 'shell'].includes(value),
    },
  },

  // The connection's state, for whatever is drawing a dot for it - the Studio's session row.
  emits: ['state'],

  watch: {
    state: {
      immediate: true,
      handler(v) {
        this.$emit('state', v);
      },
    },
  },

  data() {
    return {
      KEY_BAR,
      // 'waiting' (no pod yet) | 'connecting' | 'open' | 'closed'
      state:        'waiting',
      // The path a clicked link opened, and the pod to read it from.
      viewerPath:   '',
      viewerPod:    '',
      // The thumbnail layer, the frame it is waiting on, and the images that turned out not to
      // be readable - asking for those again on every repaint would be a request per frame.
      thumbLayer:   null,
      thumbFrame:   0,
      thumbSrc:     {},
      thumbMissing: {},
      // Overlays are kept per replaced span rather than rebuilt each frame, and the caret is the
      // stand-in drawn when a thumbnail has collapsed the cursor's own line.
      thumbImgs:    {},
      // The signature of the overlays currently in the DOM, so an unchanged screen is left alone.
      thumbSig:     '',
      advanceCache: {},
      caretEl:      null,
      // Sizing: the coalescing frame, the settle timer, how much of the viewport the on-screen
      // keyboard covers, and where a touch drag started.
      fitFrame:     0,
      settleTimer:  null,
      kbInset:      0,
      touchY:       0,
      touchAcc:     0,
      // Set while an image is on its way into the pod, and if it failed to get there.
      pasting:      false,
      imageError:   '',
      error:        '',
      terminal:     null,
      fitAddon:     null,
      socket:       null,
      // Input typed before the socket opened, replayed on connect.
      backlog:      [],
      resizeObserver: null,
      podPollTimer: null,
      unmounted:    false,
      // Touch only: the keys a phone keyboard does not have, which are most of
      // what a TUI is driven with.
      showKeyBar:   false,
      ctrlArmed:    false,
      dprTimer:     null,
    };
  },

  computed: {
    /** The container these execs enter: the agent pod names its differently. */
    podContainer() {
      return this.target === 'agent' ? AGENT_CONTAINER : undefined;
    },

    statusText() {
      return {
        waiting:    this.target === 'agent' ? 'Waiting for the agent pod' : 'Waiting for the dev server pod',
        connecting: 'Connecting',
        closed:     'Disconnected',
      }[this.state] || '';
    },
  },

  async mounted() {
    // A handle for looking at what this pane believes: which images it has read, which it gave
    // up on, what the grid is. Cheap, and the alternative is guessing from the outside.
    if (this.$el) {
      this.$el.__mcTerm = this;
    }

    await this.setupTerminal();
    this.connectWhenPodIsUp();

    // A socket that dropped while nobody was looking is the common case: a laptop sleeps, a tab
    // sits in the background for an hour, the pod restarts. Coming back to the tab is exactly
    // when somebody wants the session, so that is when it is reattached - rather than leaving
    // them to notice the dead pane and press a button.
    this.onRefocus = () => {
      this.reconnectIfDropped();
      // Coming back to the tab is also when a stale grid shows itself, so re-measure.
      this.settleFits();
    };
    this.onViewport = () => this.onViewportResize();
    this.onFontQuery = () => this.onFontSizeQuery();
    window.visualViewport?.addEventListener('resize', this.onViewport);
    window.visualViewport?.addEventListener('scroll', this.onViewport);
    mobileQuery?.addEventListener?.('change', this.onFontQuery);
    this.$refs.xterm?.addEventListener('touchstart', this.onTouchStartBound = (e) => this.onTouchStart(e), { passive: true });
    this.$refs.xterm?.addEventListener('touchmove', this.onTouchMoveBound = (e) => this.onTouchMove(e), { passive: false });
    // The layout is not settled the moment this mounts: measure again once it is.
    this.settleFits();
    window.addEventListener('focus', this.onRefocus);
    document.addEventListener('visibilitychange', this.onRefocus);
    this.$refs.xterm?.addEventListener('focusin', this.onRefocus);
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.settleTimer);
    cancelAnimationFrame(this.fitFrame);
    window.visualViewport?.removeEventListener('resize', this.onViewport);
    window.visualViewport?.removeEventListener('scroll', this.onViewport);
    mobileQuery?.removeEventListener?.('change', this.onFontQuery);
    this.$refs.xterm?.removeEventListener('touchstart', this.onTouchStartBound);
    this.$refs.xterm?.removeEventListener('touchmove', this.onTouchMoveBound);
    window.removeEventListener('focus', this.onRefocus);
    document.removeEventListener('visibilitychange', this.onRefocus);
    this.$refs.xterm?.removeEventListener('focusin', this.onRefocus);
    clearTimeout(this.podPollTimer);
    clearInterval(this.dprTimer);
    this.resizeObserver?.disconnect();
    // Only this end goes away. The tmux session in the pod keeps running, which
    // is the whole point of it: reopening the editor reattaches to it.
    this.socket?.disconnect();
    this.terminal?.dispose();
  },

  methods: {
    /**
     * Type something at the prompt on the user's behalf, then put them back
     * where they were: focused, and at the bottom of the scrollback.
     */
    sendKeys(data) {
      this.send(STDIN + base64Encode(data));
      this.terminal?.scrollToBottom();
      this.terminal?.focus();
    },

    tapKey(seq) {
      this.sendKeys(seq);
      this.ctrlArmed = false;
    },

    // Sticky rather than held: a touch screen has no chords, so Ctrl applies to
    // whatever is typed next.
    armCtrl() {
      this.ctrlArmed = !this.ctrlArmed;
      this.terminal?.focus();
    },

    /**
     * Is the canvas drawing at the display's resolution? Its backing store has
     * to be its CSS size times the device pixel ratio; anything else is the
     * browser rescaling a bitmap, which is what soft glyphs actually are.
     */
    canvasScaleWrong() {
      const canvas = this.$refs.xterm?.querySelector('canvas.xterm-text-layer');

      if (!canvas) {
        return false;
      }

      const rect = canvas.getBoundingClientRect();

      if (rect.width < 20 || rect.height < 20) {
        return false;
      }

      const dpr = window.devicePixelRatio || 1;

      return Math.abs((canvas.width / rect.width) - dpr) > 0.05
        || Math.abs((canvas.height / rect.height) - dpr) > 0.05;
    },

    async setupTerminal() {
      const style = getComputedStyle(document.body);
      const color = (name) => style.getPropertyValue(name).trim() || undefined;

      const xterm = await import(/* webpackChunkName: "xterm" */ 'xterm');
      const addons = await allHash({
        fit:    import(/* webpackChunkName: "xterm" */ 'xterm-addon-fit'),
        canvas: import(/* webpackChunkName: "xterm" */ 'xterm-addon-canvas'),
      });

      const terminal = new xterm.Terminal({
        allowProposedApi: true,
        cursorBlink:      true,
        fontSize:         terminalFontSize(),
        // Harness Terminal is bundled with the extension (assets/fonts). The
        // rest of the list is what a browser has anyway, for the moment before
        // the webfont loads and for the case where it failed to.
        fontFamily:       '"Harness Terminal", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        // Rancher's own terminal colours, so this matches the dashboard's theme
        // and follows it between light and dark.
        theme:            {
          background:          color('--terminal-bg'),
          foreground:          color('--terminal-text'),
          cursor:              color('--terminal-cursor'),
          selectionBackground: color('--terminal-selection'),
        },
      });

      this.fitAddon = new addons.fit.FitAddon();
      terminal.loadAddon(this.fitAddon);
      // Canvas rather than webgl: this pane sits next to an iframe running a
      // whole second dashboard, and webgl contexts are a limited resource.
      terminal.loadAddon(new addons.canvas.CanvasAddon());

      // tmux emits the selection as OSC 52 when a drag ends (see pod/tmux.conf),
      // which is what makes drag-select copy to the browser clipboard. Without
      // a handler the sequence is silently dropped.
      terminal.parser.registerOscHandler(52, (payload) => {
        const encoded = payload.split(';')[1];

        try {
          navigator.clipboard?.writeText(base64Decode(encoded));
        } catch { /* clipboard permission, or a payload that isn't base64 */ }

        return true;
      });

      terminal.open(this.$refs.xterm);
      terminal.onData((input) => this.send(STDIN + base64Encode(input)));

      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') {
          return true;
        }

        // Ctrl/Cmd+V is read off the clipboard directly. xterm handles the keystroke itself and
        // no `paste` event follows it, so the DOM listener below never sees a screenshot pasted
        // the ordinary way - which is the way everybody pastes one. Text is left alone: this
        // only claims the keystroke when the clipboard actually holds an image.
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'v') {
          this.pasteFromClipboard();
        }

        // Ctrl armed from the key bar applies to the next character typed:
        // there is no chord on a touch screen.
        if (this.ctrlArmed) {
          const byte = ctrlByteFor(event.key);

          if (byte) {
            event.preventDefault();
            this.ctrlArmed = false;
            this.sendKeys(byte);

            return false;
          }
        }

        // Shift+Enter inserts a newline instead of submitting, so a list can be
        // typed into the assistant's composer.
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          this.sendKeys('\x1b\r');

          return false;
        }

        return true;
      });

      // A phone has no arrows, Esc, Tab or Ctrl, and those are how a TUI is
      // driven. Every mobile terminal grows this row for the same reason.
      this.showKeyBar = window.matchMedia?.('(pointer: coarse)').matches || false;

      // The canvas renderer sizes its backing store by devicePixelRatio when it
      // lays out. Change the ratio afterwards - browser zoom, or a window moved
      // to a display with a different scale - and it keeps drawing at the old
      // resolution, which the browser then rescales: the terminal goes soft
      // while everything around it stays sharp. Some of those changes arrive
      // with no event to hang this off, so it is a slow check rather than a
      // listener.
      this.dprTimer = setInterval(() => {
        if (document.hidden || !this.canvasScaleWrong()) {
          return;
        }

        this.terminal?.clearTextureAtlas?.();
        this.fit();
      }, 2000);

      // An image pasted or dropped on the pane becomes a file in the pod, and its path is
      // typed at the prompt. That is the whole trick: claude reads an image from a path, so
      // handing it one is the same thing as attaching it. xterm's own paste handling only ever
      // sees text, which is why this listens on the element rather than through the terminal.
      const pane = this.$refs.xterm;

      // Capture, not bubble. xterm's paste handler lives on the textarea inside this element and
      // calls stopPropagation, so a listener here never sees a real Ctrl+V - only the synthetic
      // events a test dispatches at this element directly, which is exactly how this looked
      // tested and was not. Capture runs on the way down, ahead of xterm.
      pane.addEventListener('paste', (event) => this.onImages(event, event.clipboardData), true);
      pane.addEventListener('dragover', (event) => event.preventDefault());
      pane.addEventListener('drop', (event) => this.onImages(event, event.dataTransfer));

      this.terminal = terminal;

      // Paths and URLs the session prints become links. xterm's own provider is what the
      // harness terminal uses and it activates fine with tmux mouse reporting on - an overlay
      // of anchors over the screen does not, because it takes the clicks that focus the
      // terminal and typing stops working.
      terminal.registerLinkProvider({ provideLinks: (row, callback) => callback(this.linksFor(row, terminal)) });

      // Every repaint can move the text, so the thumbnails are re-placed after it.
      terminal.onRender(() => this.scheduleThumbs());
      terminal.onScroll(() => this.scheduleThumbs());

      // The pane is resizable (the editor's divider) and the window is too, so
      // the size is watched rather than taken once.
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
      this.resizeObserver.observe(this.$refs.xterm);
      this.fit();
    },

    // Wait for a pod, then connect. It is a wait rather than an error because the pod is made
    // for us: the editor will not mount this pane until the install has reported the Deployment
    // exists. This used to call ensureExtension itself, which made the object the checklist was
    // about to report on and so kept the install invisible - the same mistake in three places.
    async connectWhenPodIsUp() {

      // Whatever went wrong last time is over: this is a fresh wait, and the
      // error belongs to the connection that ended. Left in place, the exec
      // subresource's parting shot when a pod is killed ("exit code 137") would
      // sit there as the status forever, because the overlay shows the error in
      // preference to the state and nothing else clears it until a socket
      // opens, which cannot happen while there is no pod.
      this.error = '';

      while (!this.unmounted) {
        const pod = this.target === 'agent' ? await agentPod() : await extensionPod(this.extension);

        if (pod) {
          this.connect(pod);

          return;
        }

        this.state = 'waiting';
        await new Promise((resolve) => {
          this.podPollTimer = setTimeout(resolve, POD_POLL_MS);
        });
      }
    },

    connect(pod) {
      const url = this.target === 'agent'
        ? agentShellUrl(pod, this.session, this.mode)
        : extensionShellUrl(pod, this.session, this.mode);
      const socket = new Socket(url, false, 0, 'base64.channel.k8s.io');

      socket.addEventListener(EVENT_CONNECTING, () => {
        this.state = 'connecting';
        this.error = '';
      });

      socket.addEventListener(EVENT_CONNECTED, () => {
        this.state = 'open';
        this.fit();
        this.flush();
        this.terminal?.focus();
      });

      socket.addEventListener(EVENT_CONNECT_ERROR, () => {
        this.state = 'closed';
        this.error = 'Could not open a shell in the pod';
      });

      socket.addEventListener(EVENT_DISCONNECTED, () => {
        this.state = 'closed';
      });

      socket.addEventListener(EVENT_MESSAGE, (event) => {
        const data = event.detail.data;
        const channel = data.substr(0, 1);
        const message = base64Decode(data.substr(1));

        // stdout and stderr are both the pane; there is one TTY behind them.
        if (channel === STDOUT || channel === STDERR) {
          this.terminal?.write(message);

          return;
        }

        if (channel === ERROR && message) {
          // Not output: a Status object saying how the exec ended. Printing it
          // would put `{"status":"Success"}` on screen every time a shell exits
          // normally, so only a failure is worth surfacing, and as a status
          // rather than as terminal output.
          try {
            const status = JSON.parse(message);

            if (status.status !== 'Success') {
              this.error = status.message || 'The shell exited with an error';
            }
          } catch {
            this.error = message;
          }
        }
      });

      this.socket = socket;
      socket.connect();
    },

    // Reconnecting is reattaching: tmux still has the session, so this picks up
    // where it left off rather than starting anything.
    /**
     * Reattach, but only if this end is actually dead.
     *
     * Focus fires for every click into the pane and every tab switch, and tearing down a healthy
     * socket on each of those would drop the session it is meant to protect. `waiting` is a pod
     * that has not come up yet and `connecting` is already on its way, so neither is ours to
     * restart either.
     */
    reconnectIfDropped() {
      if (this.unmounted || document.hidden || this.state !== 'closed') {
        return;
      }

      this.reconnect();
    },

    async reconnect() {
      await this.socket?.disconnect();
      this.socket = null;
      this.terminal?.reset();
      this.connectWhenPodIsUp();
    },

    /**
     * The links on one row: every URL, and every path that looks like one on purpose.
     *
     * A URL opens in a tab. A path opens in the viewer, which reads it out of the pod this
     * session is attached to, so it works for anything the session can see.
     */
    linksFor(row, terminal) {
      const line = terminal.buffer.active.getLine(row - 1);

      if (!line) {
        return undefined;
      }

      const text = line.translateToString(true);
      const links = [];
      const taken = (index, len) => links.some((l) => index + 1 <= l.range.end.x && l.range.start.x <= index + len);

      URL_RE.lastIndex = 0;
      for (let hit = URL_RE.exec(text); hit; hit = URL_RE.exec(text)) {
        const raw = hit[0].replace(TRAILING, '');

        links.push({
          range:       { start: { x: hit.index + 1, y: row }, end: { x: hit.index + raw.length, y: row } },
          text:        raw,
          decorations: { pointerCursor: true, underline: true },
          activate:    (_event, t) => window.open(t, '_blank', 'noopener'),
        });
      }

      PATH_RE.lastIndex = 0;
      for (let hit = PATH_RE.exec(text); hit; hit = PATH_RE.exec(text)) {
        const raw = (hit[1] || '').replace(TRAILING, '');
        const index = hit.index + hit[0].indexOf(hit[1] || '');

        if (raw.length < 3 || NOT_A_PATH.test(raw) || taken(index, raw.length)) {
          continue;
        }

        // A relative path has to look like one: a file with an extension, or deep enough that
        // it cannot be a sentence with a slash in it.
        const rooted = /^[~/.]/.test(raw);
        const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(raw);
        const depth = (raw.match(/\//g) || []).length;

        if (!rooted && !hasExt && depth < 2) {
          continue;
        }

        links.push({
          range:       { start: { x: index + 1, y: row }, end: { x: index + raw.length, y: row } },
          text:        raw,
          decorations: { pointerCursor: true, underline: true },
          // The line reference an agent appends (file.ts:253) is not part of the name.
          activate:    (_event, t) => this.openPath(t.replace(/:\d+(?::\d+)?$/, '')),
        });
      }

      return links.length ? links : undefined;
    },

    /** Coalesce the repaints xterm fires in bursts into one placement per frame. */
    scheduleThumbs() {
      if (this.thumbFrame) {
        return;
      }

      this.thumbFrame = requestAnimationFrame(() => {
        this.thumbFrame = 0;
        this.drawThumbs();
      });
    },

    /** One cell in CSS pixels, so an overlay lines up with the glyphs under it. */
    cellSize() {
      const dims = this.terminal?._core?._renderService?.dimensions?.css?.cell;

      if (dims?.width && dims?.height) {
        return { w: dims.width, h: dims.height };
      }

      const screen = this.terminal?.element?.querySelector('.xterm-screen');

      if (!screen || !this.terminal?.cols || !this.terminal?.rows) {
        return null;
      }

      return { w: screen.clientWidth / this.terminal.cols, h: screen.clientHeight / this.terminal.rows };
    },

    /** The image bytes for a path, fetched once and kept - a repaint must not re-read the pod. */
    async thumbFor(path) {
      if (this.thumbSrc[path] || this.thumbMissing[path]) {
        return;
      }

      // Claimed before the await, so a burst of repaints starts one read rather than twenty.
      this.thumbSrc = { ...this.thumbSrc, [path]: '' };

      try {
        const pod = this.target === 'agent' ? await agentPod() : await extensionPod(this.extension);
        const base64 = await readPodFileBase64(pod, path, this.podContainer);
        const ext = (path.split('.').pop() || 'png').toLowerCase();

        this.thumbSrc = { ...this.thumbSrc, [path]: `data:image/${ ext === 'jpg' ? 'jpeg' : ext };base64,${ base64 }` };
        this.scheduleThumbs();
      } catch {
        this.thumbMissing = { ...this.thumbMissing, [path]: true };
      }
    },

    /**
     * Draw each image path as the image, in as many whole cells as the image actually needs.
     *
     * The image is scaled to the line's height, its width rounded up to a whole number of cells
     * and the picture centred across them - two and a half cells wide becomes three. The rest of
     * the path's columns are collapsed away: the tail of the line is re-rendered immediately
     * after the image, in the colours the terminal gave it, so forty-seven columns of filename
     * become three cells of picture and the line closes up behind it.
     */
    drawThumbs() {
      const screen = this.terminal?.element?.querySelector('.xterm-screen');
      const cell = this.cellSize();

      if (!screen || !cell) {
        return;
      }

      if (!this.thumbLayer || this.thumbLayer.parentElement !== screen) {
        this.thumbLayer = document.createElement('div');
        this.thumbLayer.className = 'mc-terminal__thumbs';
        screen.appendChild(this.thumbLayer);
        this.thumbSig = '';
      }

      const buf = this.terminal.buffer.active;
      const theme = {
        background: this.terminal.options.theme?.background || '#141419',
        foreground: this.terminal.options.theme?.foreground || '#eee',
      };
      const cellBuf = buf.getNullCell?.();
      const wanted = [];

      for (let row = 0; row < this.terminal.rows; row++) {
        const line = buf.getLine(buf.viewportY + row);

        if (!line) {
          continue;
        }

        const text = line.translateToString(true);

        if (!text.includes('/')) {
          continue;
        }

        const hits = [];

        IMAGE_PATH_RE.lastIndex = 0;
        for (let hit = IMAGE_PATH_RE.exec(text); hit; hit = IMAGE_PATH_RE.exec(text)) {
          const path = hit[0];

          if (this.thumbMissing[path]) {
            continue;
          }

          const src = this.thumbSrc[path];

          if (src === undefined) {
            this.thumbFor(path);
          } else if (src) {
            hits.push({ name: path, index: hit.index, src });
          }
        }

        if (!hits.length) {
          continue;
        }

        let end = text.length;

        if (end && BOX_EDGE.test(text[end - 1])) {
          end -= 1;
        }

        while (end > 0 && text[end - 1] === ' ') {
          end -= 1;
        }

        const start = hits[0].index;

        if (end <= start) {
          continue;
        }

        // Out to the pane's edge, so the cell being typed into is inside the overlay. A
        // box-drawing character is a split layout's border and is left where it is.
        while (end < this.terminal.cols && !BOX_EDGE.test(text[end] ?? ' ')) {
          end += 1;
        }

        wanted.push({
          row, start, end, line, hits, key: `${ row }:${ start }:${ text.slice(start, end) }`,
        });
      }

      // Touch the DOM only when the overlays actually change: rebuilding every frame tears the
      // image out from under a click that spans a repaint, and something always repaints.
      const sig = wanted.map((w) => w.key).join('|');
      const rebuild = sig !== this.thumbSig || this.thumbLayer.childElementCount !== wanted.length;

      if (rebuild) {
        this.thumbSig = sig;
        this.thumbLayer.replaceChildren();
        this.caretEl = null;
      }

      let caretRow = null;

      wanted.forEach((w, i) => {
        let el = rebuild ? null : this.thumbLayer.children[i];

        if (!el) {
          el = document.createElement('div');
          el.className = 'mc-terminal__thumb';
          const font = String(this.terminal.options.fontFamily);
          const size = this.terminal.options.fontSize;

          el.style.fontFamily = font;
          el.style.fontSize = `${ size }px`;
          // Put the text back on the terminal's grid: see charAdvance.
          el.style.letterSpacing = `${ cell.w - this.charAdvance(font, size) }px`;

          let cursor = w.start;

          for (const hit of w.hits) {
            if (hit.index >= w.end) {
              break;
            }

            if (hit.index < cursor) {
              continue;
            }

            if (hit.index > cursor) {
              appendRuns(el, w.line, cursor, hit.index, cellBuf, theme);
            }

            el.appendChild(this.thumbImage(hit, cell));
            cursor = hit.index + hit.name.length;
          }

          if (cursor < w.end) {
            appendRuns(el, w.line, cursor, w.end, cellBuf, theme);
          }

          this.thumbLayer.appendChild(el);
        } else {
          // Sizes depend on the image's natural aspect, which arrives after the first draw.
          [...el.children].forEach((k) => {
            if (k.tagName === 'IMG') {
              this.sizeThumb(k, cell);
            }
          });
        }

        el.style.left = `${ snapPx(w.start * cell.w) }px`;
        el.style.top = `${ snapPx(w.row * cell.h) }px`;
        el.style.width = `${ snapPx((w.end - w.start) * cell.w) }px`;
        el.style.height = `${ snapPx(cell.h) }px`;
        el.style.lineHeight = `${ snapPx(cell.h) }px`;

        if (buf.viewportY === buf.baseY && w.row === buf.cursorY && buf.cursorX >= w.start) {
          caretRow = {
            el, start: w.start, row: w.row,
          };
        }
      });

      this.drawCaret(caretRow, buf.cursorX, cell);
    },

    /**
     * xterm draws its caret at the cursor's real column, which on a collapsed line is far to the
     * right of the text being typed. Hide it there and draw one here instead; every other line
     * keeps the terminal's own.
     */
    drawCaret(hit, col, cell) {
      const host = this.terminal?.element;

      if (!hit || !this.thumbLayer) {
        this.caretEl?.remove();
        this.caretEl = null;
        host?.classList.remove('mc-thumb-caret-on');

        return;
      }

      if (!this.caretEl || this.caretEl.parentElement !== this.thumbLayer) {
        this.caretEl = document.createElement('div');
        this.caretEl.className = 'mc-terminal__caret';
        this.thumbLayer.appendChild(this.caretEl);
      }

      const box = caretBox(hit.el, hit.start, col, cell.w);

      this.caretEl.style.left = `${ snapPx((hit.start * cell.w) + box.x) }px`;
      this.caretEl.style.top = `${ snapPx(hit.row * cell.h) }px`;
      this.caretEl.style.width = `${ snapPx(box.w) }px`;
      this.caretEl.style.height = `${ snapPx(cell.h) }px`;
      // Unfocused, xterm outlines the cell rather than filling it. Match that, or the terminal
      // looks focused when it is not. A caret sitting on the image is always an outline: filled,
      // it would hide the picture it is meant to be pointing at.
      this.caretEl.classList.toggle('hollow', box.w > cell.w || !host?.classList.contains('focus'));
      host?.classList.add('mc-thumb-caret-on');
    },

    /**
     * How far one character advances in the DOM, for the terminal's own font and size.
     *
     * It is not the cell width. xterm paints each glyph at an exact multiple of the cell on a
     * canvas, while the DOM advances by whatever the font says - here 7.6px against a 7px cell -
     * and the two disagree a little more with every character. Two hundred columns of re-rendered
     * tail put the text a hundred and seventy pixels right of the grid, which is the caret
     * falling steadily further behind what is being typed. Measured once per font and size, and
     * corrected with letter-spacing below.
     */
    charAdvance(font, size) {
      const key = `${ font }|${ size }`;

      if (this.advanceCache[key]) {
        return this.advanceCache[key];
      }

      const probe = document.createElement('span');

      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
      probe.style.fontFamily = font;
      probe.style.fontSize = `${ size }px`;
      probe.textContent = 'M'.repeat(100);
      (this.thumbLayer || document.body).appendChild(probe);

      const advance = probe.getBoundingClientRect().width / 100;

      probe.remove();

      if (advance > 0) {
        this.advanceCache = { ...this.advanceCache, [key]: advance };
      }

      return advance || size * 0.6;
    },

    /** The image's box: its own aspect at one line tall, rounded up to whole cells. */
    sizeThumb(img, cell) {
      const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      const cols = Math.max(1, Math.ceil((cell.h * aspect) / cell.w));

      img.style.width = `${ snapPx(cols * cell.w) }px`;
      img.style.height = `${ snapPx(cell.h) }px`;
    },

    /** One <img> per path, kept, so a repaint never re-decodes it or interrupts a click on it. */
    thumbImage(hit, cell) {
      let img = this.thumbImgs[hit.name];

      if (!img) {
        img = document.createElement('img');
        img.src = hit.src;
        img.alt = hit.name;
        img.title = `${ hit.name } - click to view`;
        // Until it loads the image measures zero wide, and the caret is placed by walking these
        // children's widths, so re-place once there is a real width.
        img.addEventListener('load', () => this.scheduleThumbs());
        img.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.openPath(hit.name);
        });
        this.thumbImgs[hit.name] = img;
      }

      // The buffer columns this image stands for - the whole path - which is what the caret
      // counts. How wide it is drawn is a separate question, answered by sizeThumb.
      img.dataset.cols = String(hit.name.length);
      this.sizeThumb(img, cell);

      return img;
    },

    /**
     * The clipboard, for when the keystroke never becomes a paste event this can see.
     *
     * Reading it needs permission the browser may refuse; saying so beats the silence that made
     * a refused read look like nothing had happened at all.
     */
    async pasteFromClipboard() {
      try {
        const items = await navigator.clipboard.read();

        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));

          if (!type) {
            continue;
          }

          const blob = await item.getType(type);

          await this.onImages({ preventDefault: () => {} }, { files: [new File([blob], 'clipboard', { type })] });

          return;
        }
      } catch (e) {
        this.imageError = `could not read the clipboard: ${ e.message || e }`;
        setTimeout(() => {
          this.imageError = '';
        }, 6000);
      }
    },

    async onImages(event, source) {
      const files = [...(source?.files || [])].filter((file) => file.type.startsWith('image/'));

      if (!files.length) {
        return;
      }

      event.preventDefault();
      this.imageError = '';

      // The same pod the session is attached to, resolved the same way the socket resolves it,
      // so an image lands in the filesystem the shell on screen is actually looking at.
      const isAgent = this.target === 'agent';
      const pod = isAgent ? await agentPod() : await extensionPod(this.extension);

      if (!pod) {
        this.imageError = 'no running pod to write the image to';

        return;
      }

      for (const file of files) {
        // Named for when it arrived rather than what the clipboard called it: a pasted
        // screenshot is usually called `image.png` every single time.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const extension = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '');
        const path = `${ isAgent ? AGENT_IMAGE_DIR : IMAGE_DIR }/${ stamp }.${ extension }`;

        try {
          this.pasting = true;
          await writeImageToPod(
            pod, path, await file.arrayBuffer(), isAgent ? 'the agent' : this.extension, this.podContainer,
          );
          // A trailing space, so a second image or a sentence after it does not run together
          // with the path.
          this.send(STDIN + base64Encode(`${ path } `));
        } catch (e) {
          this.imageError = e.message || String(e);
        } finally {
          this.pasting = false;
        }
      }
    },

    send(frame) {
      if (this.state === 'open') {
        this.socket.send(frame);
      } else {
        this.backlog.push(frame);
      }
    },

    /**
     * Type a line into the session from outside it, as the Studio composer does.
     *
     * This is exactly what a person typing the same words would produce - stdin, then a
     * carriage return - so claude cannot tell the two apart, and neither can the terminal:
     * the text appears in the scrollback the way anything else typed does.
     *
     * `\r` rather than `\n`, matching what xterm sends for Enter. A newline reaches most
     * readline implementations as a literal rather than as a submit.
     */
    sendText(text) {
      if (!text) {
        return;
      }

      this.send(STDIN + base64Encode(`${ text }\r`));
    },

    flush() {
      const backlog = this.backlog;

      this.backlog = [];
      backlog.forEach((frame) => this.socket.send(frame));
    },

    fit() {
      // Measuring a box that is not laid out yet is how the grid ends up a sliver and stays
      // there: fit() commits an 11x5 grid quite happily, and nothing measures again until
      // something forces a resize. Skip until there is a real box.
      const box = this.$refs.xterm?.getBoundingClientRect();

      if (!this.fitAddon || !box || box.width < 40 || box.height < 20) {
        return;
      }

      try {
        this.fitAddon.fit();
        this.sendResize();
      } catch { /* a fit against a box mid-layout */ }
    },

    sendResize() {
      if (this.state !== 'open' || !this.terminal) {
        return;
      }

      const { cols, rows } = this.terminal;

      // A grid this small is a bad measurement, and telling tmux about it makes it repaint the
      // pane at that size - which is the state somebody then has to resize the window to escape.
      if (!cols || !rows || cols < MIN_COLS || rows < MIN_ROWS) {
        return;
      }

      this.send(RESIZE + base64Encode(JSON.stringify({ Width: Math.floor(cols), Height: Math.floor(rows) })));
    },

    /**
     * Re-fitting alone does not repair a bad paint.
     *
     * FitAddon.fit() only resizes when the computed grid DIFFERS from what the terminal already
     * has, so a terminal that measured its box while the font or the canvas was not ready keeps
     * its wrong-looking output for ever: every later fit is a no-op. That is why the fix has
     * always been to resize the window by hand.
     *
     * So this does three things a fit cannot: re-measure the character cell, drop the glyph
     * cache, and repaint every row.
     */
    revive() {
      if (!this.terminal) {
        return;
      }

      try {
        this.terminal.clearTextureAtlas?.();
      } catch { /* older xterm */ }
      try {
        this.terminal._core?._charSizeService?.measure?.();
      } catch { /* private, and allowed to move */ }

      const box = this.$refs.xterm?.getBoundingClientRect();
      const dims = box && box.width >= 40 && box.height >= 20 ? this.fitAddon?.proposeDimensions() : null;

      if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) && dims.cols >= MIN_COLS && dims.rows >= MIN_ROWS) {
        try {
          if (dims.cols !== this.terminal.cols || dims.rows !== this.terminal.rows) {
            this.terminal.resize(dims.cols, dims.rows);
          } else {
            // The numbers already match, so resize() would decline. Bounce by a column and back:
            // that is a real relayout, which re-sizes the renderer's canvas as well as the grid,
            // and is exactly what dragging the window edge did by hand.
            this.terminal.resize(Math.max(MIN_COLS, dims.cols - 1), dims.rows);
            this.terminal.resize(dims.cols, dims.rows);
          }

          this.sendResize();
        } catch { /* ignore */ }
      }

      try {
        this.terminal.refresh(0, this.terminal.rows - 1);
      } catch { /* ignore */ }

      this.scheduleThumbs();
    },

    /** Coalesce the several triggers into one pass per frame. */
    scheduleFit(hard = false) {
      if (this.fitFrame) {
        return;
      }

      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = 0;

        if (hard) {
          this.revive();
        } else {
          this.fit();
        }
      });
    },

    /**
     * Becoming visible is not one moment: the element is inserted, the flex layout settles, the
     * font resolves, and the first frame paints - each a chance to measure too early. One revive
     * once the layout has had a frame or two, rather than a burst of them, which is four chances
     * to be right and four visible flashes.
     */
    settleFits() {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.scheduleFit(true), 150);
    },

    /** The phone keyboard must never bury the line being typed. */
    onViewportResize() {
      const vv = window.visualViewport;
      const el = this.$refs.xterm;

      if (!vv || !el) {
        return;
      }

      const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));

      // Ignore the small continuous changes a scroll produces; only a keyboard opening or
      // closing is worth a refit.
      if (Math.abs(covered - this.kbInset) < 24) {
        return;
      }

      this.kbInset = covered;
      el.style.setProperty('--kb-inset', `${ covered }px`);
      this.scheduleFit();
      requestAnimationFrame(() => this.terminal?.scrollToBottom());
    },

    onFontSizeQuery() {
      if (!this.terminal) {
        return;
      }

      this.terminal.options.fontSize = terminalFontSize();
      this.scheduleFit(true);
    },

    // tmux owns the scrollback - the xterm viewport only holds the current screen - so a touch
    // drag is turned into wheel notches for tmux rather than a scroll of an empty viewport.
    onTouchStart(event) {
      this.touchY = event.touches[0]?.clientY ?? 0;
      this.touchAcc = 0;
    },

    onTouchMove(event) {
      const y = event.touches[0]?.clientY ?? 0;
      const dy = y - this.touchY;

      this.touchY = y;
      this.touchAcc += dy;

      const lines = Math.trunc(this.touchAcc / TOUCH_LINE_PX);

      if (!lines) {
        return;
      }

      this.touchAcc -= lines * TOUCH_LINE_PX;
      event.preventDefault();
      this.wheel(Math.abs(lines), lines > 0);
    },

    /** Wheel notches, as tmux expects them. */
    wheel(lines, up) {
      const seq = up ? '\x1b[A' : '\x1b[B';

      this.sendKeys(seq.repeat(Math.min(lines, 10)));
    },
  },
};
</script>

<template>
  <div class="mc-terminal">
    <div
      ref="xterm"
      class="mc-terminal__xterm"
    />
    <!-- Touch only: the keys a phone keyboard does not have. -->
    <div
      v-if="showKeyBar"
      class="mc-terminal__keys"
    >
      <button
        class="mc-terminal__key"
        :class="{ 'mc-terminal__key--armed': ctrlArmed }"
        title="Ctrl - applies to the next key you type"
        @click="armCtrl"
      >
        Ctrl
      </button>
      <button
        v-for="key in KEY_BAR"
        :key="key.label"
        class="mc-terminal__key"
        :title="key.title || key.label"
        @click="tapKey(key.seq)"
      >
        {{ key.label }}
      </button>
    </div>
    <!--
      A pasted image takes a second or two to get into the pod, and until the path appears at
      the prompt nothing else says anything happened.
    -->
    <div
      v-if="pasting || imageError"
      class="mc-terminal__paste"
      :class="{ 'mc-terminal__paste--error': imageError }"
    >
      {{ imageError || 'Putting the image in the pod' }}
    </div>
    <!-- Teleported, because the viewer is position: fixed and the panel this terminal sits in
         is animated with a transform - which makes a fixed child position against that panel
         instead of the viewport, so the modal opens somewhere nobody can see. -->
    <Teleport to="body">
      <PodFileViewer
        v-if="viewerPath"
        :pod="viewerPod"
        :path="viewerPath"
        :container="podContainer"
        @close="viewerPath = ''"
      />
    </Teleport>
    <div
      v-if="state !== 'open'"
      class="mc-terminal__status"
    >
      <span>{{ error || statusText }}</span>
      <button
        v-if="state === 'closed'"
        type="button"
        class="mc-terminal__retry"
        @click="reconnect"
      >
        Reconnect
      </button>
    </div>
  </div>
</template>

<style lang="scss">
.mc-terminal__thumbs {
  position: absolute;
  inset: 0;
  // The rows underneath keep their clicks, their selection and their wheel events.
  pointer-events: none;
  overflow: hidden;
  z-index: 5;
}

// Covers the cells from the filename to the end of the line, opaque, with the thumbnail and the
// rest of the sentence re-rendered inside it. Re-rendering is what closes the hole: the terminal
// cannot reflow, so text that followed the name would otherwise stay where the name used to end.
.mc-terminal__thumb {
  position: absolute;
  display: flex;
  align-items: center;
  white-space: pre;
  background: var(--terminal-bg, #141419);
  color: var(--terminal-text, #ece4e8);
  pointer-events: auto;
  overflow: visible;
}

.mc-terminal__thumb img {
  // Sized inline to whole cells; contained rather than cropped, so the picture is centred in
  // the cells it was given instead of being cut to fill them.
  flex: none;
  object-fit: contain;
  border-radius: 2px;
  cursor: pointer;
  display: block;
}

.mc-terminal__thumb:hover img {
  border-color: var(--link, #3d98d3);
}

// The stand-in caret for a line a thumbnail collapsed, and xterm's own cursor hidden while it is
// showing - two carets on one line is worse than the one in the wrong place.
.mc-terminal__caret {
  position: absolute;
  background: var(--terminal-cursor, #ece4e8);
  opacity: 0.85;
  pointer-events: none;
}

.mc-terminal__caret.hollow {
  background: none;
  outline: 1px solid var(--terminal-cursor, #ece4e8);
  outline-offset: -1px;
}

.mc-thumb-caret-on .xterm-cursor-layer {
  display: none;
}


.mc-terminal__keys::-webkit-scrollbar {
  display: none;
}

.mc-terminal__key {
  flex: none;
  min-width: 40px;
  height: 36px;
  padding: 0 8px;
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--body-text);
  font-family: monospace;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
}

/* An armed Ctrl reads as held: the next key typed is the one it applies to. */
.mc-terminal__key--armed {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-text);
}
// Not scoped: @font-face is document-level, and the font has to be declared
// before xterm measures a character or it measures the fallback.
//
// Inlined into the bundle rather than emitted as a file - see the fonts rule in
// pkg/barn/vue.config.js for why that matters for an extension.
@font-face {
  font-family: "Harness Terminal";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("../assets/fonts/harness-terminal-400.woff2") format("woff2");
}

@font-face {
  font-family: "Harness Terminal";
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url("../assets/fonts/harness-terminal-700.woff2") format("woff2");
}
</style>

<style lang="scss" scoped>
.mc-terminal {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  padding: 4px 0 0 6px;
  background: var(--terminal-bg, var(--body-bg));

  &__paste {
    position:      absolute;
    right:         10px;
    bottom:        10px;
    z-index:       2;
    padding:       4px 8px;
    border-radius: var(--border-radius);
    background:    var(--default);
    color:         var(--body-text);
    font-size:     11px;

    &--error {
      background: var(--error);
      color:      var(--error-text, #fff);
    }
  }

  &__xterm {
    flex: 1 1 auto;
    min-height: 0;
    // A stacking context of its own, so xterm's canvas layers are ordered
    // inside it rather than against their neighbours. They carry z-index up to
    // 3, and nothing between them and this pane used to establish a context, so
    // they beat the status overlay below on the only comparison that decides a
    // click. Containing them here means the two siblings are ordered by their
    // own z-index and xterm's internal count stops being this component's
    // business.
    position: relative;
    z-index: 0;
  }

  &__status {
    position: absolute;
    // Above xterm's canvas layers, which are positioned too. Without this the
    // overlay draws on top but the canvas still wins the hit test, so the
    // Reconnect button below cannot be clicked and a disconnected pane is dead
    // until the page is reloaded.
    z-index: 1;
    right: 10px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--body-bg);
    color: var(--muted);
    font-size: 12px;
  }

  &__retry {
    padding: 0;
    border: none;
    background: none;
    color: var(--link);
    cursor: pointer;
  }
}
</style>
