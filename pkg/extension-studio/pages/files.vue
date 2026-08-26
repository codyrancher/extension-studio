<script>
// Screen 05 · Files - history, tree and a readable editor (Figma node 22:784).
//
// Masthead, the workspace's tab strip, then three columns: the tree, the file, and a rail
// showing where the file is used.
//
// All three columns are real. The tree is the pod's actual package directory, the middle column
// is the file with its line numbers and its commit history, and "where used" is a grep for the
// file's basename across the package - not a symbol index, and it says so, but it finds the
// imports and the references and it finds them in the tree rather than guessing at them.
//
// Editing used to be the one thing this screen did not do, on the argument that the assistant
// in the pod is the other writer and two writers on one tree lose work. The designer's caption
// for the screen is the opposite ("Replaces: the read-only Files tab"), and the argument was
// answerable rather than decisive: Edit re-reads the file from the pod at the moment you press
// Save and refuses to overwrite a copy that changed underneath you. So the pane is read-only
// until you say otherwise, and a conflict is reported instead of resolved silently.
//
// The history under the file is not a list of labels either: picking a commit puts that
// commit's patch in the middle column, in the same DiffView the review screens use, with the
// file it replaced named on the way back. It is also not just `git log`: an automatic snapshot
// is a commit hung off HEAD rather than an ancestor of it, so a log walk cannot see one, and
// half of what happened to the tree was missing from the list until listHistory merged them.
// Above the commits sits the working tree itself, which is the one entry in the history that
// has not happened yet.
//
// The rail's other half is where the open file *surfaces*: `routing/index.ts` says which
// component each route renders, so for a page component this screen can name the route, frame
// the running page at it, and open it in a tab. A file that renders no page says that rather
// than showing the extension's home page and implying it is the file's.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, STabs, SLabel, SMenu, SModal
} from '../components/ui';
import FileTree from '../components/FileTree.vue';
import DiffView from '../components/DiffView.vue';
import { toastSuccess, toastError } from '../toast';
import {
  ensureRepo,
  listExtensionFiles, readExtensionFile, writeExtensionFile, listHistory, listBranches,
  checkoutBranch, countChanges, changedFiles, discardChanges, workingDiff, askAssistant,
  findUsages, showCommit, fileProvenance, extensionUrl, createSnapshot, runInPackage,
  DEFAULT_EXTENSION
} from '../extensions';
import { highlight } from '../highlight';
import { routesFromSource } from '../extension-routes';
import {
  EDITOR_ROUTE, STUDIO_ROUTE, REVIEW_ROUTE, STUDIO_PAGE_ACTIONS, handleStudioPageAction
} from '../editor-product';
import pageActionsMixin from '@shell/mixins/page-actions';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

/** How the tree can be ordered. Both orders are read from the pod, neither is a guess. */
const TREE_SORTS = [
  {
    id: 'name', label: 'Name', icon: 'list', note: 'folders first, then A to Z',
  },
  {
    id: 'changed', label: 'Changed first', icon: 'compare', note: 'uncommitted files at the top',
  },
];

/**
 * What a tree badge says, per `changedFiles` status (22:1000 "new", 22:1013 "edited").
 *
 * `changedFiles` reads against the last published baseline rather than against HEAD, so these
 * mark every file that differs from what this Rancher is running - which is the set the review
 * screens are about, and is what the badge's title says out loud.
 *
 * `deleted` needs the listing's help to appear at all. The tree is a `find` in the pod, and a
 * file that has been deleted is not there to be found, so until `gonePaths` put those paths
 * back into the listing this entry marked rows that could not exist and the badge was dead
 * code. The deleted paths come from git rather than from the filesystem for exactly that
 * reason: git is the only reader that still knows the file was ever there.
 */
const MARKS = {
  added: 'new', deleted: 'gone', modified: 'edited',
};

/**
 * A string as base64, in the single quotes the pod's shell needs around it.
 *
 * `btoa` cannot take anything above U+00FF and a source file is full of characters that are, so
 * the text is encoded to UTF-8 bytes first - the same two steps `writeExtensionFile` takes, for
 * the same reason. Nothing in the base64 alphabet means anything to a shell, so the quotes are
 * the whole of the escaping.
 */
function podBase64(text) {
  const bytes = new TextEncoder().encode(text || '');
  let binary = '';

  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });

  return `'${ btoa(binary) }'`;
}

/** Where the tree's order is kept, so it is the same order the next time you open the screen. */
const SORT_KEY = 'barn.files.sort';

function readSort() {
  try {
    const saved = window.localStorage.getItem(SORT_KEY);

    return TREE_SORTS.some((each) => each.id === saved) ? saved : 'name';
  } catch (e) {
    return 'name';
  }
}

function writeSort(id) {
  try {
    window.localStorage.setItem(SORT_KEY, id);
  } catch (e) {
    // Storage turned off keeps the choice for this session and loses it on reload, which is
    // not worth telling anybody about.
  }
}

/**
 * Turn a flat list of paths into the shape FileTree renders.
 *
 * `dirs` and `files` as separate arrays, not one `children` list - that is what the component
 * walks, and giving it `children` renders an empty tree with no error, which is exactly the
 * kind of bug that survives a build and a type-check.
 */
function toTree(paths, marks = {}, order = 'name') {
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

  // "Changed first" is a real reading rather than a second alphabet: it is `git status` joined
  // onto the listing, so the rows that move to the top are the rows the review screen is about.
  // A folder counts as changed when anything under it is, or a changed file three levels down
  // would sort its parent to the bottom and be no easier to find than it was.
  const changed = (node) => node.files.some((f) => marks[f.path]) || node.dirs.some(changed);

  const sort = (node) => {
    node.dirs.sort((a, b) => (order === 'changed' ? (changed(b) - changed(a)) : 0) ||
      a.name.localeCompare(b.name));
    node.files.sort((a, b) => (order === 'changed' ? (!!marks[b.path] - !!marks[a.path]) : 0) ||
      a.name.localeCompare(b.name));
    node.dirs.forEach(sort);
  };

  sort(root);

  return root;
}


