<script>
// Screen 12 · Review a change — intent, diff and rendered result together (Figma node 38:1030).
//
// The screen the design is named after: three columns so a reviewer never has to hold two of
// them in their head at once. The packet on the left is what the change is for, the diff is in
// the middle, and the rendered result is on the right - the same live preview the author was
// looking at, so "does the diff do what the brief says" is one glance rather than two tabs.
//
// Real: the packet (the brief, read from the pod), the file list - grouped by directory, the
// way the design has it (38:1177, 38:1190, 38:1203) - and every diff, the preview, the pull
// request chip, and Request changes / Approve, which are a commit of the working tree either
// way, because on a single-reviewer Studio "approve" means "this is worth keeping" and that is
// a commit.
//
// The PR chip is a real reading. With a token and a repository it asks GitHub whether an open
// pull request has this extension's branch as its head, and says so either way; without one of
// them it names the one that is missing rather than showing a number nobody can click. There is
// still no second reviewer, so the sign-off line says that in words instead of drawing avatars
// for people who do not exist.
import {
  SButton, SChip, SIcon, SEmpty, SBanner, SLabel
} from '../components/ui';
import DiffView from '../components/DiffView.vue';
import EditorSettingsModal from '../components/EditorSettingsModal.vue';
import PreviewPanel from '../components/studio/PreviewPanel.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  changedFiles, fileDiff, readExtensionFile, commitExtension, extensionUrl, extensionReady,
  listBranches, readSettings, extensionSource, parseGithubSource, findOpenPullRequest,
  deferReview, clearDeferral, DEFAULT_EXTENSION
} from '../extensions';
import { REVIEW_QUEUE_ROUTE, EDITOR_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// A markdown block as the paragraphs it is, rather than the lines it was typed as.
//
// Markdown's rule, and the one every editor that wrote one of these briefs assumes: a single
// newline inside a paragraph is whitespace, a blank line ends it. A list item is its own
// paragraph too, so a checklist stays a checklist instead of collapsing into one line.
//
// Joining takes two decisions, not one, and this used to take only the first. Asking whether a
// line *opens* a block says whether it may be joined *onto* something; whether the line before
// it *closed* one says whether there is anything to join onto. Without the second question a
// heading swallowed the line under it, a `###` subheading was absorbed into the list item above
// it, the four sentences of a verification block ran together, and a fenced code block or a
// table came out as one line with its rows spliced end to end.
//
// A heading, a table row and a fence line all close: whatever follows starts fresh. Prose does
// not, which is what keeps a hard-wrapped sentence one sentence.
const OPENS = /^([-*+]\s|\d+\.\s|>|#{1,6}\s|\|)/;
const CLOSES = /^(#{1,6}\s|\|)/;
const FENCE = /^(```|~~~)/;

function paragraphs(body) {
  const out = [];
  // The marker of the fence we are inside, '' when we are not. Inside one, every line is its
  // own line: it is code, and joining two lines of code changes what it says.
  let fence = '';
  let closed = true;
  let hardBreak = false;

  body.split('\n').forEach((raw) => {
    // trimEnd, not trim. Leading whitespace is a nested list's indentation and the indentation
    // is what says it is nested; the trailing whitespace is read for the hard break below and
    // then dropped, because a paragraph break carries it from here on.
    const line = raw.trimEnd();
    const bare = line.trim();
    const fenced = FENCE.test(bare);

    if (fence) {
      out.push(line);
      fence = fenced && bare.startsWith(fence) ? '' : fence;

      return;
    }

    if (fenced) {
      fence = FENCE.exec(bare)[1];
      out.push(line);
      closed = true;

      return;
    }

    if (!bare) {
      closed = true;
      hardBreak = false;

      return;
    }

    if (OPENS.test(bare) || closed || !out.length) {
      out.push(line);
    } else {
      // Two trailing spaces are markdown's hard line break, so the wrap was deliberate and the
      // two lines join with the newline they were written with rather than a space.
      out[out.length - 1] += `${ hardBreak ? '\n' : ' ' }${ bare }`;
    }

    closed = CLOSES.test(bare);
    hardBreak = /\s{2}$/.test(raw);
  });

  return out;
}

export default {
  name: 'BarnReviewChange',

  components: {
    SButton, SChip, SIcon, SEmpty, SBanner, SLabel, DiffView, PreviewPanel, EditorSettingsModal
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
      deciding:  false,
      deferring: false,
      // What the masthead's GitHub chip knows. `state` is the whole of it:
      //   checking  - the question is out
      //   open      - there is one, and `pr` is it
      //   none      - asked and answered: no open PR has this branch as its head
      //   no-token  - nothing was asked, because there is no token to ask with
      //   no-repo   - nothing was asked, because no repository is known for this extension
      //   error     - the question failed, and `prError` says how
      pr:       null,
      prState:  'checking',
      prError:  '',
      repo:     '',
      branch:   '',
      showSettings: false,
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
      return { REVIEW_QUEUE_ROUTE };
    },

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

    /**
     * The changed files under a heading per directory (38:1177, 38:1190, 38:1203).
     *
     * A flat list of thirty paths is thirty prefixes a reviewer reads and discards; grouped, the
     * prefix is read once and the rows underneath are file names. The count per group is the
     * other half of it - "components 6" is the sentence "most of this change is in components",
     * which is the first thing anybody wants to know about a diff they did not write.
     *
     * Groups are ordered by path so the tree reads top-down the way the file browser does, and
     * a file at the package root goes under its own heading rather than into a group called ''.
     */
    fileGroups() {
      const groups = new Map();

      this.files.forEach((file) => {
        const cut = file.path.lastIndexOf('/');
        const dir = cut < 0 ? '.' : file.path.slice(0, cut);
        const name = cut < 0 ? file.path : file.path.slice(cut + 1);

        groups.set(dir, [...(groups.get(dir) || []), { ...file, name }]);
      });

      return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, files]) => ({
          dir,
          // '.' is not a directory anybody typed, so the heading says what it means.
          label: dir === '.' ? 'the package root' : dir,
          files: [...files].sort((a, b) => a.name.localeCompare(b.name)),
        }));
    },

    /**
     * What the masthead's GitHub chip says, and what pressing it does.
     *
     * One computed rather than six conditionals in the template, because the states differ in
     * all three of label, tone and action, and the point of the chip is that it never says the
     * same thing for two different reasons.
     */
    prChip() {
      const chips = {
        checking: { label: 'Checking GitHub…', tone: 'subtle', action: '' },
        open:     {
          label: `PR #${ this.pr?.number } open`, tone: 'success', action: 'open',
        },
        none: {
          label: `No open PR for ${ this.branch || 'this branch' }`, tone: 'default', action: 'list',
        },
        'no-token': { label: 'No GitHub token', tone: 'warning', action: 'settings' },
        'no-repo':  { label: 'No GitHub repository', tone: 'warning', action: '' },
        error:      { label: 'Could not ask GitHub', tone: 'error', action: 'retry' },
      };

      return chips[this.prState] || chips.checking;
    },

    /** The hover text: the whole fact, where the chip only has room for the headline. */
    prTitle() {
      return {
        checking: `Asking GitHub whether ${ this.repo } has an open pull request for ${ this.branch }`,
        open:     `${ this.pr?.title } — opens on GitHub`,
        none:     `${ this.repo } has no open pull request whose head branch is ${ this.branch }. Opens the repository's pull requests.`,
        'no-token': 'No GitHub token is configured, so nothing can be asked. Opens the editor settings.',
        'no-repo':  `No GitHub repository is remembered for ${ this.extension }. Publishing it to GitHub records one.`,
        error:      this.prError,
      }[this.prState] || '';
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
      // A freshly created extension has no repository yet, and every reading on this screen
      // is a git reading - so without this the screen is simply empty, with nothing saying
      // why. Memoised and idempotent, so this costs one exec the first time and nothing after.
      await ensureRepo(this.extension).catch(() => {});

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

      this.checkPullRequest();

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

        // Answering is the end of the deferral, and the toast on "Come back to it" promises
        // exactly that. Failing to clear it would leave a permanent "Deferred" mark on a
        // change that has been decided.
        await clearDeferral(this.extension).catch(() => {});
        toastSuccess(this.$store, 'Approved', `Committed as ${ sha.trim().split('\n').pop() }.`);
        this.$router.push({ name: REVIEW_QUEUE_ROUTE });
      } catch (e) {
        toastError(this.$store, 'Could not commit the change', e?.message || String(e));
      } finally {
        this.deciding = false;
      }
    },

    requestChanges() {
      // Also an answer, so it also ends the deferral.
      clearDeferral(this.extension).catch(() => {});
      // Back to the assistant with the review still uncommitted, which is what "request
      // changes" means when the author and the reviewer are the same person.
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: this.extension } });
    },

    /**
     * Whether an open pull request already exists for what is being reviewed.
     *
     * Three readings, in the order that lets it stop early: the branch (the head a PR would have
     * to point at), the token (there is no anonymous way to ask about a private repository), and
     * the repository - the one remembered when this extension was last published, or the one it
     * was imported from, because an imported extension knows where it came from before anybody
     * has published it anywhere.
     */
    async checkPullRequest() {
      this.prState = 'checking';
      this.pr = null;
      this.prError = '';

      const [branches, settings, source] = await Promise.all([
        listBranches(this.extension).catch(() => null),
        readSettings(this.extension).catch(() => ({ hasToken: false, repo: '' })),
        extensionSource(this.extension).catch(() => ''),
      ]);

      this.branch = branches?.current || '';
      this.repo = settings.repo || parseGithubSource(source)?.repo || '';

      if (!settings.hasToken) {
        this.prState = 'no-token';

        return;
      }

      if (!this.repo) {
        this.prState = 'no-repo';

        return;
      }

      try {
        this.pr = await findOpenPullRequest(this.extension, this.repo, this.branch);
        this.prState = this.pr ? 'open' : 'none';
      } catch (e) {
        this.prError = e?.message || String(e);
        this.prState = 'error';
      }
    },

    /** The chip's press, which is a different thing in each state - see `prChip`. */
    onPrChip() {
      const action = this.prChip.action;

      if (action === 'open' && this.pr) {
        window.open(this.pr.url, '_blank', 'noopener');
      } else if (action === 'list') {
        window.open(`https://github.com/${ this.repo }/pulls`, '_blank', 'noopener');
      } else if (action === 'settings') {
        this.showSettings = true;
      } else if (action === 'retry') {
        toastError(this.$store, this.prError, { title: 'GitHub did not answer' });
        this.checkPullRequest();
      }
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

    /**
     * Defer the review, and say so on the queue.
     *
     * Not the same as the back button, which is what this used to be worth. Deferring records
     * that somebody has looked and chosen not to decide, so the queue can mark the row and
     * stop it reading as untouched - the difference between "nobody has been here" and "I am
     * not ready", which is the distinction the queue exists to make.
     */
    async comeBackToIt() {
      this.deferring = true;

      try {
        await deferReview(this.extension, `${ this.count } file${ this.count === 1 ? '' : 's' } unreviewed`);
        toastSuccess(
          this.$store,
          'Come back to it',
          `${ this.extension } is marked as deferred on the review queue. Answering it clears the mark.`
        );
        this.$router.push({ name: this.routes.REVIEW_QUEUE_ROUTE });
      } catch (e) {
        toastError(this.$store, 'Could not defer this review', e?.message || String(e));
      } finally {
        this.deferring = false;
      }
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
        @click="$router.push({ name: routes.REVIEW_QUEUE_ROUTE })"
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
        :label="prChip.label"
        :tone="prChip.tone"
        :title="prTitle"
        icon="github"
        :clickable="!!prChip.action"
        @click="onPrChip"
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

            <!-- one heading per directory (38:1177, 38:1190, 38:1203) -->
            <div v-for="g in fileGroups" :key="g.dir" class="rc__group">
              <div class="rc__group-head">
                <SIcon name="folder" :size="12" />
                <span class="rc__group-path">{{ g.label }}</span>
                <span class="rc__group-count">{{ g.files.length }}</span>
              </div>

              <button
                v-for="f in g.files"
                :key="f.path"
                type="button"
                class="rc__file"
                :class="{ 'rc__file--selected': f.path === selected }"
                :title="f.path"
                @click="selected = f.path"
              >
                <span class="rc__file-row">
                  <SIcon name="file" :size="13" />
                  <span class="rc__file-path">{{ f.name }}</span>
                </span>
                <span class="rc__file-stats">{{ fileStats(f) }}</span>
              </button>
            </div>
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
      <SButton
        variant="neutral"
        icon="clock"
        :loading="deferring"
        @click="comeBackToIt"
      >
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

    <!-- the token the PR chip needs, asked for where it was found to be missing -->
    <EditorSettingsModal
      v-if="showSettings"
      @close="showSettings = false"
      @saved="checkPullRequest"
    />
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

  // The directory heading and the rows under it (38:1177). Indented rather than boxed: the
  // heading is what says where these files are, so the indent is the only thing that has to
  // keep saying it.
  &__group {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
  }

  &__group-head {
    display:     flex;
    align-items: center;
    gap:         6px;
    padding:     var(--studio-space-6) var(--studio-space-10) var(--studio-space-2);
    color:       var(--studio-text-tertiary);
  }

  &__group-path {
    flex:          1 1 auto;
    min-width:     0;
    font:          var(--studio-caption-12-semi);
    color:         var(--studio-text-secondary);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    direction:     rtl;
    text-align:    left;
  }

  &__group-count {
    flex:          0 0 auto;
    padding:       0 var(--studio-space-6);
    border-radius: var(--studio-radius-pill);
    background:    var(--studio-neutral-bg);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
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

    // Under a heading the row is a file name, so it is indented to the heading's icon.
    .rc__group & { margin-left: var(--studio-space-10); }
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
