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
import {
  SButton, SBadge, SChip, SIcon, SEmpty, STabs, SLabel
} from '../components/ui';
import FileTree from '../components/FileTree.vue';
import { toastNotYet } from '../toast';
import {
  listExtensionFiles, readExtensionFile, listCommits, listBranches, countChanges,
  findUsages, DEFAULT_EXTENSION
} from '../extensions';
import { EDITOR_ROUTE, STUDIO_ROUTE, REVIEW_ROUTE } from '../editor-product';
import '../design/tokens';

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
    SButton, SBadge, SChip, SIcon, SEmpty, STabs, SLabel, FileTree
  },

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

    notYet(what) {
      toastNotYet(this.$store, what);
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
        @click="$router.push({ name: STUDIO_ROUTE })"
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
        @click="$router.push({ name: REVIEW_ROUTE, params: { extension } })"
      >
        Review changes
      </SButton>
      <SButton
        variant="primary"
        size="sm"
        icon="sparkle"
        @click="$router.push({ name: EDITOR_ROUTE, params: { extension } })"
      >
        Back to assistant
      </SButton>
      <SButton
        variant="ghost"
        size="sm"
        icon="more"
        icon-only
        aria-label="More"
        @click="notYet('the files overflow menu')"
      />
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
        <div class="files__panel-head files__panel-head--wide">
          <SIcon name="file" :size="14" />
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
        </div>

        <div class="files__code">
          <SEmpty
            v-if="!current && !loading"
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
              @click="notYet('opening a commit from here')"
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
    width:          var(--studio-panel-tree);
    flex:           0 0 var(--studio-panel-tree);
    border-right:   1px solid var(--studio-border);
    min-height:     0;
  }

  &__used {
    display:        flex;
    flex-direction: column;
    width:          var(--studio-panel-rail);
    flex:           0 0 var(--studio-panel-rail);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
    overflow-y:     auto;
  }

  &__editor {
    display:        flex;
    flex-direction: column;
    flex:           1 1 auto;
    min-width:      0;
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

    &--wide  { padding: 10px var(--studio-space-16); }
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
    padding:       3px var(--studio-space-8);
    text-align:    left;
    background:    none;
    border:        none;
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
    flex:       1 1 auto;
    min-height: 0;
    overflow:   auto;
    padding:    0 var(--studio-space-4) var(--studio-space-8);
  }

  &__code {
    flex:       1 1 auto;
    min-height: 0;
    overflow:   auto;
    display:    flex;

    :deep(> *) { flex: 1 1 auto; }
  }

  &__lines {
    width:           100%;
    border-collapse: collapse;
    font:            var(--studio-mono-12);
  }

  &__ln {
    width:         1%;
    padding:       0 10px 0 var(--studio-space-16);
    text-align:    right;
    color:         var(--studio-text-tertiary);
    user-select:   none;
    vertical-align: top;
    white-space:   nowrap;
  }

  &__code-line {
    padding:     0 var(--studio-space-16) 0 0;
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