export default {
  name: 'BarnFiles',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, STabs, SLabel, SMenu, SModal, FileTree, DiffView
  },

  mixins: [fullBleed, pageActionsMixin],

  data() {
    return {
      tree:     {
        name: '', path: '', dirs: [], files: [],
      },
      current:  '',
      contents: '',
      history:  [],
      usages:   [],
      // What git knows about the open file: who last committed it, how long ago, and whether
      // what is on disk is that commit. Read per file rather than derived from the tree
      // listing, because the tree listing is a `find` and knows none of it.
      provenance: {
        who: '', when: '', state: 'unknown',
      },
      branch:   '',
      changes:  0,
      loading:  true,
      reading:  false,
      searching: false,
      filter:   '',
      allPaths: [],
      // The paths git reports as deleted against the baseline. Kept apart from `allPaths`,
      // which is what the pod's `find` returned: these are the files that are *not* there, and
      // everything that opens or writes a file has to know the difference.
      gonePaths: [],
      // The commit the middle column is showing instead of the file, or null. Its patch is
      // held beside it rather than re-fetched on every render - `git show` is an exec into
      // the pod, and a computed would run it again on each keystroke in the filter box.
      commit:   null,
      patch:    '',
      loadingPatch: false,
      // `git status`, keyed by path: 'new' for a file git has never seen, 'edited' for one it
      // has. What puts the badges on the tree, and what "Changed first" sorts on.
      marks:    {},
      // Every branch in the pod's repository, and whether the switcher is mid-checkout.
      branches: [],
      switching: false,
      sort:     readSort(),
      // Editing. `draft` is what is in the textarea; `editedFrom` is the copy of the file the
      // edit started against, which is what Save compares the pod's current copy to before it
      // writes over it.
      editing:  false,
      draft:    '',
      editedFrom: '',
      savingFile: false,
      conflict: '',
      // What Save found on disk when it refused to write, and the diff between that and the
      // draft. Both are held so the conflict has a way out that keeps the draft: the banner can
      // show what the other writer did, hand the draft to the clipboard, or write it over the
      // pod's copy after snapshotting what it replaces.
      conflictDisk: '',
      conflictPatch: '',
      showConflict: false,
      conflictBusy: '',
      // The uncommitted diff, shown where the file was when the top history row is picked.
      working:  false,
      workingPatch: '',
      confirmRevert: false,
      confirmPublish: false,
      asking:   false,
      // Every route the extension registers, and which file renders it, read out of
      // routing/index.ts and product.ts in the pod.
      routeTable: [],
      // Whether the framed miniature has been asked for. The rail does not load an iframe of a
      // whole dashboard until somebody has said they want to see it.
      showThumb: false,
    };
  },

  computed: {
    /**
     * What Rancher's header kebab offers here (Figma 53:1802).
     *
     * Distinct from this screen's own masthead kebab (22:888), which acts on the extension.
     * This is the one in Rancher's top bar, and barn does not draw it: Rancher's
     * `HeaderPageActionMenu` is already there and shows itself whenever the mounted page has
     * committed a non-empty `pageActions`. Screens 01, 02, 03 and 11 commit them and get the
     * kebab; this screen committed none, which is the whole reason it had none. Read by
     * @shell/mixins/page-actions, which commits on `created` and clears on `beforeUnmount`,
     * so the menu is this page's rather than every page in Rancher's. The list lives in
     * editor-product.ts; see the note there for why those three and nothing invented.
     */
    pageActions() {
      return STUDIO_PAGE_ACTIONS;
    },

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

    /**
     * The same lines, as coloured runs.
     *
     * One entry per line, in step with `lines`, so the gutter and the code cannot drift apart.
     * The tokenising is done here rather than in the template because it walks the whole file
     * and a template expression would re-run it on every keystroke in the filter box.
     */
    highlighted() {
      return highlight(this.contents, this.current);
    },

    /**
     * What the editor header says about the open file besides its name.
     *
     * Every part is read from the pod. A file git has never seen says so instead of borrowing
     * the last commit's author, which is the failure mode this replaced: the line used to be
     * the line count alone, and the design asks for who, when and whether it is committed.
     */
    provenanceLine() {
      const parts = [];
      const { who, when, state } = this.provenance;

      if (who && when) {
        parts.push(`Last commit by ${ who }, ${ when }`);
      }

      parts.push(`${ this.lines.length } lines`);

      const said = {
        committed: 'committed',
        modified:  'uncommitted changes',
        new:       'never committed',
        deleted:   'missing from disk',
      }[state];

      if (said) {
        parts.push(said);
      }

      return parts.join(' · ');
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

    sortOptions() {
      // The chosen order is marked rather than removed, so the menu is the same two lines each
      // time and the current order is readable without closing it.
      return TREE_SORTS.map((each) => ({
        ...each,
        note: each.id === this.sort ? `${ each.note } · current` : each.note,
      }));
    },

    sortLabel() {
      return (TREE_SORTS.find((each) => each.id === this.sort) || TREE_SORTS[0]).label;
    },

    /**
     * The branches, as a menu.
     *
     * The one that is checked out is marked and disabled: picking it would be a checkout to
     * where you already are, which reads as a control that did nothing.
     */
    branchMenu() {
      if (!this.branches.length) {
        return [{
          id: '', label: 'No branches yet', disabled: true, note: 'nothing committed',
        }];
      }

      return this.branches.map((name) => ({
        id:       name,
        label:    name,
        icon:     'branch',
        disabled: name === this.branch,
        note:     name === this.branch ? 'checked out' : '',
      }));
    },

    /**
     * What the branch row can honestly say under the branch name.
     *
     * The design's line is "up to date with origin". This Studio's repositories are created in
     * the pod and have no remote unless something pushed one, and nothing this screen can call
     * reports ahead/behind against an upstream - so it says how many branches are in the pod
     * rather than a sync state nobody measured. See the note in the return message: this wants
     * a `branchSync()` reading in extensions.ts.
     */
    branchNote() {
      if (!this.branches.length) {
        return 'no commits yet';
      }

      const n = this.branches.length;

      return `${ n } branch${ n === 1 ? '' : 'es' } in the pod · sync with origin is not read here`;
    },

    /** 'new' | 'edited' | 'deleted' | undefined, for the file the middle column is showing. */
    currentMark() {
      return this.marks[this.current];
    },

    /**
     * Where the open file surfaces in the UI (23:905), or nothing.
     *
     * Matched on the path the extension's own routing table names, so a page component gets its
     * route and everything else gets an honest silence rather than the extension's home page
     * dressed up as this file's.
     */
    surface() {
      return this.routeTable.find((r) => r.file === this.current) || null;
    },

    /**
     * The running app the open file is part of, on the pod's dev server.
     *
     * The extension's own route is *not* appended, and that is a limit rather than an
     * oversight: the dev server has no history fallback, so it answers 200 for `/` and 404 for
     * every route the app itself owns. Verified against the running pod - `/proxy/` is 200,
     * `/proxy/base/c/local/home` is 404 - so a deep link would open a 404 page and blame the
     * file for it. The route is named beside the frame instead, where it is a true statement
     * about the file rather than a link that does not work.
     */
    previewUrl() {
      return this.surface ? extensionUrl(this.extension) : '';
    },

    /** The route the open file is mounted at, with the cluster this Studio runs in filled in. */
    surfaceRoute() {
      return this.surface ? this.surface.path.replace(/:cluster/g, 'local') : '';
    },

    /**
     * The history, with the working tree on top of it (22:941).
     *
     * The uncommitted work is the newest thing that happened to this package and the only entry
     * in the list that is not a commit, so it is a row of its own rather than a badge on the
     * first commit. It appears only when there is something in it.
     */
    historyRows() {
      if (!this.changes) {
        return this.history;
      }

      return [{
        ref:     'working',
        kind:    'working',
        subject: 'Working changes',
        when:    'now',
        who:     '',
      }, ...this.history];
    },

    /**
     * Every path the tree lists: the files in the pod, plus the ones git says were deleted.
     *
     * Sorted and de-duplicated, so a deleted file sits where it used to sit rather than at the
     * end of its folder, and a path that is somehow in both lists is one row.
     */
    listedPaths() {
      const gone = this.gonePaths.filter((p) => !this.allPaths.includes(p));

      return gone.length ? [...this.allPaths, ...gone].sort() : this.allPaths;
    },

    /** Whether the open file is one git says is deleted, so there is nothing on disk to read. */
    currentGone() {
      return this.currentMark === 'gone';
    },

    /** Whether the open file has something to throw away, or something to put back. */
    canRevert() {
      return !!this.current && ['new', 'edited', 'gone'].includes(this.currentMark);
    },
  },

  watch: {
    current: 'openCurrent',
    extension: 'load',

    filter: 'rebuildTree',
    sort:   'rebuildTree',

    /** A comparison is of one draft. Type into it and the one on screen is of the old one. */
    draft() {
      if (this.conflictPatch) {
        this.conflictPatch = '';
        this.showConflict = false;
      }
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    /** One of the header kebab's items was chosen. Dispatched here by the same mixin. */
    handlePageAction(action) {
      handleStudioPageAction(this, action);
    },

    async load() {
      // A freshly created extension has no repository yet, and every reading on this screen
      // is a git reading - so without this the screen is simply empty, with nothing saying
      // why. Memoised and idempotent, so this costs one exec the first time and nothing after.
      await ensureRepo(this.extension).catch(() => {});

      this.loading = true;

      const [paths, history, branches, changes, changed, routing, product] = await Promise.all([
        listExtensionFiles(this.extension).catch(() => []),
        listHistory(this.extension, 20).catch(() => []),
        listBranches(this.extension).catch(() => null),
        countChanges(this.extension).catch(() => 0),
        // `git status`, which the tree listing is a `find` and knows nothing about. This is
        // what puts "new" and "edited" on the rows the assistant just touched.
        changedFiles(this.extension).catch(() => []),
        readExtensionFile(this.extension, 'routing/index.ts').catch(() => ''),
        readExtensionFile(this.extension, 'product.ts').catch(() => ''),
      ]);

      this.allPaths = paths;
      this.marks = changed.reduce((out, f) => ({ ...out, [f.path]: MARKS[f.status] || 'edited' }), {});
      // A deleted file has no row in a listing built from `find`, so the "gone" badge could
      // never render. These are the paths git says are missing, and the tree is built from the
      // union of the two, so a file the assistant deleted is visible and revertible instead of
      // silently absent.
      this.gonePaths = changed.filter((f) => f.status === 'deleted').map((f) => f.path);
      this.history = history;
      this.branch = branches?.current || '';
      this.branches = branches?.branches || [];
      this.changes = changes;
      this.routeTable = routesFromSource(routing, product);
      this.rebuildTree();
      this.loading = false;

      if (!this.current && paths.length) {
        // `?file=` is how another screen says which file it meant - the brief's prior-art card
        // sends somebody here to read the line its search found. Only when the path is really
        // in the tree, so a stale link opens the package rather than an empty pane.
        const asked = this.$route.query.file;

        this.current = (asked && paths.includes(asked) ? asked : '') ||
          paths.find((p) => p.endsWith('index.ts')) || paths[0];
      }
    },

    /** The tree the filter and the order between them produce, from one listing. */
    rebuildTree() {
      const term = this.filter.trim().toLowerCase();
      const listed = this.listedPaths;
      const paths = term ? listed.filter((p) => p.toLowerCase().includes(term)) : listed;

      this.tree = toTree(paths, this.marks, this.sort);
    },

    async openCurrent() {
      // Picking a file is the way back out of a commit, of the working diff, and of an edit,
      // as well as the way into a file.
      this.commit = null;
      this.patch = '';
      this.working = false;
      this.workingPatch = '';
      this.editing = false;
      this.clearConflict();
      this.showThumb = false;

      if (!this.current) {
        this.contents = '';
        this.usages = [];
        this.provenance = {
          who: '', when: '', state: 'unknown',
        };

        return;
      }

      this.reading = true;
      // Both halves of the middle column in one wait: the contents the pane renders and the
      // provenance its header states. They are two execs, but they are two the reader would
      // otherwise sit through one after the other.
      const [contents, provenance] = await Promise.all([
        readExtensionFile(this.extension, this.current).catch(() => ''),
        fileProvenance(this.extension, this.current).catch(() => ({
          who: '', when: '', state: 'unknown',
        })),
      ]);

      this.contents = contents;
      this.provenance = provenance;
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
      //
      // `ref` rather than a sha, because half these rows are snapshots and a snapshot is
      // reached by its tag. `git show` takes either.
      this.patch = await showCommit(this.extension, c.ref).catch(() => '');
      this.loadingPatch = false;
    },

    /** How a history row names its source: uncommitted work, an automatic snapshot, or a person. */
    entrySource(c) {
      if (c.kind === 'working') {
        return `${ this.changes } file${ this.changes === 1 ? '' : 's' } not yet committed`;
      }

      return c.kind === 'snapshot' ? 'automatic' : (c.who || 'unknown author');
    },

    /**
     * Why a "where used" row matters, read off the line that matched.
     *
     * The search is a fixed-string grep, so what comes back is a line rather than a relation -
     * and a rail of raw grep hits makes the reader do the parsing. These are the shapes that
     * line actually takes in a Rancher extension, and anything that is none of them says
     * "mentions it" rather than inventing a relationship the line does not show.
     */
    usageReason(u) {
      const text = u.text || '';
      // Only the part of the name that can be a component tag, and only used when there is
      // something left of it - an empty stem would build `<\s*/?\s*\b`, which matches the
      // opening angle bracket of every tag in the file.
      const stem = this.basename.replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '');

      if (/^\s*import\s/.test(text) || /^\s*}?\s*from\s+['"]/.test(text)) {
        return 'imports it';
      }

      if (/^\s*export\s.*\bfrom\b/.test(text)) {
        return 're-exports it';
      }

      if (/\brequire\s*\(/.test(text)) {
        return 'requires it at runtime';
      }

      if (stem && new RegExp(`<\\s*/?\\s*${ stem }\\b`).test(text)) {
        return 'renders it as a component';
      }

      if (/\bcomponent\s*:/.test(text)) {
        return 'points a route at it';
      }

      if (/^\s*components\s*:/.test(text)) {
        return 'registers it as a component';
      }

      if (/^\s*\|/.test(text)) {
        return 'describes it in a table';
      }

      if (/^\s*(\/\/|#|\*|<!--)/.test(text)) {
        return 'mentions it in a comment';
      }

      if (u.path.endsWith('.md')) {
        return 'documents it';
      }

      return 'mentions it';
    },

    backToFile() {
      this.commit = null;
      this.patch = '';
      this.working = false;
      this.workingPatch = '';
    },

    /**
     * Show the uncommitted work where the file was (22:941).
     *
     * The same DiffView the commits use, from the same column, so the newest thing that
     * happened to the package reads the same way as everything that happened before it.
     */
    async openWorking() {
      this.commit = null;
      this.patch = '';
      this.working = true;
      this.workingPatch = '';
      this.loadingPatch = true;
      this.workingPatch = await workingDiff(this.extension).catch(() => '');
      this.loadingPatch = false;
    },

    openHistory(entry) {
      return entry.kind === 'working' ? this.openWorking() : this.openCommit(entry);
    },

    chooseSort(id) {
      this.sort = id;
      writeSort(id);
    },

    /**
     * Switch branch, and reload everything that was a reading of the old one.
     *
     * Every column on this screen is a reading of one branch - the tree, the file, its history
     * and where it is used - so a checkout reloads all of them rather than leaving three of
     * them describing a branch nobody is on.
     */
    async chooseBranch(name) {
      if (!name || name === this.branch || this.switching) {
        return;
      }

      this.switching = true;

      try {
        const out = await checkoutBranch(this.extension, name);

        // `git checkout` writes its refusals to the same stream as its progress, so a tree with
        // local changes that would be overwritten comes back as text rather than as a throw.
        if (/^error:|^fatal:/m.test(out)) {
          throw new Error(out.split('\n').filter(Boolean)[0]);
        }

        await this.load();
        await this.openCurrent();
        toastSuccess(this.$store, `Now on ${ name }.`, { title: 'Switched branch' });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: `Could not switch to ${ name }` });
      } finally {
        this.switching = false;
      }
    },

    /**
     * Make the pane editable.
     *
     * The copy the edit starts from is kept beside the draft, because the assistant in the pod
     * is writing to the same tree: Save compares it against what is on disk at that moment and
     * refuses rather than overwriting somebody else's work. That is the whole answer to the
     * objection this screen used to be read-only for.
     */
    startEditing() {
      this.draft = this.contents;
      this.editedFrom = this.contents;
      this.clearConflict();
      this.editing = true;
    },

    cancelEditing() {
      this.editing = false;
      this.draft = '';
      this.clearConflict();
    },

    /** Forget a conflict and everything held for resolving it. */
    clearConflict() {
      this.conflict = '';
      this.conflictDisk = '';
      this.conflictPatch = '';
      this.showConflict = false;
      this.conflictBusy = '';
    },

    async saveFile() {
      if (!this.editing || this.savingFile) {
        return;
      }

      this.savingFile = true;
      this.clearConflict();

      try {
        const onDisk = await readExtensionFile(this.extension, this.current);

        if (onDisk !== this.editedFrom) {
          // The copy that was found, kept: it is half of the comparison the banner offers, and
          // it is also what the draft would be written over if the reader decides theirs wins.
          this.conflictDisk = onDisk;
          this.conflict = 'The file changed in the pod while you were editing it, so this was not saved.';

          return;
        }

        await this.writeDraft();
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: `Could not save ${ this.current }` });
      } finally {
        this.savingFile = false;
      }
    },

    /** The write itself, and everything that is out of date once it lands. */
    async writeDraft() {
      await writeExtensionFile(this.extension, this.current, this.draft);
      this.editing = false;
      this.contents = this.draft;
      this.clearConflict();
      toastSuccess(this.$store, `Saved ${ this.current } into the pod.`);
      // The badge, the counts and the provenance line are all now out of date.
      await this.load();
      await this.refreshProvenance();
    },

    /**
     * Show what the other writer did, as a diff against the draft.
     *
     * Computed by the pod's own `diff`, over two files in `/tmp` that are removed in the same
     * command that reads them, rather than by a differ written here: the pod is where both
     * versions can be put side by side without touching the package, and a temporary file
     * inside the package would show up in the very `git status` this screen renders.
     *
     * The draft is untouched by all of this. It is still in `draft`, and the textarea comes
     * back with it when the comparison is closed.
     */
    async compareConflict() {
      if (this.showConflict) {
        this.showConflict = false;

        return;
      }

      if (this.conflictPatch) {
        this.showConflict = true;

        return;
      }

      this.conflictBusy = 'compare';

      try {
        const id = `${ Date.now() }-${ Math.floor(Math.random() * 1e6) }`;
        const dir = `/tmp/barn-files-conflict-${ id }`;
        const script = [
          `d=${ dir }`,
          'mkdir -p "$d"',
          `printf %s ${ podBase64(this.conflictDisk) } | base64 -d > "$d/pod"`,
          `printf %s ${ podBase64(this.draft) } | base64 -d > "$d/draft"`,
          'diff -u -L pod-copy -L your-draft "$d/pod" "$d/draft"',
          'rm -rf "$d"',
        ].join(' ; ');

        const out = await runInPackage(this.extension, script);

        if (!out.trim()) {
          // Two writers, one answer: what is on disk is already what was typed, so there is
          // nothing to resolve and Save can be let through.
          this.editedFrom = this.conflictDisk;
          this.conflict = 'The pod\'s copy now matches your draft, so there is nothing to merge. Save writes it.';
          this.conflictPatch = '';

          return;
        }

        // DiffView reads files out of a patch by their `diff --git` line, and `diff -u` does not
        // write one. The header is added here so the pane names the file rather than /tmp.
        this.conflictPatch = `diff --git a/${ this.current } b/${ this.current }\n${ out }`;
        this.showConflict = true;
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: 'Could not compare the two copies' });
      } finally {
        this.conflictBusy = '';
      }
    },

    /**
     * Put the draft on the clipboard, so discarding it is a choice rather than a loss.
     *
     * `writeText` needs a secure context and a permission the dashboard usually has; the
     * fallback is the old one that always works, and either way the growl says which happened.
     */
    async copyDraft() {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(this.draft);
        } else {
          const area = document.createElement('textarea');

          area.value = this.draft;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
        }

        toastSuccess(this.$store, `Your draft of ${ this.current } is on the clipboard.`);
      } catch (e) {
        toastError(this.$store, 'The browser would not give this page the clipboard. Select the text in the editor and copy it.', { title: 'Nothing was copied' });
      }
    },

    /**
     * Write the draft over the copy that changed underneath it.
     *
     * The pod's copy is snapshotted first, and that is what makes this offerable at all: the
     * snapshot is a commit of the whole working tree hung off HEAD, it appears in the history
     * list under this pane, and its patch opens in the same column - so the work being written
     * over is recoverable rather than gone. Without it this button would be the data loss the
     * conflict check exists to prevent.
     */
    async keepMyVersion() {
      if (this.conflictBusy) {
        return;
      }

      this.conflictBusy = 'keep';

      try {
        // The label is the basename: `createSnapshot` strips anything that is not a word, a
        // space, a dot or a dash out of it, so a path would arrive with its slashes gone.
        await createSnapshot(this.extension, `before overwriting ${ this.basename }`);
        this.editedFrom = this.conflictDisk;
        await this.writeDraft();
        toastSuccess(this.$store, 'The copy you wrote over was snapshotted first, and is in the history under this file.', { title: 'Snapshot taken' });
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: `Could not save ${ this.current }` });
      } finally {
        this.conflictBusy = '';
      }
    },

    /** Give up the draft and read the pod's copy back into the pane. */
    discardDraft() {
      this.draft = '';
      this.editing = false;
      this.clearConflict();
      this.openCurrent();
    },

    /** Re-read only what the header says, after a write that did not change which file is open. */
    async refreshProvenance() {
      this.provenance = await fileProvenance(this.extension, this.current).catch(() => ({
        who: '', when: '', state: 'unknown',
      }));
    },

    /**
     * Throw away one file's uncommitted work (22:1072).
     *
     * `discardChanges` with a single path, which restores a tracked file to the last commit and
     * removes one git has never seen - so for a new file this deletes it, which is what the
     * confirmation says before anybody presses it.
     */
    async revertFile() {
      this.confirmRevert = false;

      const path = this.current;
      const wasNew = this.currentMark === 'new';
      const wasGone = this.currentMark === 'gone';

      try {
        await discardChanges(this.extension, [path]);
        await this.load();

        // What to say is decided after the reading, not before it, because for a deleted file
        // the reading is the only thing that knows whether it worked. `discardChanges` restores
        // from the last commit, and the marks are measured against the last published version -
        // so a deletion that has been committed since that version is marked "gone" and has
        // nothing to check out. Saying "restored" in that case would be the screen lying about
        // a file it can see is still missing.
        let said = `Reverted ${ path } to the last commit.`;

        if (wasNew) {
          said = `Removed ${ path }.`;
        } else if (wasGone) {
          said = `Restored ${ path } from the last commit.`;
        }

        if (wasGone && !this.allPaths.includes(path)) {
          toastError(
            this.$store,
            `The deletion of ${ path } is already committed, so there was nothing in the working tree to put back. The commit that still has it is in the history under the file.`,
            { title: `${ path } was not restored` }
          );
        } else {
          toastSuccess(this.$store, said);
        }

        // A file that was never committed is gone from the tree, so the pane has to move.
        // Setting `current` is enough - the watcher on it re-reads the column - and calling
        // openCurrent as well would read the same file twice. A deletion that could not be
        // undone still has a row, so the pane stays on it and shows the empty state rather
        // than jumping somewhere the reader did not ask for.
        if (wasNew && !this.allPaths.includes(path)) {
          this.current = this.allPaths[0] || '';
        } else {
          await this.openCurrent();
        }
      } catch (e) {
        toastError(this.$store, e?.message || String(e), { title: `Could not revert ${ path }` });
      }
    },

    /**
     * Hand the open file to the assistant (22:1061).
     *
     * Same shape as the review screen's: the question goes into the one conversation this
     * extension has, so it arrives with everything that session already knows, and the answer
     * is somewhere a person can argue with it. Which means going there, so the toast names the
     * file before the route changes.
     */
    async askAboutFile() {
      if (!this.current || this.asking) {
        return;
      }

      const path = this.current;

      this.asking = true;

      try {
        const how = await askAssistant(this.extension, [
          `Read ${ path } in this package and explain it to somebody who has not seen it:`,
          'what it is for, what depends on it, and anything in it that looks wrong.',
          'Do not change any files yet.',
        ].join(' '));

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

    /** The running extension this file is part of, in a tab of its own (22:1178). */
    openLivePreview() {
      if (!this.previewUrl) {
        return;
      }

      window.open(this.previewUrl, '_blank', 'noopener');
    },

    /**
     * Publish from this masthead (22:881).
     *
     * Asked first, and then handed to the workspace exactly as screen 04 hands it: `local` is
     * the word `publishTo` takes, the workspace owns the status strip that reports the build,
     * and a second implementation of the same three steps here would be a second thing to keep
     * right. Publishing points this Rancher at the result, so it is not a button to press by
     * accident.
     */
    startPublish() {
      this.confirmPublish = false;
      this.$router.push({
        name:   EDITOR_ROUTE,
        params: { extension: this.extension },
        query:  { publish: 'local' },
      });
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

      <!--
        The count is the label, not a decoration beside it (22:873, "Review 3 changes"). It is
        the same `changes` the badge two elements back reads, so a button that says a number
        the badge disagrees with is not a state this can get into.
      -->
      <SButton
        variant="secondary"
        size="sm"
        icon="compare"
        data-testid="files-review-changes"
        @click="$router.push({ name: routes.REVIEW_ROUTE, params: { extension } })"
      >
        {{ changes ? `Review ${ changes } change${ changes === 1 ? '' : 's' }` : 'Review changes' }}
      </SButton>
      <SButton
        variant="secondary"
        size="sm"
        icon="sparkle"
        @click="$router.push({ name: routes.EDITOR_ROUTE, params: { extension } })"
      >
        Back to assistant
      </SButton>
      <!--
        22:881: the primary in this masthead is Publish, not the way back to the workspace.
        Disabled with nothing to publish, because a build of a tree that matches what this
        Rancher is already running is several minutes for no change.
      -->
      <SButton
        variant="primary"
        size="sm"
        icon="rocket"
        data-testid="files-publish"
        :disabled="!changes"
        :title="changes ? '' : 'Nothing has changed since the last commit'"
        @click="confirmPublish = true"
      >
        Publish
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
          <span class="files__grow" />
          <!-- 56:1114: the sort glyph at the right of the section heading. -->
          <SMenu
            :items="sortOptions"
            icon="filter"
            :aria-label="`Order the tree (${ sortLabel })`"
            @select="chooseSort"
          />
        </div>

        <!--
          22:928: the branch, and what it can honestly say about itself underneath. Switching
          reloads every column, because every column is a reading of one branch.
        -->
        <SMenu
          :items="branchMenu"
          align="left"
          class="files__branch"
          aria-label="Switch branch"
          @select="chooseBranch"
        >
          <template #trigger>
            <SIcon name="branch" :size="14" />
            <span class="files__branch-name" data-testid="files-branch">{{ branch || 'no branch' }}</span>
            <span class="files__branch-note">{{ branchNote }}</span>
            <SIcon :name="switching ? 'spinner' : 'chevronDown'" :size="12" />
          </template>
        </SMenu>

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
            :marks="marks"
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
            <span class="files__loose-name">{{ file.name }}</span>
            <span
              v-if="marks[file.path]"
              class="files__mark"
              :class="`files__mark--${ marks[file.path] }`"
              title="Different from what this Rancher is running"
            >{{ marks[file.path] }}</span>
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
          <SIcon :name="commit || working ? 'compare' : 'file'" :size="14" />

          <template v-if="working">
            <code class="files__sha">working</code>
            <span class="files__panel-title">Working changes</span>
            <span class="files__grow" />
            <span class="files__muted">{{ changes }} file{{ changes === 1 ? '' : 's' }} not yet committed · now</span>
            <SButton
              variant="secondary"
              size="sm"
              icon="compare"
              @click="$router.push({ name: routes.REVIEW_ROUTE, params: { extension } })"
            >
              Review them
            </SButton>
            <SButton
              variant="ghost"
              size="sm"
              icon="chevronLeft"
              @click="backToFile"
            >
              Back to {{ basename || 'the file' }}
            </SButton>
          </template>

          <template v-else-if="commit">
            <code class="files__sha">{{ commit.kind === 'snapshot' ? 'snapshot' : commit.ref }}</code>
            <span class="files__panel-title">{{ commit.subject }}</span>
            <span class="files__grow" />
            <span class="files__muted">{{ entrySource(commit) }} · {{ commit.when }}</span>
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
            <span v-if="current" class="files__muted" data-testid="files-provenance">
              {{ provenanceLine }}
            </span>

            <template v-if="current && editing">
              <SButton
                variant="ghost"
                size="sm"
                :disabled="savingFile"
                @click="cancelEditing"
              >
                Cancel
              </SButton>
              <SButton
                variant="primary"
                size="sm"
                icon="save"
                data-testid="files-save"
                :loading="savingFile"
                :disabled="draft === contents"
                @click="saveFile"
              >
                Save
              </SButton>
            </template>

            <template v-else-if="current">
              <!-- 22:1061 -->
              <SButton
                variant="secondary"
                size="sm"
                icon="sparkle"
                data-testid="files-ask-about-file"
                :loading="asking"
                @click="askAboutFile"
              >
                Ask about this file
              </SButton>
              <!-- 22:1067. Not offered for a file that is not there: an edit would write it
                   back with whatever the pane last held, which is not an edit but a restore
                   with the wrong contents. Revert is the control for that. -->
              <SButton
                v-if="!currentGone"
                variant="neutral"
                size="sm"
                icon="code"
                data-testid="files-edit"
                @click="startEditing"
              >
                Edit
              </SButton>
              <!-- 22:1072. Only offered when there is something to throw away. -->
              <SButton
                v-if="canRevert"
                variant="ghost"
                size="sm"
                icon="undo"
                data-testid="files-revert"
                @click="confirmRevert = true"
              >
                Revert
              </SButton>
            </template>

            <!--
              Disabled mid-edit, because re-reading throws the draft away and a one-click
              icon is no place to do that. The way out of an edit is Cancel, and the way out
              of a conflict is the banner in the pane, which keeps the draft.
            -->
            <SButton
              variant="ghost"
              size="sm"
              icon="refresh"
              icon-only
              :title="editing ? 'Re-read this file: finish or cancel the edit first' : 'Re-read this file'"
              :disabled="editing"
              @click="openCurrent"
            />
          </template>
        </div>

        <div class="files__code">
          <div v-if="loadingPatch" class="files__loading">
            <SIcon name="spinner" :size="20" class="files__spin" />
            Reading {{ working ? 'the working tree' : commit.ref }}
          </div>

          <SEmpty
            v-else-if="working && !workingPatch.trim()"
            icon="check"
            title="Nothing uncommitted"
            message="Every file in the package matches the last commit."
          />

          <DiffView
            v-else-if="working"
            :patch="workingPatch"
            subject="Working changes"
          />

          <SEmpty
            v-else-if="commit && !patch.trim()"
            icon="alert"
            title="No patch for this commit"
            :message="`git show ${ commit.ref } came back with nothing. A merge with no changes of its own reads like this, and so does a pod that has stopped answering.`"
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

          <!--
            A file in the tree that is not on disk. It is listed because git still knows it was
            there, and this is the pane saying why there is nothing to read rather than
            rendering an empty file and letting somebody conclude the pod lost it.
          -->
          <SEmpty
            v-else-if="currentGone"
            icon="trash"
            title="Deleted in the working tree"
            data-testid="files-gone"
            :message="`${ current } is in the last published version and is not in the pod any more, so there is nothing to read. Revert puts it back from that version; the working diff in the history below shows it going.`"
          />

          <!--
            The editable pane (22:1067). A textarea rather than a code editor: the highlighting
            beside it is a tokeniser over a string, not an editing surface, and a plain
            textarea is the one control that cannot lose a keystroke or reformat somebody's
            file on the way in.
          -->
          <div v-else-if="editing" class="files__edit">
            <!--
              A conflict is a fork in the road, not a wall. The banner used to say "re-read it,
              then make the edit again" next to a re-read button disabled by the very edit it
              was telling you to abandon, so the only way out was Cancel and the draft went with
              it. Every button here keeps the draft: see what the other writer did, take it with
              you, or write over their copy having snapshotted it first.
            -->
            <div v-if="conflict" class="files__conflict" data-testid="files-conflict">
              <SIcon name="alert" :size="15" />
              <div class="files__conflict-text">
                <p class="files__conflict-head">
                  {{ conflict }}
                </p>
                <p class="files__conflict-note">
                  Nothing has been written and your draft is still here. Compare it with the
                  pod's copy, take a copy of it, or write it over theirs - which snapshots what
                  it replaces into the history below first.
                </p>
              </div>
              <div class="files__conflict-actions">
                <SButton
                  variant="secondary"
                  size="sm"
                  icon="compare"
                  data-testid="files-conflict-compare"
                  :loading="conflictBusy === 'compare'"
                  @click="compareConflict"
                >
                  {{ showConflict ? 'Back to my draft' : 'Compare' }}
                </SButton>
                <SButton
                  variant="neutral"
                  size="sm"
                  data-testid="files-conflict-copy"
                  @click="copyDraft"
                >
                  Copy my draft
                </SButton>
                <SButton
                  variant="neutral"
                  size="sm"
                  icon="save"
                  data-testid="files-conflict-keep"
                  :loading="conflictBusy === 'keep'"
                  @click="keepMyVersion"
                >
                  Keep my version
                </SButton>
                <SButton
                  variant="ghost"
                  size="sm"
                  icon="refresh"
                  data-testid="files-conflict-reread"
                  @click="discardDraft"
                >
                  Discard mine, re-read
                </SButton>
              </div>
            </div>

            <DiffView
              v-if="showConflict && conflictPatch"
              class="files__conflict-diff"
              :patch="conflictPatch"
              subject="Removed lines are the pod's copy, added lines are your draft"
            />
            <textarea
              v-else
              v-model="draft"
              class="files__edit-area"
              spellcheck="false"
              data-testid="files-edit-area"
              :aria-label="`Edit ${ current }`"
            />
          </div>

          <!--
            One row per line, each line a list of coloured runs. `v-for` over the runs rather
            than v-html, because the file is somebody's source and putting it through
            innerHTML is how a package that contains a script tag ends up executing it.
          -->
          <table v-else class="files__lines">
            <tbody>
              <tr v-for="(row, i) in highlighted" :key="i">
                <td class="files__ln">{{ i + 1 }}</td>
                <td class="files__code-line"><span
                  v-for="(token, j) in row"
                  :key="j"
                  :class="token.c ? `files__tok files__tok--${ token.c }` : null"
                >{{ token.t }}</span></td>
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
            <span class="files__muted">{{ history.length }} entries</span>
          </div>
          <div class="files__commits">
            <!--
              Commits and automatic snapshots in one order (22:964: "automatic · 12:06" over
              "Ken Wimer · 7h ago"). A snapshot has no author because nobody wrote it, which is
              the distinction the row is there to draw.
            -->
            <div
              v-for="c in historyRows"
              :key="c.ref"
              class="files__commit"
              :class="{
                'files__commit--current': c.kind === 'working' ? working : (commit && commit.ref === c.ref),
                'files__commit--working': c.kind === 'working',
              }"
              data-testid="files-history-entry"
              @click="openHistory(c)"
            >
              <code class="files__sha">{{ c.kind === 'commit' ? c.ref : c.kind }}</code>
              <span class="files__commit-subject">{{ c.subject }}</span>
              <span class="files__commit-meta">{{ entrySource(c) }} · {{ c.when }}</span>
            </div>
            <div v-if="!history.length && !loading" class="files__muted files__pad">
              No commits or snapshots yet.
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
          <!--
            22:1157: the miniature of the page this file renders, with the cluster and the page
            it is (22:1159 "local", 22:1160 "Node health"). The route comes out of the
            extension's own routing table, so a file that renders no page of its own says that
            instead of framing the extension's home page and implying it is this file's.
          -->
          <template v-if="current">
            <SLabel text="Where it surfaces" />

            <div v-if="surface" class="files__surface" data-testid="files-surface">
              <div class="files__thumb">
                <!--
                  Same-origin, through the apiserver's service proxy, scaled down rather than
                  screenshotted - there is nothing in this product that can take a screenshot.
                  Framed only once somebody asks for it: it is a whole dashboard booting.
                -->
                <iframe
                  v-if="showThumb"
                  class="files__thumb-frame"
                  :src="previewUrl"
                  :title="`Live preview of ${ extension }`"
                />
                <button
                  v-else
                  type="button"
                  class="files__thumb-load"
                  data-testid="files-show-thumb"
                  @click="showThumb = true"
                >
                  <SIcon name="monitor" :size="18" />
                  Show the running extension
                </button>
              </div>

              <div class="files__surface-meta">
                <SChip label="local" icon="server" />
                <code class="files__surface-route" data-testid="files-surface-route">{{ surfaceRoute }}</code>
              </div>

              <!-- 22:1178 -->
              <SButton
                variant="neutral"
                size="sm"
                icon="external"
                data-testid="files-open-live-preview"
                @click="openLivePreview"
              >
                Open the live preview
              </SButton>

              <p class="files__note files__note--tight">
                {{ basename }} is mounted at <code>{{ surfaceRoute }}</code>, read out of
                <code>routing/index.ts</code>. The preview opens the extension's dev server,
                which serves the app at its root only - it has no history fallback, so a link
                straight to that route is a 404 rather than the page. Navigate to it inside.
              </p>
            </div>

            <p v-else class="files__note files__note--tight">
              {{ basename }} does not render a page of its own. Only the components named in
              <code>routing/index.ts</code> have a route, and the route is read from there
              rather than guessed at from the file's name.
            </p>
          </template>

          <SLabel :text="basename ? `References to ${ basename }` : 'No file open'" />

          <div v-if="searching" class="files__muted">
            Searching the package…
          </div>

          <template v-else>
            <div
              v-for="(u, i) in usages"
              :key="i"
              class="files__usage"
              data-testid="files-usage"
              @click="current = u.path"
            >
              <span class="files__usage-head">
                <span class="files__usage-path">{{ u.path }}:{{ u.line }}</span>
                <span class="files__usage-reason">{{ usageReason(u) }}</span>
              </span>
              <code class="files__usage-text">{{ u.text }}</code>
            </div>

            <div v-if="!usages.length && current" class="files__muted">
              Nothing else in this package mentions {{ basename }}.
            </div>
          </template>

          <p class="files__note">
            A fixed-string search of the package, not a symbol index - it finds imports and
            string references, and will miss anything renamed on the way in. The relationship
            on each row is read off the line that matched, and is "mentions it" when the line
            does not show one.
          </p>
        </div>
      </div>
    </div>

    <!--
      Reverting is destructive and the two cases are not the same destruction: a file git has
      seen goes back to its last commit, and one it has not is deleted. The dialog says which
      before anybody agrees to it.
    -->
    <SModal
      v-if="confirmRevert"
      :title="`Revert ${ basename }`"
      icon="undo"
      :width="520"
      @close="confirmRevert = false"
    >
      <p class="files__say">
        <template v-if="currentMark === 'new'">
          <strong>{{ current }}</strong> has never been committed, so there is nothing to put
          back: reverting it deletes the file from the pod.
        </template>
        <template v-else-if="currentGone">
          <strong>{{ current }}</strong> was deleted. Reverting writes it back into the pod as
          its last commit left it.
        </template>
        <template v-else>
          <strong>{{ current }}</strong> goes back to its last commit. Everything the assistant
          or you have changed in it since then is thrown away.
        </template>
      </p>
      <p class="files__say">
        Only this file. Nothing else in the working tree is touched, and nothing is committed
        or pushed anywhere.
      </p>

      <template #footer>
        <SButton variant="neutral" @click="confirmRevert = false">
          Cancel
        </SButton>
        <SButton
          variant="danger"
          icon="undo"
          data-testid="files-revert-confirm"
          @click="revertFile"
        >
          <template v-if="currentMark === 'new'">
            Delete it
          </template>
          <template v-else-if="currentGone">
            Restore it
          </template>
          <template v-else>
            Revert it
          </template>
        </SButton>
      </template>
    </SModal>

    <SModal
      v-if="confirmPublish"
      :title="`Publish ${ extension }`"
      icon="rocket"
      :width="520"
      @close="confirmPublish = false"
    >
      <p class="files__say">
        <strong>{{ extension }}</strong> is built in its pod from the working tree you have been
        reading, and this Rancher is pointed at the result. Everybody signed into this cluster
        gets the new build the next time they load a page.
      </p>
      <p class="files__say">
        Nothing is committed and nothing is pushed anywhere. The workspace runs it and reports
        each step on its status strip.
      </p>

      <template #footer>
        <SButton variant="neutral" @click="confirmPublish = false">
          Cancel
        </SButton>
        <SButton
          variant="primary"
          icon="rocket"
          data-testid="files-publish-confirm"
          @click="startPublish"
        >
          Publish to this Rancher
        </SButton>
      </template>
    </SModal>
  </div>
</template>

<style lang="scss" scoped>
.files {
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  background:     var(--studio-surface);

  /*
   * The code pane's palette.
   *
   * Declared here rather than in design/studio.css because this is the only screen that
   * colours source, and the trap the token file warns about applies: a custom property is
   * substituted in the scope it is declared in, so these sit on the component's own root and
   * the dark values are restated under `body.theme-dark`, the same selector studio.css uses.
   * Hues are the studio's own - the link blue, the accent green, the warning amber - rather
   * than an editor theme's, so the pane belongs to the product it is in.
   */
  --files-tok-comment: var(--studio-text-tertiary);
  --files-tok-string:  #337041;
  --files-tok-keyword: #8250B0;
  --files-tok-number:  #A85B12;
  --files-tok-meta:    var(--studio-blue-600);

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
    // A flex row so the change badge can sit at the right of the name without leaving the
    // row's box: the padding below is measured against 22:1015 and must not move.
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-6);
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

  &__tok {
    // The runs are inline spans inside a pre-wrap cell, so they inherit the cell's wrapping
    // and add nothing to the box. Colour is the only thing they carry.
    &--comment { color: var(--files-tok-comment); font-style: italic; }
    &--string  { color: var(--files-tok-string); }
    &--keyword { color: var(--files-tok-keyword); }
    &--number  { color: var(--files-tok-number); }
    &--meta    { color: var(--files-tok-meta); }
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

  // Who and when, held together so the row never wraps the author onto its own line.
  &__commit-meta {
    flex:        0 0 auto;
    font:        var(--studio-caption-12);
    color:       var(--studio-text-tertiary);
    white-space: nowrap;
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

  &__usage-head {
    display:     flex;
    align-items: baseline;
    gap:         var(--studio-space-8);
  }

  &__usage-path {
    flex:  1 1 auto;
    min-width: 0;
    font:  var(--studio-caption-12);
    color: var(--studio-text-link);
    word-break: break-all;
  }

  // What the row is, in words. Right of the path because the path is what identifies it and
  // the relationship is what makes it worth opening.
  &__usage-reason {
    flex:           0 0 auto;
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
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

  &__loose-name {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  /*
   * 22:1000 "new" / 22:1013 "edited". Small enough that a tree of twenty rows with three marks
   * in it still reads as a tree, and worded rather than coloured only, because a colour on its
   * own is not a readout.
   */
  &__mark {
    flex:           0 0 auto;
    padding:        0 5px;
    border-radius:  2px;
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    line-height:    15px;
    color:          var(--studio-on-status);
    background:     var(--studio-text-tertiary);

    &--new { background: var(--studio-success); }
    &--edited { background: var(--studio-warning); }
    &--gone { background: var(--studio-error); }
  }

  /* The branch row at the top of the tree column (22:928). */
  &__branch {
    display: block;

    :deep(.s-menu__trigger) {
      display:       flex;
      width:         100%;
      align-items:   center;
      gap:           var(--studio-space-8);
      padding:       var(--studio-space-8) 14px;
      border-radius: 0;
      border-bottom: 1px solid var(--studio-border-subtle);
      text-align:    left;
    }
  }

  &__branch-name {
    font:  var(--studio-body-13);
    color: var(--studio-text);
  }

  &__branch-note {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    font:          var(--studio-caption-12);
    color:         var(--studio-text-tertiary);
  }

  /* The editable pane. */
  &__edit {
    display:        flex;
    flex-direction: column;
    flex:           1 1 auto;
    min-height:     0;
  }

  &__edit-area {
    flex:        1 1 auto;
    min-height:  240px;
    width:       100%;
    resize:      none;
    border:      none;
    outline:     none;
    background:  transparent;
    padding:     0 var(--studio-space-16);
    color:       var(--studio-text);
    font:        var(--studio-mono-12);
    tab-size:    2;
  }

  &__conflict {
    display:     flex;
    align-items: flex-start;
    gap:         var(--studio-space-8);
    margin:      0 var(--studio-space-16) var(--studio-space-8);
    padding:     var(--studio-space-8);
    border:      1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);
    background:  var(--studio-surface-subtle);
    font:        var(--studio-caption-12);
    color:       var(--studio-text);
  }

  &__conflict-text {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    // The text takes the space the buttons do not, and wraps rather than pushing them off the
    // end of a narrow column.
    flex:           1 1 auto;
    min-width:      0;
  }

  &__conflict-head {
    font-weight: 600;
  }

  &__conflict-note {
    color: var(--studio-text-secondary);
  }

  &__conflict-actions {
    display:     flex;
    align-items: center;
    flex-wrap:   wrap;
    gap:         var(--studio-space-8);
    flex:        0 0 auto;
  }

  &__conflict-diff {
    flex:       1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding:    0 var(--studio-space-16);
  }

  /* Where the open file surfaces (22:1157). */
  &__surface {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__thumb {
    position:       relative;
    height:         150px;
    overflow:       hidden;
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    background:     var(--studio-surface);
  }

  /*
   * A whole dashboard, scaled to fit the rail. `transform: scale` rather than a smaller
   * viewport, because the page inside is responsive and a 340px viewport would show its mobile
   * layout rather than the page the design draws.
   */
  &__thumb-frame {
    position:         absolute;
    top:              0;
    left:             0;
    width:            1280px;
    height:           800px;
    border:           0;
    transform:        scale(0.24);
    transform-origin: 0 0;
    pointer-events:   none;
  }

  &__thumb-load {
    display:         flex;
    width:           100%;
    height:          100%;
    align-items:     center;
    justify-content: center;
    gap:             var(--studio-space-8);
    border:          none;
    background:      none;
    min-height:      0;
    font:            var(--studio-caption-12);
    color:           var(--studio-text-secondary);
    cursor:          pointer;

    &:hover { background: var(--studio-surface-subtle); }
  }

  &__surface-meta {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    min-width:   0;
  }

  &__surface-route {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    font:          var(--studio-mono-11);
    color:         var(--studio-text-secondary);
  }

  &__say {
    margin: 0 0 var(--studio-space-12);
    font:   var(--studio-body-14);
    color:  var(--studio-text);

    &:last-child { margin-bottom: 0; }
  }

  &__note {
    font:       var(--studio-caption-12);
    color:      var(--studio-text-tertiary);
    margin:     var(--studio-space-4) 0 0;
    border-top: 1px solid var(--studio-border-subtle);
    padding-top: var(--studio-space-8);

    &--tight {
      border-top:  none;
      padding-top: 0;
    }
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

/*
 * The dark values for the code palette. Same three hues, lifted off a near-black panel: the
 * light ones are 4.5:1 on white and would be 2:1 here.
 */
body.theme-dark .files {
  --files-tok-string:  #8FD49E;
  --files-tok-keyword: #C79BE8;
  --files-tok-number:  #E0BC4A;
  --files-tok-meta:    #7FC3EA;
}

@keyframes files-spin {
  to { transform: rotate(360deg); }
}
</style>
