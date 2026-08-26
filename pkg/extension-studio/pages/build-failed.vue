<script>
// Screen 08 · Build failed (Figma node 19:621) - a route that should not need to exist.
//
// The frame does not draw a page. It draws the *workspace*, screen 03, in its failed state:
// the same rail, header, masthead, tab strip, conversation, composer and preview canvas, with
// the failure sitting inside the conversation as the assistant's turn (19:1007) and an
// explainer over the preview (19:830). The flow map says the same thing a second way - the
// amber arrow leaves "Build it and watch it", reaches "It breaks", and comes back down into the
// *same* box - under a legend that reads "every recovery route leads back into the same
// workspace rather than out of the product" (43:4).
//
// So the failure state belongs in pages/editor.vue, and everything that is actually the failure
// now lives in components/BuildFailure.vue, which editor.vue can mount as one element. This
// page is what is left: a masthead, a place to put that component, and a way back into the
// workspace. When the workspace mounts it, this route should redirect there instead of
// rendering, and the four-control page that used to be here goes away.
//
// The two-column shell is kept as it was on purpose. scripts/design-check measures
// `.failed__masthead`, `.failed__explain`, `.failed__log-panel` and `.failed__panel-head`
// against the frame, and this route is the only place those exist.
import {
  SButton, SBadge, SIcon, SEmpty
} from '../components/ui';
import BuildFailure from '../components/BuildFailure.vue';
import { readFailure } from '../publish-failure';
import { DEFAULT_EXTENSION } from '../extensions';
import { EDITOR_ROUTE, STUDIO_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

export default {
  name: 'BarnBuildFailed',

  components: {
    SButton, SBadge, SIcon, SEmpty, BuildFailure
  },

  mixins: [fullBleed],

  data() {
    return {
      failure: null,
      showLog: false,
    };
  },

  computed: {
    /**
     * The route names, exposed to the template.
     *
     * A plain `<script>` block's module scope is not the render function's scope, so an
     * imported constant named directly in the template resolves to undefined and
     * `$router.push({ name: undefined })` is dropped without an error. That is a button that
     * looks live and does nothing, silently - which is exactly how these were found.
     */
    routes() {
      return { STUDIO_ROUTE, EDITOR_ROUTE };
    },

    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    log() {
      return this.failure?.log || '';
    },

    logLines() {
      return this.log ? this.log.split('\n').length : 0;
    },

    logLabel() {
      if (!this.logLines) {
        return 'The build produced no output';
      }

      return `${ this.showLog ? 'Hide' : 'Show' } raw output`;
    },
  },

  mounted() {
    this.failure = readFailure(this.extension);
  },

  methods: {
    /** Back into the workspace, which is where the design's recovery arrow points. */
    toWorkspace() {
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: this.extension } });
    },

    /** The failure has been dealt with; this route has nothing left to say. */
    onResolved() {
      this.failure = null;
    },
  },
};
</script>

