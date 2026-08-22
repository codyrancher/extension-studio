<script>
// Screen 05 · Files — history, tree and a readable editor (Figma node 22:784).
//
// Masthead, the workspace's tab strip, then three columns: the tree, the file, and a rail
// showing where the file is used.
//
// All three columns are real. The tree is the pod's actual package directory, the middle column
// is the file with its line numbers and its commit history, and "where used" is a grep for the
// file's basename across the package - not a symbol index, and it says so, but it finds the
// imports and the references and it finds them in the tree rather than guessing at them.
//
// Editing is the one thing this screen does not do. The file is shown read-only because the
// thing that edits files here is the assistant in the pod, and two writers on one tree with no
// locking between them is a way to lose work rather than a feature.
//
// The history under the file is not a list of labels either: picking a commit puts that
// commit's patch in the middle column, in the same DiffView the review screens use, with the
// file it replaced named on the way back.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, STabs, SLabel, SMenu
} from '../components/ui';
import FileTree from '../components/FileTree.vue';
import DiffView from '../components/DiffView.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  listExtensionFiles, readExtensionFile, listCommits, listBranches, countChanges,
  findUsages, showCommit, DEFAULT_EXTENSION
} from '../extensions';
import { EDITOR_ROUTE, STUDIO_ROUTE, REVIEW_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

/**
 * Turn a flat list of paths into the shape FileTree renders.
 *
 * `dirs` and `files` as separate arrays, not one `children` list - that is what the component
 * walks, and giving it `children` renders an empty tree with no error, which is exactly the
 * kind of bug that survives a build and a type-check.
 */
function toTree(paths) {
  const root = {
    name: '', path: '', dirs: [], files: [],
  };

  paths.forEach((path) => {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let node = root;
    let walked = '';

    parts.forEach((part) => {
      walked = walked ? `${ walked }/${ part }` : part;

      let next = node.dirs.find((dir) => dir.name === part);

      if (!next) {
        next = {
          name: part, path: walked, dirs: [], files: [],
        };
        node.dirs.push(next);
      }

      node = next;
    });

    if (fileName) {
      node.files.push({ name: fileName, path });
    }
  });

  const sort = (node) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.dirs.forEach(sort);
  };

  sort(root);

  return root;
}

