<script>
// Screen 04 · Review changes before publishing (Figma node 14:285).
//
// The gate in front of publishing: a list of what changed, the diff of whichever file is
// selected, and a rail explaining it. Three panels and an action bar.
//
// Real: the file list (git status in the pod), each file's diff, Discard all (checkout plus
// clean), Keep and continue building (back to the workspace), and Publish - which is the same
// publish the workspace's button runs.
//
// Placeholder: the explanation rail. The design has the assistant explain each change in prose
// beside its diff, and nothing produces that text - so the rail says what it would hold and
// offers the diff instead of inventing a rationale for code it did not write.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, SBanner
} from '../components/ui';
import DiffView from '../components/DiffView.vue';
import { toastNotYet, toastSuccess, toastError } from '../toast';
import {
  changedFiles, fileDiff, discardChanges, listBranches, DEFAULT_EXTENSION
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
      // The paths still ticked in the file list (14:395). Everything is kept until somebody
      // says otherwise, which is what makes the default row of the action bar honest.
      kept:     [],
    };
  },

  computed: {
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

    notYet(what) {
      toastNotYet(this.$store, what);
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
        @click="$router.push({ name: STUDIO_ROUTE })"
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
            The assistant does not yet write an explanation for each change. When it does, the
            reasoning for <strong>{{ selected || 'the selected file' }}</strong> appears here
            next to its diff.
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

          <SButton variant="ghost" size="sm" icon="book" @click="notYet('the change rationale')">
            Ask the assistant to explain
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
