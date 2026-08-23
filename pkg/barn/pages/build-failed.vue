<script>
// Screen 08 · Build failed - explained, with a way back (Figma node 19:621).
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
// find - which is a heuristic and says so - rather than claiming to have understood it. When
// the heuristic finds nothing it says that too: a card that vanishes leaves the screen with no
// explanation at all and no hint that one was attempted.
import {
  SButton, SBanner, SIcon, SCard, SEmpty, SLabel
} from '../components/ui';
import { readFailure, clearFailure } from '../publish-failure';
import { DEFAULT_EXTENSION, listExtensionFiles, readExtensionFile } from '../extensions';
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
    return {
      failure: null,
      // Whether the build log is open. Collapsed to start with, as the design draws it: the
      // row says how many lines there are so the size of the read is known before it is taken.
      showLog: false,
      // The culprit file, when somebody has asked to see it.
      file:    null,
      fileError: '',
      reading: false,
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
      return { STUDIO_ROUTE };
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

    /**
     * Where the error names a file, so "Show me the file" can open the right one.
     *
     * The error line first, because that is the one that names the file the build tripped over.
     * A webpack summary line ("Failed to compile with 1 error") names nothing, though, and used
     * to end the search there - so the whole log is the fallback rather than the alternative.
     */
    culprit() {
      const find = (text) => /([\w./-]+\.(?:vue|ts|js|scss|json))/.exec(text || '');
      const m = find(this.firstError) || find(this.log);

      return m ? m[1].replace(/^\.\//, '') : '';
    },

    /**
     * The line the log points at inside that file, when it gives one.
     *
     * webpack writes the position two ways - `path.vue 12:3` on the module line and `(12:5)` in
     * the parse error under it - and either is enough to open the file where the problem is
     * rather than at the top.
     */
    culpritLine() {
      if (!this.culprit) {
        return 0;
      }

      const escaped = this.culprit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A window rather than the rest of the line: webpack puts the position on the line after
      // the module it belongs to as often as on the same one.
      const near = new RegExp(`${ escaped }[\\s\\S]{0,200}?[\\s:(](\\d+):(\\d+)`).exec(this.log);

      return near ? parseInt(near[1], 10) || 0 : 0;
    },

    /** The file's lines, numbered, for the inline view. */
    fileLines() {
      return (this.file?.text || '').split('\n');
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

    /**
     * Open the file the log points at, here, at the line it points at.
     *
     * Here rather than on the Files screen, and that is deliberate: this screen is the one
     * holding the log, and a route away from it would need the path to travel in the query,
     * which the Files screen does not read - the exact class of dead handoff that made "Try
     * the publish again" retry nothing. The file is read out of the pod, so it is the file as
     * it is now rather than a copy of it from when the build failed.
     *
     * The path in a webpack error is relative to wherever webpack was standing, which is not
     * always the package root, so it is matched against the package's own listing by suffix
     * rather than trusted as written.
     */
    async showFile() {
      if (this.reading || !this.culprit) {
        return;
      }

      if (this.file) {
        this.file = null;

        return;
      }

      this.reading = true;
      this.fileError = '';

      try {
        const paths = await listExtensionFiles(this.extension);
        const path = paths.find((p) => p === this.culprit)
          || paths.find((p) => p.endsWith(`/${ this.culprit }`))
          || paths.find((p) => p.endsWith(`/${ this.culprit.split('/').pop() }`));

        if (!path) {
          this.fileError = `The log names ${ this.culprit }, and there is no such file in this extension. It is most likely a path from inside a dependency, or from a build that is no longer what the pod holds.`;

          return;
        }

        const text = await readExtensionFile(this.extension, path);

        this.file = { path, text };
        this.$nextTick(() => this.scrollToLine());
      } catch (e) {
        this.fileError = e?.message || String(e);
      } finally {
        this.reading = false;
      }
    },

    /** Put the line the log named in the middle of the view, rather than at the top. */
    scrollToLine() {
      const row = this.$refs.culpritRow?.[0] || this.$refs.culpritRow;

      row?.scrollIntoView({ block: 'center' });
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

          <SCard title="The line that looks like the problem" icon="alert">
            <code v-if="firstError" class="failed__error-line">{{ firstError }}</code>
            <p v-else class="failed__error-none">
              No line in this log looks like an error. The publish reported the failure above,
              so something went wrong after or outside the compile - the raw output beside this
              is the whole of what was said.
            </p>
            <p class="failed__hint">
              Picked out of the log by pattern, not by understanding it - the assistant does not
              yet read a build log and explain it. Treat this as a pointer to where to look.
            </p>

            <!-- The design's ghost "Show me the file" (19:1026): the file, at the line. -->
            <div v-if="culprit" class="failed__file-actions">
              <SButton
                variant="ghost"
                size="sm"
                icon="file"
                :loading="reading"
                data-testid="barn-show-file"
                @click="showFile"
              >
                {{ file ? 'Hide' : 'Show me' }} {{ culprit }}{{ culpritLine ? ` at line ${ culpritLine }` : '' }}
              </SButton>
            </div>

            <p v-if="fileError" class="failed__error-none">
              {{ fileError }}
            </p>

            <div v-if="file" class="failed__file">
              <div class="failed__file-head">
                <SIcon name="file" :size="13" />
                <span>{{ file.path }}</span>
              </div>
              <div class="failed__file-body">
                <div
                  v-for="(line, i) in fileLines"
                  :key="i"
                  :ref="i + 1 === culpritLine ? 'culpritRow' : undefined"
                  class="failed__file-line"
                  :class="{ 'failed__file-line--here': i + 1 === culpritLine }"
                >
                  <span class="failed__file-num">{{ i + 1 }}</span>
                  <span class="failed__file-text">{{ line }}</span>
                </div>
              </div>
            </div>
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

  &__error-line {
    display:       block;
    font:          var(--studio-mono-12);
    color:         var(--studio-error);
    background:    var(--studio-error-bg);
    border-radius: var(--studio-radius-control);
    padding:       var(--studio-space-8) 10px;
    word-break:    break-word;
  }

  &__error-none {
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__file-actions { margin-top: var(--studio-space-12); }

  &__file {
    margin-top:    var(--studio-space-12);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    overflow:      hidden;
  }

  &__file-head {
    display:       flex;
    align-items:   center;
    gap:           6px;
    padding:       6px 10px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    font:          var(--studio-caption-12-semi);
    color:         var(--studio-text-secondary);
  }

  &__file-body {
    max-height: 320px;
    overflow:   auto;
  }

  &__file-line {
    display: flex;
    gap:     10px;
    padding: 0 10px;
    font:    var(--studio-mono-12);

    &--here {
      background: var(--studio-error-bg);
      color:      var(--studio-error);
    }
  }

  &__file-num {
    flex:       0 0 auto;
    min-width:  28px;
    text-align: right;
    color:      var(--studio-text-tertiary);
    user-select: none;
  }

  &__file-text {
    white-space: pre-wrap;
    word-break:  break-word;
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