export default {
  name: 'BarnFiles',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, STabs, SLabel, SMenu, FileTree, DiffView
  },

  mixins: [fullBleed],

  data() {
    return {
      tree:     {
        name: '', path: '', dirs: [], files: [],
      },
      current:  '',
      contents: '',
      commits:  [],
      usages:   [],
      branch:   '',
      changes:  0,
      loading:  true,
      reading:  false,
      searching: false,
      filter:   '',
      allPaths: [],
      // The commit the middle column is showing instead of the file, or null. Its patch is
      // held beside it rather than re-fetched on every render - `git show` is an exec into
      // the pod, and a computed would run it again on each keystroke in the filter box.
      commit:   null,
      patch:    '',
      loadingPatch: false,
    };
  },

  computed: {
    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    tabs() {
      return [
        { id: 'assistant', label: 'Assistant', icon: 'sparkle' },
        { id: 'files', label: 'Files', icon: 'file' },
        {
          id: 'changes', label: 'Changes', icon: 'compare', count: this.changes || null,
        },
        { id: 'terminal', label: 'Terminal', icon: 'terminal' },
      ];
    },

    lines() {
      return this.contents === '' ? [] : this.contents.replace(/\n$/, '').split('\n');
    },

    basename() {
      return this.current.split('/').pop() || '';
    },

    /**
     * The route names the template pushes to.
     *
     * A plain `<script>` block's module scope is not the render function's scope: the template
     * compiles to its own module and resolves every bare name off the component instance. So
     * `$router.push({ name: STUDIO_ROUTE })` written straight into the template pushed
     * `{ name: undefined }`, which the router drops on the floor without an error - the back
     * chevron, Review changes and Back to assistant all looked live and did nothing. Exposing
     * them here is what puts them in the template's scope.
     */
    routes() {
      return { STUDIO_ROUTE, REVIEW_ROUTE, EDITOR_ROUTE };
    },

    overflowMenu() {
      return [
        { id: 'refresh', label: 'Refresh the tree', icon: 'refresh' },
        {
          id:       'copy',
          label:    "Copy this file's path",
          icon:     'file',
          disabled: !this.current,
          note:     this.current ? '' : 'nothing open',
        },
        { divider: true },
        { id: 'workspace', label: 'Open the workspace', icon: 'sparkle' },
        {
          // Not disabled when there is nothing to review, unlike the same line on the
          // extension list: the button two along in this masthead goes to the same screen
          // unconditionally, and a menu that refuses what the button beside it allows reads
          // as a bug. The count says what is waiting there.
          id:    'review',
          label: 'Review changes',
          icon:  'compare',
          note:  this.changes ? `${ this.changes }` : 'nothing yet',
        },
      ];
    },
  },

  watch: {
    current: 'openCurrent',
    extension: 'load',

    filter(q) {
      const term = q.trim().toLowerCase();

      this.tree = toTree(term ? this.allPaths.filter((p) => p.toLowerCase().includes(term)) : this.allPaths);
    },
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

      const [paths, commits, branches, changes] = await Promise.all([
        listExtensionFiles(this.extension).catch(() => []),
        listCommits(this.extension, 20).catch(() => []),
        listBranches(this.extension).catch(() => null),
        countChanges(this.extension).catch(() => 0),
      ]);

      this.allPaths = paths;
      this.tree = toTree(paths);
      this.commits = commits;
      this.branch = branches?.current || '';
      this.changes = changes;
      this.loading = false;

      if (!this.current && paths.length) {
        // Open something worth looking at rather than whatever sorts first.
        this.current = paths.find((p) => p.endsWith('index.ts')) || paths[0];
      }
    },

    async openCurrent() {
      // Picking a file is the way back out of a commit, as well as the way into a file.
      this.commit = null;
      this.patch = '';

      if (!this.current) {
        this.contents = '';
        this.usages = [];

        return;
      }

      this.reading = true;
      this.contents = await readExtensionFile(this.extension, this.current).catch(() => '');
      this.reading = false;

      this.searching = true;
      this.usages = (await findUsages(this.extension, this.basename).catch(() => []))
        .filter((u) => u.path !== this.current);
      this.searching = false;
    },

    /**
     * Show one commit's patch where the file was.
     *
     * In the middle column rather than a dialog: the tree stays where it is, the history stays
     * under it, and picking another commit swaps the diff without anything having to be
     * dismissed first. The file is one click back, named on the button.
     */
    async openCommit(c) {
      this.commit = c;
      this.patch = '';
      this.loadingPatch = true;
      // `git show` writes its errors to the same stream as the patch, and DiffView renders
      // anything that is not a patch as no files at all - so a failure here is a diff with
      // nothing in it rather than an exception, and the empty state below says so.
      this.patch = await showCommit(this.extension, c.sha).catch(() => '');
      this.loadingPatch = false;
    },

    backToFile() {
      this.commit = null;
      this.patch = '';
    },

    /**
     * What the masthead's overflow menu does.
     *
     * Four things this screen can actually do. Copying goes through the async clipboard API,
     * which a browser can refuse - over plain HTTP, or without the permission - so the result
     * is reported either way rather than assumed.
     */
    async onOverflow(id) {
      if (id === 'refresh') {
        await this.load();
        toastSuccess(this.$store, `Re-read the file tree for ${ this.extension }.`);

        return;
      }

      if (id === 'copy') {
        try {
          await navigator.clipboard.writeText(this.current);
          toastSuccess(this.$store, `Copied ${ this.current }`);
        } catch (e) {
          toastError(this.$store, `The browser would not let this page write to the clipboard: ${ e.message || e }`);
        }

        return;
      }

      this.$router.push({
        name:   id === 'review' ? REVIEW_ROUTE : EDITOR_ROUTE,
        params: { extension: this.extension },
      });
    },

    onTab(tab) {
      if (tab === 'files') {
        return;
      }

      if (tab === 'changes') {
        this.$router.push({ name: REVIEW_ROUTE, params: { extension: this.extension } });

        return;
      }

      this.$router.push({
        name:   EDITOR_ROUTE,
        params: { extension: this.extension },
        query:  { tab },
      });
    },
  },
};
</script>

