<script>
// Screen 04 · Review changes before publishing (Figma node 14:285).
//
// The gate in front of publishing: a list of what changed, the diff of whichever file is
// selected, and a rail explaining it. Three panels and an action bar.
//
// Real: the file list (git status in the pod, with the same line counts screen 12 shows), each
// file's diff, Discard all (checkout plus clean), Keep and continue building (back to the
// workspace), Publish - which is the same publish the workspace's button runs - and the
// explanation rail's question.
//
// The rail is worth being exact about. The design has the assistant explain each change in prose
// beside its diff, and nothing writes that prose into this page: what the product has is one
// claude per pod, in a conversation, in the workspace's terminal. So the rail does not pretend
// to hold an explanation. It asks the real assistant about the file you are looking at and takes
// you to where it answers, and it says that is what it is doing.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, SBanner
} from '../components/ui';
import DiffView from '../components/DiffView.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  changedFiles, fileDiff, discardChanges, listBranches, askAssistant, DEFAULT_EXTENSION
} from '../extensions';
import { EDITOR_ROUTE, STUDIO_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

export default {
  name: 'BarnReview',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, SBanner, DiffView
  },

  mixins: [fullBleed],

  data() {
    return {
      files:    [],
      selected: '',
      patch:    '',
      branch:   '',
      loading:  true,
      diffing:  false,
      discarding: false,
      asking:   false,
      // The paths still ticked in the file list (14:395). Everything is kept until somebody
      // says otherwise, which is what makes the default row of the action bar honest.
      kept:     [],
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

    count() {
      return this.files.length;
    },

    summary() {
      if (!this.count) {
        return 'Nothing has changed since the last commit.';
      }

      return `These changes are running in your preview only. ${ this.kept.length } of ${ this.count } file${ this.count === 1 ? '' : 's' } will be kept.`;
    },

    /** The paths whose box has been cleared: the ones the discard is being aimed at. */
    unkept() {
      return this.files.map((f) => f.path).filter((p) => !this.kept.includes(p));
    },

    /**
     * What Discard actually throws away.
     *
     * With boxes cleared it is those files and only those. With every box still ticked there is
     * no selection to honour, so it stays what it has always been - the whole working tree -
     * rather than becoming a button that cannot be pressed.
     */
    discardTargets() {
      return this.unkept.length ? this.unkept : this.files.map((f) => f.path);
    },

    discardLabel() {
      return this.unkept.length && this.unkept.length < this.count ? `Discard ${ this.unkept.length }` : 'Discard all';
    },

    selectedFile() {
      return this.files.find((f) => f.path === this.selected) || null;
    },

    /**
     * What the rail asks about the file on screen.
     *
     * Named after the file rather than "explain the change", because the conversation in the pod
     * has been editing this tree all session and "the change" is ambiguous to it in a way a path
     * is not. The last clause is the one that matters: this is a review screen, and a question
     * that came back as an edit would change what is being reviewed underneath the reviewer.
     */
    explainPrompt() {
      const file = this.selectedFile;

      if (!file) {
        return '';
      }

      return `In the working tree of the ${ this.extension } extension, explain the ${ file.status } file ${ file.path }: what the change does, why it was made, and anything in it a reviewer should question. Explain it here in the terminal and do not edit any files.`;
    },
  },

  watch: {
    selected: 'loadDiff',
    extension: 'load',
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      // A freshly created extension has no repository yet, and every reading on this screen
      // is a git reading - so without this the screen is simply empty, with nothing saying
      // why. Memoised and idempotent, so this costs one exec the first time and nothing after.
      await ensureRepo(this.extension).catch(() => {});

      this.loading = true;

      const [files, branches] = await Promise.all([
        changedFiles(this.extension).catch(() => []),
        listBranches(this.extension).catch(() => null),
      ]);

      this.files = files;
      this.branch = branches?.current || '';
      this.loading = false;
      // Every file that is still here is kept. A box cleared before a reload was either acted
      // on, in which case the file is gone, or it was not, in which case the reload is the
      // moment to stop implying somebody still means to throw it away.
      this.kept = files.map((f) => f.path);

      if (files.length && !files.find((f) => f.path === this.selected)) {
        this.selected = files[0].path;
      } else if (!files.length) {
        this.selected = '';
        this.patch = '';
      }
    },

    async loadDiff() {
      if (!this.selected) {
        this.patch = '';

        return;
      }

      this.diffing = true;
      this.patch = await fileDiff(this.extension, this.selected).catch(() => '');
      this.diffing = false;
    },

    /** Tick or clear one file's box. Clearing it is what marks the file for discarding. */
    toggleKeep(file) {
      this.kept = this.kept.includes(file.path) ? this.kept.filter((p) => p !== file.path) : [...this.kept, file.path];
    },

    async discardSelected() {
      const paths = this.discardTargets;
      const all = paths.length === this.count;
      const what = all ? `all ${ this.count } changed files` : `${ paths.length } of the ${ this.count } changed files`;

      // eslint-disable-next-line no-alert
      if (!window.confirm(`Discard ${ what } in ${ this.extension }? This cannot be undone.`)) {
        return;
      }

      this.discarding = true;

      try {
        await discardChanges(this.extension, all ? [] : paths);
        toastSuccess(
          this.$store,
          'Changes discarded',
          all ? `${ this.extension } is back to its last commit.` : `${ paths.length } file${ paths.length === 1 ? '' : 's' } put back to the last commit.`
        );
        await this.load();
      } catch (e) {
        toastError(this.$store, 'Could not discard the changes', e?.message || String(e));
      } finally {
        this.discarding = false;
      }
    },

    backToAssistant() {
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: this.extension } });
    },

    publish() {
      // The publish flow lives on the workspace, which owns the split button and the status
      // strip that reports it. Sending them there with the intent is better than a second
      // implementation of the same three steps.
      this.$router.push({
        name:   EDITOR_ROUTE,
        params: { extension: this.extension },
        query:  { publish: 'local' },
      });
    },

    /**
     * Ask the pod's claude about the selected file, and go and watch it answer.
     *
     * The question goes into the one conversation this extension has - the workspace terminal's
     * - so it arrives with everything that session already knows, and the answer is somewhere a
     * person can read it and reply to it. Which means leaving this screen, so the toast says
     * which file was asked about before the route changes.
     */
    async askAboutFile() {
      if (!this.selectedFile || this.asking) {
        return;
      }

      const path = this.selected;

      this.asking = true;

      try {
        const how = await askAssistant(this.extension, this.explainPrompt);

        toastSuccess(
          this.$store,
          how === 'sent'
            ? `Asked about ${ path }. The answer appears in the workspace terminal.`
            : `The workspace session is not open yet, so ${ path } is the first thing it will be asked when it opens.`,
          { title: 'Asked the assistant' }
        );

        this.$router.push({
          name:   EDITOR_ROUTE,
          params: { extension: this.extension },
          query:  { tab: 'terminal' },
        });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not ask the assistant' });
      } finally {
        this.asking = false;
      }
    },

    /**
     * The line counts, in the words screen 12's rows use.
     *
     * Same reading, same shape, so a file that is `+21 -3` on the review-a-change screen is
     * `+21 -3` here. Empty for a file git cannot count lines for - an untracked one, which is
     * every file the assistant has just created - because "+0 -0" reads as "nothing changed"
     * about a file that is entirely new.
     */
    fileCounts(file) {
      const counts = [];

      if (file.added) {
        counts.push(`+${ file.added }`);
      }

      if (file.removed) {
        counts.push(`-${ file.removed }`);
      }

      return counts.join(' ');
    },

    statusTone(status) {
      return { added: 'success', deleted: 'error', modified: 'info' }[status] || 'default';
    },
  },
};
</script>

