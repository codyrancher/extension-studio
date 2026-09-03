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
const IMAGE_PATH_RE = /(?:[\w./@+-]*\/)?[\w.@+-]+\.(?:png|jpe?g|gif|webp|bmp)\b/gi;

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
    await this.setupTerminal();
    this.connectWhenPodIsUp();

    // A socket that dropped while nobody was looking is the common case: a laptop sleeps, a tab
    // sits in the background for an hour, the pod restarts. Coming back to the tab is exactly
    // when somebody wants the session, so that is when it is reattached - rather than leaving
    // them to notice the dead pane and press a button.
    this.onRefocus = () => this.reconnectIfDropped();
    window.addEventListener('focus', this.onRefocus);
    document.addEventListener('visibilitychange', this.onRefocus);
    this.$refs.xterm?.addEventListener('focusin', this.onRefocus);
  },

  beforeUnmount() {
    this.unmounted = true;
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
        fontSize:         13,
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

      pane.addEventListener('paste', (event) => this.onImages(event, event.clipboardData));
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
      this.resizeObserver = new ResizeObserver(() => this.fit());
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
     * Draw an image over each image path on screen.
     *
     * The chip covers exactly the cells the path occupies, opaque, so the text underneath is
     * hidden rather than showing through - and it is only ever as wide as the path, so anything
     * typed after it stays where the terminal put it.
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
      }

      const buf = this.terminal.buffer.active;
      const frag = document.createDocumentFragment();

      for (let row = 0; row < this.terminal.rows; row++) {
        const line = buf.getLine(buf.viewportY + row);

        if (!line) {
          continue;
        }

        const text = line.translateToString(true);

        if (!text.includes('.')) {
          continue;
        }

        IMAGE_PATH_RE.lastIndex = 0;
        for (let hit = IMAGE_PATH_RE.exec(text); hit; hit = IMAGE_PATH_RE.exec(text)) {
          const path = hit[0];

          if (this.thumbMissing[path]) {
            continue;
          }

          const src = this.thumbSrc[path];

          if (src === undefined) {
            this.thumbFor(path);
            continue;
          }

          if (!src) {
            continue;
          }

          const chip = document.createElement('div');

          chip.className = 'mc-terminal__thumb';
          chip.style.left = `${ hit.index * cell.w }px`;
          chip.style.top = `${ row * cell.h }px`;
          chip.style.width = `${ path.length * cell.w }px`;
          chip.style.height = `${ cell.h }px`;
          chip.title = path;

          const img = document.createElement('img');

          img.src = src;
          chip.appendChild(img);
          chip.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.openPath(path);
          });
          frag.appendChild(chip);
        }
      }

      this.thumbLayer.replaceChildren(frag);
    },

    /** Open a path from this session's own pod. */
    async openPath(path) {
      const pod = this.target === 'agent' ? await agentPod() : await extensionPod(this.extension);

      if (!pod) {
        return;
      }

      this.viewerPod = pod;
      this.viewerPath = path;
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
      if (!this.fitAddon || !this.$refs.xterm?.clientWidth) {
        return;
      }

      this.fitAddon.fit();

      if (this.state !== 'open') {
        return;
      }

      const { cols, rows } = this.fitAddon.proposeDimensions() || {};

      if (cols && rows) {
        this.send(RESIZE + base64Encode(JSON.stringify({ Width: Math.floor(cols), Height: Math.floor(rows) })));
      }
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
  z-index: 5;
}

// Covers exactly the cells the path occupies, opaque, so the text under it is hidden. The image
// itself is allowed to overflow upward - a thumbnail one row tall would show nothing.
.mc-terminal__thumb {
  position: absolute;
  display: flex;
  align-items: center;
  pointer-events: auto;
  cursor: pointer;
  overflow: visible;
  background: var(--terminal-bg, #141419);
}

.mc-terminal__thumb img {
  max-height: 44px;
  max-width: 100%;
  border: 1px solid var(--border, #444);
  border-radius: 2px;
  background: #000;
}

/* The on-screen key row: thumb-sized targets, scrolling sideways rather than
   wrapping, and out of the terminal's way. */
.mc-terminal__keys {
  display: flex;
  gap: 4px;
  padding: 4px 6px;
  overflow-x: auto;
  scrollbar-width: none;
  background: var(--nav-bg);
  border-top: 1px solid var(--border);
  padding-bottom: max(4px, env(safe-area-inset-bottom));
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