<template>
  <div class="files">
    <!-- workspace masthead (22:855) -->
    <div class="files__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back"
        @click="$router.push({ name: routes.STUDIO_ROUTE })"
      />

      <div class="files__name">
        <div class="files__title">
          {{ extension }}
        </div>
        <div class="files__eyebrow">
          Files
        </div>
      </div>

      <SBadge :status="changes ? 'unsaved' : 'live'" />
      <SChip v-if="branch" :label="branch" icon="branch" />

      <span class="files__grow" />

      <SButton
        variant="secondary"
        size="sm"
        icon="compare"
        @click="$router.push({ name: routes.REVIEW_ROUTE, params: { extension } })"
      >
        Review changes
      </SButton>
      <SButton
        variant="primary"
        size="sm"
        icon="sparkle"
        @click="$router.push({ name: routes.EDITOR_ROUTE, params: { extension } })"
      >
        Back to assistant
      </SButton>
      <SMenu :items="overflowMenu" aria-label="More file actions" @select="onOverflow" />
    </div>

    <!-- panel tabs (22:892) -->
    <STabs :tabs="tabs" variant="panel" model-value="files" @select="onTab" />

    <!-- body (22:926) -->
    <div class="files__body">
      <!-- tree column (22:927) -->
      <div class="files__tree">
        <div class="files__panel-head">
          <SIcon name="folder" :size="14" />
          <span class="files__panel-title">Files</span>
        </div>

        <div class="files__search">
          <SIcon name="search" :size="13" />
          <input
            v-model="filter"
            class="files__search-input"
            placeholder="Filter"
            aria-label="Filter files"
          >
        </div>

        <div class="files__tree-scroll">
          <!--
            The root's children, not the root. FileTree draws a node as a folder button with
            its own name, and the root has no name - rendering it puts an empty, nameless
            folder row above the tree with everything nested one level inside it.
          -->
          <FileTree
            v-for="dir in tree.dirs"
            :key="dir.path"
            :node="dir"
            :current="current"
            @select="current = $event"
          />
          <button
            v-for="file in tree.files"
            :key="file.path"
            type="button"
            class="files__loose"
            :class="{ 'files__loose--current': file.path === current }"
            @click="current = file.path"
          >
            {{ file.name }}
          </button>

          <div
            v-if="!loading && !tree.dirs.length && !tree.files.length"
            class="files__muted files__pad"
          >
            No files match.
          </div>
        </div>
      </div>

      <!-- editor (22:1053) -->
      <div class="files__editor">
        <!--
          One head, two subjects. The class stays put in both states because it is the panel's
          own box; what changes is what the panel is a panel of.
        -->
        <div class="files__panel-head files__panel-head--wide">
          <SIcon :name="commit ? 'compare' : 'file'" :size="14" />

          <template v-if="commit">
            <code class="files__sha">{{ commit.sha }}</code>
            <span class="files__panel-title">{{ commit.subject }}</span>
            <span class="files__grow" />
            <span class="files__muted">{{ commit.who }} · {{ commit.when }}</span>
            <SButton
              variant="secondary"
              size="sm"
              icon="chevronLeft"
              @click="backToFile"
            >
              Back to {{ basename || 'the file' }}
            </SButton>
          </template>

          <template v-else>
            <span class="files__panel-title">{{ current || 'No file open' }}</span>
            <span class="files__grow" />
            <span class="files__muted">{{ lines.length }} lines</span>
            <SButton
              variant="ghost"
              size="sm"
              icon="refresh"
              icon-only
              title="Re-read this file"
              @click="openCurrent"
            />
          </template>
        </div>

        <div class="files__code">
          <div v-if="loadingPatch" class="files__loading">
            <SIcon name="spinner" :size="20" class="files__spin" />
            Reading {{ commit.sha }}
          </div>

          <SEmpty
            v-else-if="commit && !patch.trim()"
            icon="alert"
            title="No patch for this commit"
            :message="`git show ${ commit.sha } came back with nothing. A merge with no changes of its own reads like this, and so does a pod that has stopped answering.`"
          />

          <DiffView
            v-else-if="commit"
            :patch="patch"
            :subject="commit.subject"
          />

          <SEmpty
            v-else-if="!current && !loading"
            icon="file"
            title="Nothing open"
            message="Pick a file from the tree."
          />

          <div v-else-if="reading" class="files__loading">
            <SIcon name="spinner" :size="20" class="files__spin" />
            Reading {{ current }}
          </div>

          <table v-else class="files__lines">
            <tbody>
              <tr v-for="(line, i) in lines" :key="i">
                <td class="files__ln">{{ i + 1 }}</td>
                <td class="files__code-line">{{ line }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- history, under the file it is the history of -->
        <div class="files__history">
          <div class="files__panel-head files__panel-head--tight">
            <SIcon name="clock" :size="14" />
            <span class="files__panel-title">History</span>
            <span class="files__grow" />
            <span class="files__muted">{{ commits.length }} commits</span>
          </div>
          <div class="files__commits">
            <div
              v-for="c in commits"
              :key="c.sha"
              class="files__commit"
              :class="{ 'files__commit--current': commit && commit.sha === c.sha }"
              @click="openCommit(c)"
            >
              <code class="files__sha">{{ c.sha }}</code>
              <span class="files__commit-subject">{{ c.subject }}</span>
              <span class="files__muted">{{ c.when }}</span>
            </div>
            <div v-if="!commits.length && !loading" class="files__muted files__pad">
              No commits yet.
            </div>
          </div>
        </div>
      </div>

      <!-- where used (22:1150) -->
      <div class="files__used">
        <div class="files__panel-head">
          <SIcon name="search" :size="14" />
          <span class="files__panel-title">Where used</span>
        </div>

        <div class="files__used-body">
          <SLabel :text="basename ? `References to ${ basename }` : 'No file open'" />

          <div v-if="searching" class="files__muted">
            Searching the package…
          </div>

          <template v-else>
            <div
              v-for="(u, i) in usages"
              :key="i"
              class="files__usage"
              @click="current = u.path"
            >
              <span class="files__usage-path">{{ u.path }}:{{ u.line }}</span>
              <code class="files__usage-text">{{ u.text }}</code>
            </div>

            <div v-if="!usages.length && current" class="files__muted">
              Nothing else in this package mentions {{ basename }}.
            </div>
          </template>

          <p class="files__note">
            A fixed-string search of the package, not a symbol index — it finds imports and
            string references, and will miss anything renamed on the way in.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.files {
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

  &__tree {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-tree);
    min-width:      var(--studio-panel-tree-min);
    border-right:   1px solid var(--studio-border);
    min-height:     0;
  }

  &__used {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-rail);
    min-width:      var(--studio-panel-rail-min);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
    overflow-y:     auto;
  }

  &__editor {
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

    &--wide  {
      padding: var(--studio-space-10) var(--studio-space-16);
      gap:     var(--studio-space-10);
    }
    &--tight { padding: var(--studio-space-8) var(--studio-space-16); }
  }

  &__panel-title {
    font:          var(--studio-heading-14);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__search {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    margin:        var(--studio-space-8) 10px;
    padding:       5px 9px;
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);
    color:         var(--studio-text-tertiary);

    &:focus-within { border-color: var(--studio-border-focus); }
  }

  &__search-input {
    flex:       1 1 auto;
    min-width:  0;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    font:       var(--studio-caption-12);
    color:      var(--studio-text);
  }

  // A file that sits at the root of the package, with no folder above it.
  &__loose {
    display:       block;
    width:         100%;
    // The same box FileTree gives a row, down to the 6px on the left: these are siblings of
    // the root folders in one list, and 8px put them 2px off the pitch every other row in the
    // scroller keeps. 22:1015 (CLAUDE.md) and 22:1027 (package.json) are this row in the
    // frame - loose files at the root of the package - and they are 5px 8px 5px 6px, the same
    // layout the root folder 22:972 uses.
    padding:       5px var(--studio-space-8) 5px var(--studio-space-6);
    text-align:    left;
    background:    none;
    border:        none;
    // The shell gives every button a 40px minimum for touch targets, which turns the design's
    // 26px tree row into a scroll. FileTree's rows clear it the same way.
    min-height:    0;
    border-radius: var(--studio-radius-control);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-link);
    cursor:        pointer;

    &:hover { background: var(--studio-surface-subtle); }

    &--current,
    &--current:hover {
      background: var(--studio-blue-050);
      color:      var(--studio-text);
    }
  }

  &__tree-scroll {
    flex:           1 1 auto;
    min-height:     0;
    overflow:       auto;
    display:        flex;
    flex-direction: column;
    gap:            1px;
    padding:        var(--studio-space-10) var(--studio-space-6) var(--studio-space-12);

    // A scroller's children keep their own height; letting them shrink to fit would
    // collapse the tree instead of scrolling it.
    > * { flex: 0 0 auto; }
  }

  &__code {
    flex:       1 1 auto;
    min-height: 0;
    overflow:   auto;
    display:    flex;
    padding:    var(--studio-space-8) 0;

    :deep(> *) { flex: 1 1 auto; }
  }

  &__lines {
    width:           100%;
    border-collapse: collapse;
    font:            var(--studio-mono-12);

    // The table is a flex item, so the default cross-axis stretch grew it to the
    // scroller's height and the rows shared out the slack - a 22px line rendering 42px
    // tall. Its height is the sum of its rows; nothing else.
    align-self:      flex-start;
  }

  &__ln {
    width:         1%;
    padding:       var(--studio-space-2) var(--studio-space-10) var(--studio-space-2) var(--studio-space-16);
    text-align:    right;
    color:         var(--studio-text-tertiary);
    user-select:   none;
    vertical-align: top;
    white-space:   nowrap;
  }

  &__code-line {
    padding:     var(--studio-space-2) var(--studio-space-16) var(--studio-space-2) 0;
    color:       var(--studio-text);
    white-space: pre-wrap;
    word-break:  break-word;
  }

  &__history {
    flex:       0 0 auto;
    max-height: 40%;
    display:    flex;
    flex-direction: column;
    border-top: 1px solid var(--studio-border);
    min-height: 0;
  }

  &__commits {
    overflow-y: auto;
    min-height: 0;
  }

  &__commit {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       var(--studio-space-8) var(--studio-space-16);
    border-bottom: 1px solid var(--studio-border-subtle);
    cursor:        pointer;

    &:hover { background: var(--studio-surface-subtle); }

    // Which commit the middle column is showing. Without it, the diff up there belongs to
    // whichever row you last clicked and nothing on the page says which one that was.
    &--current,
    &--current:hover { background: var(--studio-blue-050); }
  }

  &__sha {
    font:  var(--studio-mono-12);
    color: var(--studio-text-link);
  }

  &__commit-subject {
    flex:          1 1 auto;
    min-width:     0;
    font:          var(--studio-caption-12);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__used-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    padding:        var(--studio-space-12) 14px;
  }

  &__usage {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    padding:        var(--studio-space-8) 10px;
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border-subtle);
    border-radius:  var(--studio-radius-control);
    cursor:         pointer;

    &:hover { border-color: var(--studio-border-strong); }
  }

  &__usage-path {
    font:  var(--studio-caption-12);
    color: var(--studio-text-link);
    word-break: break-all;
  }

  &__usage-text {
    font:          var(--studio-mono-12);
    color:         var(--studio-text-secondary);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__muted {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__pad { padding: var(--studio-space-12) 14px; }

  &__note {
    font:       var(--studio-caption-12);
    color:      var(--studio-text-tertiary);
    margin:     var(--studio-space-4) 0 0;
    border-top: 1px solid var(--studio-border-subtle);
    padding-top: var(--studio-space-8);
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

  &__spin { animation: files-spin 0.9s linear infinite; }
}

@keyframes files-spin {
  to { transform: rotate(360deg); }
}
</style>
