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
import {
  SIcon, SChip, SButton, SMenu
} from '../ui';
import { extensionProxyPath } from '../../extensions';

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

/** Clear the frame's resource timings before its buffer fills and stops recording. */
const TIMING_LIMIT = 400;

export default {
  name: 'PreviewPanel',

  components: {
    SIcon, SChip, SButton, SMenu
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
  },

  // The path inside the frame, for anything outside that needs to say where the preview is
  // pointed - the verification screen records it against each verdict.
  emits: ['route'],

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

      return w ? { width: `${ w }px`, flex: '0 0 auto', margin: '0 auto' } : {};
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

    popoutUrl() {
      return this.url ? `${ extensionProxyPath(this.extension) }${ this.path }` : '';
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
     * The design's "Hot reload · 3s ago", and the honest fallback for before there has been one.
     *
     * Two different facts wearing the same shape: once the dev server has patched the page in
     * place there is a hot reload to time, and until then the only thing that has happened is
     * the navigation.
     */
    liveLabel() {
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
      return this.hotAt
        ? 'The dev server last patched this page without reloading it, which is what hot reload is. Timed from the frame\'s own hot-update requests.'
        : 'Timed from the last time the frame navigated. It will say "Hot reload" once the dev server patches the page in place.';
    },
  },

  watch: {
    // Immediate, because a preview that opens on `/` and never moves still has a route, and a
    // listener that only hears about changes would never learn what it is.
    path: {
      handler(to) {
        this.$emit('route', to);
      },
      immediate: true,
    },
  },

  mounted() {
    this.addressTimer = setInterval(() => {
      this.readAddress();
      this.readHotReload();
    }, 1000);
    this.nowTimer = setInterval(() => {
      this.now = Date.now();
    }, 1000);
  },

  beforeUnmount() {
    clearInterval(this.addressTimer);
    clearInterval(this.nowTimer);
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
            .replace(extensionProxyPath(this.extension), '') || '/';

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
        // Cross-origin or mid-navigation: re-assigning src reloads it either way.
        const f = this.$refs.frame;

        if (f) {
          f.src = f.src;
        }
      }
    },

    go() {
      if (!this.$refs.frame) {
        return;
      }

      this.$refs.frame.contentWindow.location.href = `${ extensionProxyPath(this.extension) }${ this.path }`;
      this.$refs.address?.blur();
    },

    setViewport(id) {
      if (VIEWPORTS.some((v) => v.id === id)) {
        this.viewport = id;
      }
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

      <!-- live state (9:247) -->
      <div class="preview-panel__live" :title="liveTitle">
        <span
          class="preview-panel__dot"
          :class="{ 'preview-panel__dot--off': !live }"
        />
        {{ liveLabel }}
      </div>

      <!--
        A menu rather than a chip that cycles: the design draws one chip, and the thing behind
        it is a choice of three, which a list says and a cycle does not.
      -->
      <SMenu
        class="preview-panel__viewport"
        :items="viewportItems"
        align="right"
        aria-label="Change the preview width"
        data-testid="barn-preview-viewport"
        @select="setViewport"
      >
        <template #trigger>
          <SChip
            :label="currentViewport.label"
            :icon="currentViewport.icon"
          />
          <SIcon name="chevronDown" :size="13" />
        </template>
      </SMenu>

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
      <iframe
        v-if="url"
        ref="frame"
        class="preview-panel__frame"
        :style="frameStyle"
        :src="url"
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

    &--off { background: var(--studio-text-tertiary); }
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
    display:  flex;
    flex:     1 1 auto;
    padding:  var(--studio-space-16);
    min-height: 0;
    background: var(--studio-surface);
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