<template>
  <div class="failed">
    <div class="failed__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back"
        @click="$router.push({ name: routes.STUDIO_ROUTE })"
      />

      <div class="failed__name">
        <div class="failed__title">
          {{ extension }}
        </div>
        <div class="failed__eyebrow">
          Extension Studio
        </div>
      </div>

      <SBadge v-if="failure" status="failed" data-testid="barn-failed-badge" />

      <span class="failed__grow" />

      <SButton
        variant="secondary"
        size="sm"
        icon="sparkle"
        data-testid="barn-to-workspace"
        @click="toWorkspace"
      >
        Back to the workspace
      </SButton>
    </div>

    <div class="failed__body">
      <SEmpty
        v-if="!failure"
        icon="check"
        title="No recent build failure"
        message="Nothing failed in this session, or the record of it was cleared. If a publish is failing, run it again and you will land back here with the log."
      >
        <SButton variant="secondary" icon="sparkle" @click="toWorkspace">
          Back to the workspace
        </SButton>
      </SEmpty>

      <template v-else>
        <!--
          The failure itself, and every action that belongs to it. The same element the
          workspace mounts, so the two surfaces cannot drift apart.
        -->
        <div class="failed__explain">
          <BuildFailure
            :extension="extension"
            raw="none"
            @resolved="onResolved"
          />
        </div>

        <!-- the log, filling the height rather than pushing the ways back off the bottom -->
        <div class="failed__log-panel">
          <!--
            Collapsed to start with, as the design draws it (19:1030), and the line count is
            the point of the row: it says how long the log is before you commit to reading it.
          -->
          <button
            type="button"
            class="failed__panel-head"
            :aria-expanded="showLog"
            data-testid="barn-raw-output-toggle"
            :disabled="!logLines"
            @click="showLog = !showLog"
          >
            <SIcon name="terminal" :size="14" />
            <span class="failed__panel-title">{{ logLabel }}</span>
            <span v-if="logLines" class="failed__panel-count">
              {{ logLines }} line{{ logLines === 1 ? '' : 's' }}
            </span>
            <span class="failed__panel-grow" />
            <SIcon
              v-if="logLines"
              :name="showLog ? 'chevronUp' : 'chevronDown'"
              :size="14"
            />
          </button>
          <pre v-if="showLog && logLines" class="failed__log">{{ log }}</pre>

          <SEmpty
            v-else-if="logLines"
            icon="terminal"
            title="The raw output is collapsed"
            :message="`${ logLines } lines of build output are kept with this failure and survive a reload. Open the row above to read them.`"
          />

          <SEmpty
            v-else
            icon="terminal"
            title="The build produced no output"
            message="The publish failed without the build writing anything, so there is no log to read. The message above is the whole of what was said."
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.failed {
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  background:     var(--studio-surface);

  &__masthead {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       10px var(--studio-space-16);
    border-bottom: 1px solid var(--studio-border);
    flex:          0 0 auto;
  }

  &__name { display: flex; flex-direction: column; gap: 1px; }
  &__title { font: var(--studio-heading-16); color: var(--studio-text); }

  &__eyebrow {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__grow { flex: 1 1 auto; }

  // The frame's body is a row: the failure on the left, the log beside it. Stacking them put
  // the ways back below a log that can be hundreds of lines, which is the one thing this
  // screen exists to keep in reach.
  &__body {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
  }

  &__explain {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-16);
    flex:           0 1 var(--studio-panel-assistant);
    min-width:      var(--studio-panel-assistant-min);
    padding:        var(--studio-space-20) var(--studio-space-24);
    border-right:   1px solid var(--studio-border);
    overflow-y:     auto;
    min-height:     0;
  }

  &__log-panel {
    display:        flex;
    flex-direction: column;
    // Basis 0, not auto: on auto the column asks for its content width - a diff's longest
    // line, a log's longest line - and the rails next to it spend their whole shrink budget
    // answering, so they never sit at their drawn width even on a wide screen. Basis 0 makes
    // it take the space left over, and min-width is what stops that going to nothing.
    flex:           1 1 0;
    min-width:      var(--studio-panel-main-min);
    min-height:     0;
  }

  // A button now rather than a caption, so everything a button brings by default has to be
  // taken back off: the geometry here is measured against the design (14:389).
  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-12) 14px;
    background:    var(--studio-surface-subtle);
    border:        none;
    border-bottom: 1px solid var(--studio-border-subtle);
    border-radius: 0;
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
    width:         100%;
    min-height:    0;
    text-align:    left;
    cursor:        pointer;

    &:hover:not(:disabled) { color: var(--studio-text); }

    &:disabled { cursor: default; }
  }

  &__panel-count {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__panel-grow { flex: 1 1 auto; }

  &__panel-title { font: var(--studio-heading-14); color: var(--studio-text); }

  &__log {
    margin:      0;
    padding:     var(--studio-space-12) var(--studio-space-16);
    background:  var(--studio-surface-terminal);
    color:       var(--studio-terminal-text);
    font:        var(--studio-mono-12);
    white-space: pre-wrap;
    word-break:  break-word;
    flex:        1 1 auto;
    min-height:  0;
    overflow-y:  auto;
  }
}
</style>
