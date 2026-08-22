<script>
// Screen 08 · Build failed — explained, with a way back (Figma node 19:621).
//
// The screen's whole argument is in its name: a build that failed is not an error dialog, it is
// a thing that needs explaining and a route out. So this is the message, then the log, then
// three ways back - fix it with the assistant, look at what changed, or try the publish again.
//
// Real: the message and the log are the actual output of the publish that failed, recorded when
// it failed (see publish-failure.ts) so a reload does not lose them. The three actions all go
// somewhere real.
//
// Placeholder: the assistant does not yet read the log and say what went wrong in a sentence,
// which is the "explained" half of the title. The screen picks out the first error line it can
// find - which is a heuristic and says so - rather than claiming to have understood it.
import {
  SButton, SBanner, SIcon, SCard, SEmpty, SLabel
} from '../components/ui';
import { readFailure, clearFailure } from '../publish-failure';
import { DEFAULT_EXTENSION } from '../extensions';
import { EDITOR_ROUTE, REVIEW_ROUTE, STUDIO_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

export default {
  name: 'BarnBuildFailed',

  components: {
    SButton, SBanner, SIcon, SCard, SEmpty, SLabel
  },

  mixins: [fullBleed],

  data() {
    return { failure: null };
  },

  computed: {
    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    log() {
      return this.failure?.log || '';
    },

    /**
     * The first line of the log that looks like the actual error.
     *
     * A heuristic, and the screen labels it as one. A webpack log puts the interesting line a
     * long way down and surrounds it with progress, so showing the tail is usually wrong and
     * showing the head always is.
     */
    firstError() {
      const lines = this.log.split('\n').map((l) => l.trim()).filter(Boolean);

      return lines.find((l) => /^(ERROR|error|Module not found|SyntaxError|TypeError|Failed to)/.test(l))
        || lines.find((l) => /error/i.test(l))
        || '';
    },

    /** Where the error names a file, so the Files link can open the right one. */
    culprit() {
      const m = /([\w./-]+\.(?:vue|ts|js|scss|json))/.exec(this.firstError || this.log);

      return m ? m[1].replace(/^\.\//, '') : '';
    },
  },

  mounted() {
    this.failure = readFailure(this.extension);
  },

  methods: {
    retry() {
      clearFailure();
      this.$router.push({
        name:   EDITOR_ROUTE,
        params: { extension: this.extension },
        query:  { publish: 'local' },
      });
    },

    fixIt() {
      clearFailure();
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: this.extension } });
    },

    seeChanges() {
      this.$router.push({ name: REVIEW_ROUTE, params: { extension: this.extension } });
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
        @click="$router.push({ name: STUDIO_ROUTE })"
      />

      <div class="failed__name">
        <div class="failed__title">
          {{ extension }}
        </div>
        <div class="failed__eyebrow">
          Build failed
        </div>
      </div>
    </div>

    <div class="failed__body">
      <SEmpty
        v-if="!failure"
        icon="check"
        title="No recent build failure"
        message="Nothing failed in this session, or the record of it was cleared. If a publish is failing, run it again and you will land back here with the log."
      >
        <SButton variant="secondary" icon="sparkle" @click="fixIt">
          Back to the workspace
        </SButton>
      </SEmpty>

      <template v-else>
        <!-- the explanation, and the ways out of it -->
        <div class="failed__explain">
          <SBanner type="error" with-icon>
            <strong>The publish did not finish:</strong>
            {{ failure.message }}
          </SBanner>

          <SCard v-if="firstError" title="The line that looks like the problem" icon="alert">
            <code class="failed__error-line">{{ firstError }}</code>
            <p class="failed__hint">
              Picked out of the log by pattern, not by understanding it — the assistant does not
              yet read a build log and explain it. Treat this as a pointer to where to look.
            </p>
          </SCard>

          <div class="failed__ways">
            <SLabel text="Ways back" />
            <div class="failed__buttons">
              <SButton variant="primary" icon="sparkle" @click="fixIt">
                Fix it with the assistant
              </SButton>
              <SButton variant="neutral" icon="compare" @click="seeChanges">
                See what changed{{ culprit ? ` (${ culprit })` : '' }}
              </SButton>
              <SButton variant="neutral" icon="refresh" @click="retry">
                Try the publish again
              </SButton>
            </div>
          </div>
        </div>

        <!-- the log, filling the height rather than pushing the buttons off the bottom -->
        <div class="failed__log-panel">
          <div class="failed__panel-head">
            <SIcon name="terminal" :size="14" />
            <span class="failed__panel-title">Build log</span>
          </div>
          <pre class="failed__log">{{ log || 'The build produced no output.' }}</pre>
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
    color:          var(--studio-error);
  }

  // The frame's body is a row: the explanation on the left, the log beside it. Stacking them
  // put the ways back below a log that can be hundreds of lines, which is the one thing this
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

  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-12) 14px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
  }

  &__panel-title { font: var(--studio-heading-14); color: var(--studio-text); }

  &__error-line {
    display:       block;
    font:          var(--studio-mono-12);
    color:         var(--studio-error);
    background:    var(--studio-error-bg);
    border-radius: var(--studio-radius-control);
    padding:       var(--studio-space-8) 10px;
    word-break:    break-word;
  }

  &__hint {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: var(--studio-space-8) 0 0;
  }

  &__ways {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__buttons {
    display:   flex;
    gap:       10px;
    flex-wrap: wrap;
  }

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
