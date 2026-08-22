<script>
// The preview panel from the Studio design (Figma frame 03, node 9:233).
//
// Almost all of this one is real, which is why it is the panel to have built first: the
// toolbar's controls each map onto something the framed dashboard can actually be told to do.
// Back, forward and reload drive the iframe's own history; the route field is the path inside
// it and typing in it navigates; the live dot reports whether the dev server is answering; the
// viewport chip resizes the frame; and the last control opens the same page in a real tab.
//
// The one thing drawn here that is not a live reading is the "Hot reload" timestamp's claim to
// know about compilation. What it actually times is the last navigation this panel saw, which
// is the honest version of the same signal - so it says "Loaded", not "Hot reload".
import { SIcon, SChip, SButton } from '../ui';
import { extensionProxyPath } from '../../extensions';

// The viewport chip cycles these. Widths are the common breakpoints, not the design's - the
// design only ever draws "Desktop".
const VIEWPORTS = [
  { id: 'desktop', label: 'Desktop', icon: 'monitor', width: null },
  { id: 'tablet', label: 'Tablet', icon: 'monitor', width: 834 },
  { id: 'mobile', label: 'Mobile', icon: 'monitor', width: 390 },
];

export default {
  name: 'PreviewPanel',

  components: {
    SIcon, SChip, SButton
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

    frameStyle() {
      const w = this.currentViewport.width;

      return w ? { width: `${ w }px`, margin: '0 auto' } : {};
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

    liveLabel() {
      if (!this.url) {
        return 'Starting the dev server';
      }

      if (!this.loadedAt) {
        return 'Connecting';
      }

      const secs = Math.max(0, Math.round((this.now - this.loadedAt) / 1000));

      if (secs < 5) {
        return 'Loaded · just now';
      }

      if (secs < 60) {
        return `Loaded · ${ secs }s ago`;
      }

      return `Loaded · ${ Math.round(secs / 60) }m ago`;
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
    this.addressTimer = setInterval(() => this.readAddress(), 1000);
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
      this.readAddress();
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

    cycleViewport() {
      const i = VIEWPORTS.findIndex((v) => v.id === this.viewport);

      this.viewport = VIEWPORTS[(i + 1) % VIEWPORTS.length].id;
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
      <div class="preview-panel__live">
        <span
          class="preview-panel__dot"
          :class="{ 'preview-panel__dot--off': !live }"
        />
        {{ liveLabel }}
      </div>

      <SChip
        :label="currentViewport.label"
        :icon="currentViewport.icon"
        clickable
        title="Change the preview width"
        @click="cycleViewport"
      />

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