<template>
  <div class="review">
    <!-- workspace masthead (14:356) -->
    <div class="review__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back"
        @click="$router.push({ name: routes.STUDIO_ROUTE })"
      />

      <div class="review__name">
        <div class="review__title">
          {{ extension }}
        </div>
        <div class="review__eyebrow">
          Review changes
        </div>
      </div>

      <SBadge :status="count ? 'unsaved' : 'live'" />
      <SChip v-if="branch" :label="branch" icon="branch" />

      <span class="review__grow" />

      <SButton variant="ghost" size="sm" icon="sparkle" @click="backToAssistant">
        Back to assistant
      </SButton>
      <SButton variant="primary" size="sm" icon="rocket" @click="publish">
        Publish
      </SButton>
    </div>

    <!-- body (14:387) -->
    <div class="review__body">
      <!-- changed files (14:388) -->
      <div class="review__files">
        <div class="review__panel-head">
          <SIcon name="compare" :size="14" />
          <span class="review__panel-title">Changed files</span>
          <span class="review__count">{{ count }}</span>
        </div>

        <div class="review__file-list">
          <!--
            Two controls per row (14:395), so the row is a div rather than a button: a checkbox
            inside a button is neither valid nor operable. The box says whether the file is kept,
            the rest of the row opens its diff.
          -->
          <div
            v-for="file in files"
            :key="file.path"
            class="review__file"
            :class="{ 'review__file--selected': file.path === selected }"
          >
            <input
              type="checkbox"
              class="review__file-box"
              :checked="kept.includes(file.path)"
              :aria-label="`Keep ${ file.path }`"
              @change="toggleKeep(file)"
            >
            <button
              type="button"
              class="review__file-open"
              @click="selected = file.path"
            >
              <SIcon name="file" :size="13" />
              <span class="review__file-path">{{ file.path }}</span>
              <span v-if="fileCounts(file)" class="review__file-stats">{{ fileCounts(file) }}</span>
              <SChip :label="file.status" :tone="statusTone(file.status)" />
            </button>
          </div>

          <div v-if="!loading && !files.length" class="review__file-empty">
            Nothing has changed.
          </div>
        </div>

        <div class="review__note">
          <span class="review__note-text">
            Everything here is in the pod's working tree. Publishing builds from it; discarding
            puts it back to the last commit.
          </span>
        </div>
      </div>

      <!-- diff (14:425) -->
      <div class="review__diff">
        <div class="review__diff-head">
          <SIcon name="code" :size="14" />
          <span class="review__panel-title">{{ selected || 'No file selected' }}</span>
          <span class="review__grow" />
          <SButton
            variant="ghost"
            size="sm"
            icon="refresh"
            icon-only
            title="Re-read this file"
            @click="loadDiff"
          />
        </div>

        <div class="review__code">
          <SEmpty
            v-if="!count && !loading"
            icon="check"
            title="Nothing to review"
            message="The working tree matches the last commit."
          >
            <SButton variant="secondary" icon="sparkle" @click="backToAssistant">
              Back to assistant
            </SButton>
          </SEmpty>

          <div v-else-if="diffing" class="review__loading">
            <SIcon name="spinner" :size="20" class="review__spin" />
            Reading {{ selected }}
          </div>

          <DiffView v-else :patch="patch" />
        </div>
      </div>

      <!-- explanation (14:509) -->
      <div class="review__explain">
        <div class="review__panel-head">
          <SIcon name="sparkle" :size="14" />
          <span class="review__panel-title">Why this changed</span>
        </div>

        <div class="review__explain-body">
          <SBanner type="info">
            The assistant explains a change in the workspace terminal, not on this rail — it is a
            conversation, and half of what makes it useful is being able to argue with it. Asking
            about <strong>{{ selected || 'the selected file' }}</strong> puts the question to the
            session already editing this extension and takes you to the workspace, where it
            answers in the Terminal tab.
          </SBanner>

          <div v-if="selectedFile" class="review__explain-facts">
            <div class="review__fact">
              <span class="review__fact-label">File</span>
              <span class="review__fact-value">{{ selectedFile.path }}</span>
            </div>
            <div class="review__fact">
              <span class="review__fact-label">Change</span>
              <span class="review__fact-value">{{ selectedFile.status }}</span>
            </div>
            <div class="review__fact">
              <span class="review__fact-label">Branch</span>
              <span class="review__fact-value">{{ branch || 'unknown' }}</span>
            </div>
          </div>

          <SButton
            variant="ghost"
            size="sm"
            icon="book"
            :disabled="!selectedFile"
            :loading="asking"
            @click="askAboutFile"
          >
            Ask about this file
          </SButton>
        </div>
      </div>
    </div>

    <!-- review action bar (14:534) -->
    <div class="review__actions">
      <SIcon name="eye" :size="15" />
      <span class="review__summary">{{ summary }}</span>
      <span class="review__grow" />

      <SButton
        variant="ghost"
        icon="trash"
        :disabled="!count"
        :loading="discarding"
        @click="discardSelected"
      >
        {{ discardLabel }}
      </SButton>
      <SButton variant="neutral" @click="backToAssistant">
        Keep and continue building
      </SButton>
      <SButton
        variant="primary"
        icon="rocket"
        :disabled="!count"
        @click="publish"
      >
        Publish…
      </SButton>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.review {
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

  &__name {
    display:        flex;
    flex-direction: column;
    gap:            1px;
  }

  &__title {
    font:  var(--studio-heading-16);
    color: var(--studio-text);
  }

  &__eyebrow {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__grow { flex: 1 1 auto; }

  &__body {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
  }

  // The file tree and the explain rail are the widths Foundations names: 288 and 340.
  &__files {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-tree);
    min-width:      var(--studio-panel-tree-min);
    border-right:   1px solid var(--studio-border);
    min-height:     0;
  }

  &__explain {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-rail);
    min-width:      var(--studio-panel-rail-min);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
    overflow-y:     auto;
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

    // The explanation rail's head is the wider one (14:510); the file list's is 12/14.
    .review__explain & { padding: var(--studio-space-12) var(--studio-space-16); }
  }

  &__panel-title {
    font:          var(--studio-heading-14);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__count {
    padding:       0 6px;
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-neutral-bg);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
  }

  &__file-list {
    flex:       1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  &__file {
    display:       flex;
    align-items:   center;
    gap:           9px;
    width:         100%;
    padding:       10px 14px;
    text-align:    left;
    background:    none;
    border:        none;
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);

    &:hover { background: var(--studio-surface-subtle); }

    &--selected,
    &--selected:hover { background: var(--studio-blue-050); }
  }

  // 14:395: whether this file is kept. Drawn rather than left native, because a native
  // checkbox is a different shape and a different blue in every browser and the row is 3px
  // radius everywhere else.
  &__file-box {
    appearance:      none;
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    flex:            0 0 14px;
    width:           14px;
    height:          14px;
    margin:          0;
    background:      var(--studio-surface);
    border:          1px solid var(--studio-border-strong);
    border-radius:   var(--studio-radius-control);
    cursor:          pointer;

    &:checked {
      background:   var(--studio-green-500);
      border-color: var(--studio-green-500);
    }

    // The tick, as two borders of a rotated box. 4.14:1 against the green, which is a
    // graphical object rather than text and so wants 3:1.
    &:checked::after {
      content:       '';
      width:         3px;
      height:        7px;
      margin-top:    -2px;
      border:        solid var(--studio-text-inverse);
      border-width:  0 2px 2px 0;
      transform:     rotate(45deg);
    }

    &:focus-visible {
      outline:        2px solid var(--studio-border-focus);
      outline-offset: 1px;
    }
  }

  // The rest of the row: the part that opens the diff.
  &__file-open {
    display:     flex;
    align-items: center;
    gap:         9px;
    flex:        1 1 auto;
    min-width:   0;
    padding:     0;
    text-align:  left;
    background:  none;
    border:      none;
    color:       inherit;
    cursor:      pointer;
    // The shell gives every button a 40px minimum for touch targets, which on a row that is
    // 44 tall including its own padding would make it 60. Same escape as the file tree's rows.
    min-height:  0;
  }

  &__file-path {
    flex:          1 1 auto;
    min-width:     0;
    font:          var(--studio-body-13-semi);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    direction:     rtl;
    text-align:    left;
  }

  // The same reading screen 12 puts under its rows (38:1184), on a row that has no second line
  // to put it on.
  &__file-stats {
    flex:            0 0 auto;
    font:            var(--studio-caption-12);
    color:           var(--studio-text-tertiary);
    font-variant-numeric: tabular-nums;
    white-space:     nowrap;
  }

  &__file-empty {
    padding: 14px;
    font:    var(--studio-caption-12);
    color:   var(--studio-text-tertiary);
  }

  &__note {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    padding:        var(--studio-space-12) 14px;
    border-top:     1px solid var(--studio-border-subtle);
    flex:           0 0 auto;
  }

  &__note-text {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__diff {
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

  &__diff-head {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       10px var(--studio-space-16);
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
  }

  &__code {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
    overflow:   auto;
    padding:    6px 0;

    :deep(> *) { flex: 1 1 auto; min-width: 0; }
  }

  &__loading {
    display:         flex;
    align-items:     center;
    justify-content: center;
    gap:             var(--studio-space-8);
    flex:            1 1 auto;
    color:           var(--studio-text-secondary);
    font:            var(--studio-body-14);
  }

  &__spin { animation: review-spin 0.9s linear infinite; }

  &__explain-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
    padding:        14px var(--studio-space-16);
  }

  &__explain-facts {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__fact {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__fact-label {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__fact-value {
    font:      var(--studio-body-13);
    color:     var(--studio-text);
    word-break: break-all;
  }

  &__actions {
    display:     flex;
    align-items: center;
    gap:         10px;
    padding:     var(--studio-space-12) var(--studio-space-20);
    border-top:  1px solid var(--studio-border);
    color:       var(--studio-text-tertiary);
    flex:        0 0 auto;
  }

  &__summary {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }
}

@keyframes review-spin {
  to { transform: rotate(360deg); }
}
</style>
