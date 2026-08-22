<script>
// Screen 12 · Review a change — intent, diff and rendered result together (Figma node 38:1030).
//
// The screen the design is named after: three columns so a reviewer never has to hold two of
// them in their head at once. The packet on the left is what the change is for, the diff is in
// the middle, and the rendered result is on the right - the same live preview the author was
// looking at, so "does the diff do what the brief says" is one glance rather than two tabs.
//
// Real: the packet (the brief, read from the pod), the file list and every diff, the preview,
// and Request changes / Approve - which are a commit of the working tree either way, because
// on a single-reviewer Studio "approve" means "this is worth keeping" and that is a commit.
//
// Placeholder: the sign-off avatars and the PR chip. There is no second reviewer and no pull
// request until somebody publishes to GitHub, so neither has anything true to say yet.
import {
  SButton, SChip, SIcon, SEmpty, SBanner, SLabel
} from '../components/ui';
import DiffView from '../components/DiffView.vue';
import PreviewPanel from '../components/studio/PreviewPanel.vue';
import { toastNotYet, toastSuccess, toastError } from '../toast';
import {
  changedFiles, fileDiff, readExtensionFile, commitExtension, extensionUrl, extensionReady,
  DEFAULT_EXTENSION
} from '../extensions';
import { REVIEW_QUEUE_ROUTE, EDITOR_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// A markdown block as the paragraphs it is, rather than the lines it was typed as.
//
// Markdown's rule, and the one every editor that wrote one of these briefs assumes: a single
// newline inside a paragraph is whitespace, a blank line ends it. A list item is its own
// paragraph too, so a checklist stays a checklist instead of collapsing into one line.
function paragraphs(body) {
  const out = [];

  body.split('\n').forEach((raw) => {
    const line = raw.trim();
    const starts = !out.length || !line || /^([-*+]|\d+\.|>|#)\s/.test(line);

    if (starts || !out[out.length - 1]) {
      out.push(line);
    } else {
      out[out.length - 1] += ` ${ line }`;
    }
  });

  return out.filter(Boolean);
}

export default {
  name: 'BarnReviewChange',

  components: {
    SButton, SChip, SIcon, SEmpty, SBanner, SLabel, DiffView, PreviewPanel
  },

  mixins: [fullBleed],

  data() {
    return {
      files:    [],
      selected: '',
      patch:    '',
      brief:    '',
      previewUrl: '',
      loading:  true,
      diffing:  false,
      deciding: false,
    };
  },

  computed: {
    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    count() {
      return this.files.length;
    },

    risk() {
      if (!this.count) {
        return 'none';
      }

      return this.count > 8 ? 'high' : (this.count > 3 ? 'medium' : 'low');
    },

    riskTone() {
      return {
        high: 'error', medium: 'warning', low: 'success', none: 'default',
      }[this.risk];
    },

    /** The brief split into its `##` sections, so the packet can show them as fields. */
    briefSections() {
      if (!this.brief.trim()) {
        return [];
      }

      const out = [];
      let current = null;

      this.brief.split('\n').forEach((raw) => {
        const line = raw.trimEnd();
        const m = /^##\s+(.*)$/.exec(line.trim());

        if (m) {
          current = { title: m[1], body: [] };
          out.push(current);
        } else if (current && line.trim() !== '---') {
          // Blank lines are kept, because they are the only thing that says where one
          // paragraph ends and the next begins.
          current.body.push(line);
        }
      });

      return out
        .map((s) => ({ title: s.title, body: s.body.join('\n').trim() }))
        .filter((s) => s.body && s.body !== '_not stated_')
        // The body is a column of paragraphs (38:1136), not a column of source lines. A
        // sentence hard-wrapped in the file is one sentence; only a blank line, or the start
        // of a list item, begins a new one - otherwise a wrapped sentence renders as two
        // paragraphs with a gap down the middle of it.
        .map((s) => ({ title: s.title, lines: paragraphs(s.body) }));
    },
  },

  watch: {
    selected: 'loadDiff',
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;

      const [files, brief] = await Promise.all([
        changedFiles(this.extension).catch(() => []),
        readExtensionFile(this.extension, 'BRIEF.md').catch(() => ''),
      ]);

      this.files = files;
      this.brief = brief;
      this.loading = false;

      if (files.length) {
        this.selected = files[0].path;
      }

      // The preview is the same dev server the workspace frames. It may still be compiling,
      // which is why this waits rather than framing a connection-refused page.
      if (await extensionReady(this.extension).catch(() => false)) {
        this.previewUrl = extensionUrl(this.extension);
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

    /**
     * Approving is committing.
     *
     * On a Studio with one reviewer there is nobody to hand a decision to, so the decision has
     * to land somewhere in the tree or it is not a decision at all. A commit is that: it moves
     * the change out of "waiting on you" and gives it a message somebody can read later.
     */
    async approve() {
      this.deciding = true;

      try {
        const sha = await commitExtension(
          this.extension,
          `Reviewed: ${ this.count } file${ this.count === 1 ? '' : 's' }`
        );

        toastSuccess(this.$store, 'Approved', `Committed as ${ sha.trim().split('\n').pop() }.`);
        this.$router.push({ name: REVIEW_QUEUE_ROUTE });
      } catch (e) {
        toastError(this.$store, 'Could not commit the change', e?.message || String(e));
      } finally {
        this.deciding = false;
      }
    },

    requestChanges() {
      // Back to the assistant with the review still uncommitted, which is what "request
      // changes" means when the author and the reviewer are the same person.
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: this.extension } });
    },

    /** The line under the path (38:1184): what the change is, in the size it is. */
    fileStats(file) {
      const counts = [];

      if (file.added) {
        counts.push(`+${ file.added }`);
      }

      if (file.removed) {
        counts.push(`-${ file.removed }`);
      }

      return counts.length ? `${ file.status } · ${ counts.join(' ') }` : file.status;
    },

    notYet(what) {
      toastNotYet(this.$store, what);
    },
  },
};
</script>

<template>
  <div class="rc">
    <!-- review masthead (38:1101) -->
    <div class="rc__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back to the queue"
        @click="$router.push({ name: REVIEW_QUEUE_ROUTE })"
      />

      <div class="rc__name">
        <div class="rc__title">
          {{ extension }}
        </div>
        <div class="rc__eyebrow">
          Review a change
        </div>
      </div>

      <SChip :label="`${ risk } risk`" :tone="riskTone" />
      <SChip
        label="No pull request yet"
        icon="github"
        clickable
        @click="notYet('linking a review to a pull request')"
      />

      <span class="rc__grow" />

      <SChip :label="`Reviewing all ${ count } file${ count === 1 ? '' : 's' }`" tone="subtle" />
      <SButton variant="ghost" size="sm" icon="refresh" @click="load">
        Refresh
      </SButton>
    </div>

    <!-- body (38:1130) -->
    <div class="rc__body">
      <!-- review packet (38:1131) -->
      <div class="rc__packet">
        <div class="rc__panel-head">
          <SIcon name="book" :size="14" />
          <span class="rc__panel-title">The packet</span>
        </div>

        <div class="rc__packet-body">
          <template v-if="briefSections.length">
            <div v-for="s in briefSections" :key="s.title" class="rc__section">
              <SLabel :text="s.title" />
              <div class="rc__section-body">
                <p v-for="(line, i) in s.lines" :key="i" class="rc__section-line">
                  {{ line }}
                </p>
              </div>
            </div>
          </template>

          <SBanner v-else type="warning">
            This change has no brief. Nobody wrote down what it is for, so the only thing to
            review it against is the diff itself.
          </SBanner>

          <div class="rc__files">
            <SLabel :text="`Changed files (${ count })`" />
            <button
              v-for="f in files"
              :key="f.path"
              type="button"
              class="rc__file"
              :class="{ 'rc__file--selected': f.path === selected }"
              @click="selected = f.path"
            >
              <span class="rc__file-row">
                <SIcon name="file" :size="13" />
                <span class="rc__file-path">{{ f.path }}</span>
              </span>
              <span class="rc__file-stats">{{ fileStats(f) }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- diff (38:1236) -->
      <div class="rc__diff">
        <div class="rc__panel-head rc__panel-head--wide">
          <SIcon name="code" :size="14" />
          <span class="rc__panel-title">{{ selected || 'No file selected' }}</span>
        </div>

        <div class="rc__code">
          <SEmpty
            v-if="!count && !loading"
            icon="check"
            title="Nothing to review"
            message="This extension matches its last commit."
          />
          <div v-else-if="diffing" class="rc__loading">
            <SIcon name="spinner" :size="20" class="rc__spin" />
            Reading {{ selected }}
          </div>
          <DiffView v-else :patch="patch" />
        </div>
      </div>

      <!-- visual diff (38:1347): the rendered result, beside the code that made it -->
      <div class="rc__visual">
        <div class="rc__panel-head">
          <SIcon name="eye" :size="14" />
          <span class="rc__panel-title">Rendered result</span>
        </div>

        <PreviewPanel
          v-if="previewUrl"
          class="rc__preview"
          :url="previewUrl"
          :extension="extension"
        />
        <SEmpty
          v-else
          icon="monitor"
          title="The preview is not up"
          message="The extension's dev server is still compiling. The rendered result appears here once it answers."
        />
      </div>
    </div>

    <!-- decision bar (38:1426) -->
    <div class="rc__decision">
      <div class="rc__signoffs">
        <SIcon name="user" :size="15" />
        <span class="rc__signoff-text">
          You are the only reviewer on this Studio, so your decision is the decision.
        </span>
      </div>

      <span class="rc__grow" />

      <SButton variant="neutral" icon="undo" :disabled="!count" @click="requestChanges">
        Request changes
      </SButton>
      <SButton variant="neutral" icon="clock" @click="notYet('deferring a review')">
        Come back to it
      </SButton>
      <SButton
        variant="primary"
        icon="check"
        :disabled="!count"
        :loading="deciding"
        @click="approve"
      >
        Approve and commit
      </SButton>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.rc {
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

  &__body {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
  }

  &__packet {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-rail);
    min-width:      var(--studio-panel-rail-min);
    border-right:   1px solid var(--studio-border);
    min-height:     0;
  }

  &__visual {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-assistant);
    min-width:      var(--studio-panel-assistant-min);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
  }

  &__preview { flex: 1 1 auto; min-height: 0; }

  // The floor the two rails shrink for. Without it they hold their drawn widths and the diff
  // - the whole point of the screen - is what gives way.
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

  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-12) 14px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;

    &--wide { padding: var(--studio-space-10) var(--studio-space-16); }

    // The preview rail's head is the wider one (38:1348); the packet's is not.
    .rc__visual & { padding: var(--studio-space-12) var(--studio-space-16); }
  }

  &__panel-title {
    font:          var(--studio-heading-14);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // Figma has no wrapper here: under 38:1131 a section's head (38:1132, padding 12/16/8) and
  // its body (38:1136, padding 0/16/12) are siblings. Collapsing that into one padded column
  // means taking the head's 12 at the top, the body's 12 at the bottom, and the two of them
  // together - 24 - as the gap between sections.
  &__packet-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-24);
    padding:        var(--studio-space-12) var(--studio-space-16);
    overflow-y:     auto;
    min-height:     0;
  }

  // The 8px the head leaves under its label (38:1132 padding-bottom).
  &__section {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__section-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-6);
  }

  &__section-line {
    font:        var(--studio-body-13);
    color:       var(--studio-text);
    margin:      0;
    white-space: pre-wrap;
  }

  &__files {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    border-top:     1px solid var(--studio-border-subtle);
    padding-top:    var(--studio-space-12);
  }

  &__file {
    display:        flex;
    flex-direction: column;
    // Explicit, because the shell centres every button's contents and in a column that
    // centres them horizontally - a left-aligned path drawn down the middle of the row.
    align-items:    stretch;
    gap:            var(--studio-space-2);
    padding:        7px var(--studio-space-10);
    background:    none;
    border:        1px solid transparent;
    border-radius: var(--studio-radius-control);
    color:         var(--studio-text-secondary);
    cursor:        pointer;
    text-align:    left;

    &:hover { background: var(--studio-surface-subtle); }

    &--selected,
    &--selected:hover {
      background:   var(--studio-blue-050);
      border-color: var(--studio-info);
      color:        var(--studio-text);
    }
  }

  &__file-row {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    min-width:   0;
  }

  &__file-path {
    flex:          1 1 auto;
    min-width:     0;
    font:          var(--studio-body-13-semi);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__file-stats {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
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

  &__spin { animation: rc-spin 0.9s linear infinite; }

  &__decision {
    display:     flex;
    align-items: center;
    gap:         10px;
    padding:     var(--studio-space-12) var(--studio-space-20);
    border-top:  1px solid var(--studio-border);
    flex:        0 0 auto;
  }

  &__signoffs {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-16);
    color:       var(--studio-text-tertiary);
  }

  &__signoff-text {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }
}

@keyframes rc-spin {
  to { transform: rotate(360deg); }
}
</style>
