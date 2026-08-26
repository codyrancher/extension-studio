<script>
// Screen 01 · Extensions - Studio home (Figma node 8:30).
//
// The frame draws Rancher's nav rail and header around this; we are inside Rancher already, so
// only its `content` (8:72) is ours - a masthead and a table.
//
// The table is real. Its rows are the extensions this cluster actually has, and every column is
// a live reading: the state badge from the deployment and the working tree, the source from the
// annotation recorded when the extension was created, the branch and change count and last
// commit from one exec per pod, and where it is running from the published UIPlugin.
//
// Everything on it works. The header sorts, the per-row menu goes to the places that exist for
// that row and greys out the ones that do not, and the two buttons are real.
import {
  SButton, SBadge, SIcon, SEmpty, SMenu, SModal
} from '../components/ui';
import ImportExtensionModal from '../components/ImportExtensionModal.vue';
import StartingExtensions from '../components/StartingExtensions.vue';
import { toastSuccess, toastError } from '../toast';
import {
  listExtensions, extensionDetail, extensionSource, parseGithubSource, publishedVersion,
  ensureExtension, removeLocalInstall
} from '../extensions';
import {
  EDITOR_ROUTE, NEW_EXTENSION_ROUTE, REVIEW_ROUTE, FILES_ROUTE, BRIEF_ROUTE, SETTINGS_ROUTE,
  STUDIO_PAGE_ACTIONS, handleStudioPageAction
} from '../editor-product';
import pageActionsMixin from '@shell/mixins/page-actions';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// The columns, at the widths the frame gives them. Name is the one that flexes.
//
// `dir` is the direction a column sorts the first time it is clicked, which is not the same for
// all of them: a name wants A-Z, a timestamp wants the most recent thing at the top. Clicking
// the column again reverses whichever it started with.
const COLUMNS = [
  {
    id: 'state', label: 'State', width: 128, dir: 'asc'
  },
  {
    id: 'name', label: 'Name', width: null, dir: 'asc'
  },
  {
    id: 'source', label: 'Source', width: 268, dir: 'asc'
  },
  {
    id: 'target', label: 'Running on', width: 168, dir: 'asc'
  },
  {
    id: 'when', label: 'Last change', width: 118, dir: 'desc'
  },
  { id: 'actions', label: '', width: 56 },
];

/**
 * What "sorted by state" means.
 *
 * Not the badge's own word, which would put Building above Failed because B sorts before F and
 * would tell nobody anything. This is how much of your attention the row wants: a build that
 * died, then work nobody has looked at, then the ones that are simply fine.
 */
const STATE_ORDER = {
  failed: 0, unsaved: 1, building: 2, live: 3, published: 4, draft: 5,
};

/**
 * The value a column sorts on, which is never the string the cell renders.
 *
 * "4 min ago" and "2 days ago" are one alphabet apart and four hours apart, and only one of
 * those is what the column means; the same is true of the badge's word and of a source line
 * that reads "Created here · no repo yet". Each case below returns the reading the cell was
 * rendered *from*.
 */
function sortValue(row, key) {
  switch (key) {
  case 'state':
    return STATE_ORDER[row.state] ?? STATE_ORDER.draft;

  case 'name':
    return row.name || '';

  case 'source':
    // The parsed annotation. Imports order by repository; everything made here has no
    // repository, sorts as the empty string, and so groups together instead of scattering
    // under the C of "Created here".
    return row.github ? `${ row.github.repo } ${ row.github.ref || '' }` : '';

  case 'target':
    // Installed in this Rancher, then previewing from its pod, then neither - and the
    // installed ones by version among themselves.
    return row.version ? `0 ${ row.version }` : (row.ready ? '1' : '2');

  case 'when':
    // The timestamp behind the relative string. 0 for a row that has not answered yet, which
    // puts it last under the default (newest first).
    return changedAt(row.detail);

  default:
    return '';
  }
}

/**
 * When this extension last changed, in milliseconds, or 0 if it has not said.
 *
 * The newer of the last commit and the newest uncommitted file, because both are changes and
 * only one of them used to count. A row whose subtitle says "1 change waiting for your review"
 * and whose Last change says "1 day ago" is describing two different events, and the older of
 * the two was winning.
 */
function changedAt(detail) {
  const committed = Date.parse(detail?.lastChange || '') || 0;
  const touched = Date.parse(detail?.lastTouched || '') || 0;

  return Math.max(committed, touched);
}

/** "4 min ago", from a timestamp in milliseconds. 0 means the row has not answered yet. */
function relative(then) {
  if (!then) {
    return '-';
  }

  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (secs < 60) {
    return 'just now';
  }

  const mins = Math.round(secs / 60);

  if (mins < 60) {
    return `${ mins } min ago`;
  }

  const hours = Math.round(mins / 60);

  if (hours < 24) {
    return `${ hours } hour${ hours === 1 ? '' : 's' } ago`;
  }

  const days = Math.round(hours / 24);

  if (days < 7) {
    return `${ days } day${ days === 1 ? '' : 's' } ago`;
  }

  const weeks = Math.round(days / 7);

  return `${ weeks } week${ weeks === 1 ? '' : 's' } ago`;
}

export default {
  name: 'BarnExtensions',

  components: {
    SButton,
    SBadge,
    SIcon,
    SEmpty,
    SMenu,
    SModal,
    ImportExtensionModal,
    StartingExtensions,
  },

  mixins: [fullBleed, pageActionsMixin],

  data() {
    return {
      rows:     [],
      loading:  true,
      importing: false,
      pollTimer: null,
      // Extensions that have been asked for and are coming up. A list rather than one, because
      // nothing stops you asking for a second while the first is still installing.
      starting:  [],
      // Which column the table is ordered by, and which way. Name ascending is what
      // listExtensions already hands back, so the first paint is the default rather than a
      // re-shuffle of it.
      sortKey:   'name',
      sortDir:   'asc',
      // The row whose local install is being removed, or null. Held rather than acted on: it
      // changes the Rancher everybody else is looking at, so it asks first.
      removing:  null,
      removingBusy: false,
    };
  },

  computed: {
    /**
     * The route names the template pushes to.
     *
     * A plain `<script>` block's module scope is not the render function's scope, so an
     * imported constant used bare in the template resolves to `undefined` and the push is
     * dropped without an error. See the same computed in files.vue.
     */
    routes() {
      return { SETTINGS_ROUTE };
    },

    /**
     * What Rancher's header kebab offers on this screen (Figma 53:1306).
     *
     * Read by @shell/mixins/page-actions, which commits it to the root store on `created` and
     * clears it on `beforeUnmount`, so the menu exists here and nowhere else in Rancher. The
     * list itself lives in editor-product.ts; see the note there for why these three.
     */
    pageActions() {
      return STUDIO_PAGE_ACTIONS;
    },

    columns() {
      return COLUMNS;
    },

    /**
     * Every row. Kept as a name rather than folded into `sorted`, because the search box that
     * used to narrow it is the only thing that went - the shape the table reads is unchanged,
     * and putting the box back is putting a filter here again.
     */
    filtered() {
      return this.rows;
    },

    /**
     * What the table draws: the filtered rows in the chosen order.
     *
     * A copy, because `rows` is the poll's to replace and sorting it in place would fight the
     * enrichment writing into it. Name breaks every tie so the order is stable across polls
     * rather than shuffling whenever two rows compare equal - two Building rows swapping
     * places every fifteen seconds reads as the page being broken.
     */
    sorted() {
      const key = this.sortKey;
      const factor = this.sortDir === 'desc' ? -1 : 1;

      return [...this.filtered].sort((a, b) => {
        const av = sortValue(a, key);
        const bv = sortValue(b, key);
        const d = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));

        return d ? d * factor : a.name.localeCompare(b.name);
      });
    },
  },

  mounted() {
    this.load();
    // The list is mostly static, but a pod that is still compiling flips to ready without
    // anything on this page having asked - so re-read on a slow timer rather than making a
    // person reload to find out.
    this.pollTimer = setInterval(() => this.load({ quiet: true }), 15000);
  },

  beforeUnmount() {
    clearInterval(this.pollTimer);
  },

  methods: {
    /**
     * Two passes, on purpose.
     *
     * The first is one API call and fills the table immediately with the names and whether
     * each pod is up. The second shells into each pod for its branch, change count and last
     * commit, and fills those columns in as they land. Doing it the other way round means an
     * empty page for as long as the slowest pod takes to answer.
     */
    async load({ quiet = false } = {}) {
      if (!quiet) {
        this.loading = true;
      }

      const summaries = await listExtensions().catch(() => []);

      this.rows = summaries.map((s) => {
        const existing = this.rows.find((r) => r.name === s.name);

        return {
          ...(existing || {}), name: s.name, ready: s.ready,
        };
      });
      this.loading = false;

      await Promise.all(summaries.map((s) => this.enrich(s.name)));
    },

    /**
     * Fill in one row's slow columns.
     *
     * The row is looked up again *after* the reads rather than held across them, which is not
     * fussiness: this runs on a fifteen-second poll, and a poll that lands while these execs
     * are in flight replaces every object in `rows`. A reference captured beforehand is then
     * an orphan - still writable, no longer rendered - so the writes vanished and the row kept
     * whatever the previous pass had put in it. That is what made a ready extension sit there
     * badged "Draft" while its own subtitle said it was on main with nothing uncommitted.
     */
    async enrich(name) {
      const [detail, source, version] = await Promise.all([
        extensionDetail(name).catch(() => null),
        extensionSource(name).catch(() => ''),
        publishedVersion(name).catch(() => ''),
      ]);

      const row = this.rows.find((r) => r.name === name);

      if (!row) {
        return;
      }

      const github = parseGithubSource(source || '');

      row.detail = detail;
      row.version = version;
      row.github = github;
      row.sourceLabel = github ? `${ github.repo }${ github.ref ? ` · ${ github.ref }` : '' }` : 'Created here · no repo yet';
      row.state = this.stateOf(row);
      row.subtitle = this.subtitleOf(row);
      row.when = relative(changedAt(detail));
      row.whenHint = this.whenHint(detail);
      row.target = version ? `catalog · v${ version }` : (row.ready ? 'local (preview)' : '-');
    },

    /**
     * Which of the two readings the Last change cell is showing, said outright on hover.
     *
     * The column blends a commit time and a working-tree mtime, and which one is on top
     * changes what the number means - "edited but not committed" against "committed and left
     * alone". Cheaper to say than to make somebody infer it from the badge.
     */
    whenHint(detail) {
      const committed = Date.parse(detail?.lastChange || '') || 0;
      const touched = Date.parse(detail?.lastTouched || '') || 0;

      if (!committed && !touched) {
        return '';
      }

      if (touched > committed) {
        return 'An uncommitted file was edited then. The last commit is older.';
      }

      return 'The last commit. Nothing has been edited since.';
    },

    /**
     * Which of the badge's six states this extension is in.
     *
     * Ordered by what a person most needs to know: a pod that is not up yet is Building
     * whatever else is true of it, then uncommitted work, then whether it has been published.
     */
    stateOf(row) {
      if (!row.ready) {
        return 'building';
      }

      if ((row.detail?.changes || 0) > 0) {
        return 'unsaved';
      }

      if (row.version) {
        return 'published';
      }

      return 'live';
    },

    subtitleOf(row) {
      if (!row.ready) {
        return 'Compiling - the preview reloads when it finishes';
      }

      const changes = row.detail?.changes || 0;

      if (changes > 0) {
        return `${ changes } change${ changes === 1 ? '' : 's' } waiting for your review`;
      }

      if (row.version) {
        return `Released as v${ row.version } to this Rancher`;
      }

      return row.detail?.branch ? `On ${ row.detail.branch }, nothing uncommitted` : 'Ready';
    },

    /** One of the header kebab's items was chosen. Dispatched here by the same mixin. */
    handlePageAction(action) {
      handleStudioPageAction(this, action);
    },

    open(name) {
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: name } });
    },

    /**
     * To the diff for one extension.
     *
     * Reached from the row menu's "Review changes". There was a Review button beside the menu
     * as well, on rows with uncommitted work; it is gone, and this is what it called.
     */
    review(name) {
      this.$router.push({ name: REVIEW_ROUTE, params: { extension: name } });
    },

    /**
     * The "Extensions" crumb: Rancher's own extensions page, which is what it says.
     *
     * `{ name: 'home' }` is Rancher's home page and was what this pushed, so a crumb labelled
     * Extensions landed on "Welcome to Rancher".
     *
     * The cluster is resolved the way the side menu resolves it, so the crumb and the rail's
     * Extensions entry land on the same URL. `_` is Rancher's cluster-less cluster id
     * (BLANK_CLUSTER) and is the fallback when nothing is loaded.
     */
    openRancherExtensions() {
      const cluster = this.$store.getters['clusterId'] || this.$store.getters['defaultClusterId'] || '_';

      this.$router.push({ name: 'c-cluster-uiplugins', params: { cluster } });
    },

    newExtension() {
      this.$router.push({ name: NEW_EXTENSION_ROUTE });
    },

    /**
     * Make the extension the import modal asked for.
     *
     * Same contract the editor uses: the modal hands back a `done` so it can close itself only
     * once the object exists, and the name goes on the starting list meanwhile - a pod takes
     * minutes to compile the first time, and a row that simply does not appear for two of them
     * reads as the import having failed.
     */
    async onCreate({ name, source, done }) {
      this.importing = false;

      if (!this.starting.includes(name)) {
        this.starting = [...this.starting, name];
      }

      try {
        await ensureExtension(name, source);
        done(true);
        this.load({ quiet: true });
      } catch (e) {
        done(false);
        this.starting = this.starting.filter((each) => each !== name);
        // A toast rather than a field on this component: the modal has closed by now, so
        // there is nowhere on this page the message would have been rendered.
        toastError(this.$store, e.message || String(e));
      }
    },

    /**
     * Order by this column, or reverse it if it is already the one.
     *
     * A column arriving fresh takes its own preferred direction rather than always starting
     * ascending - see `dir` on COLUMNS.
     */
    toggleSort(col) {
      if (!col.label) {
        return;
      }

      if (this.sortKey === col.id) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';

        return;
      }

      this.sortKey = col.id;
      this.sortDir = col.dir || 'asc';
    },

    sortHint(col) {
      if (this.sortKey !== col.id) {
        return `Sort by ${ col.label.toLowerCase() }`;
      }

      return this.sortDir === 'asc' ? 'Sorted ascending, click to reverse' : 'Sorted descending, click to reverse';
    },

    /**
     * The row menu, with the lines that are true of this row enabled and the rest greyed.
     *
     * Nothing here is aspirational: each line is a route this extension has or a delete that
     * has something to delete. Reviewing a tree with nothing in it, reading files out of a pod
     * that has not started, and removing an install that was never made are all disabled with
     * the reason on the right, which is more use than hiding them - the shape of the menu then
     * says the same thing for every row.
     */
    rowMenu(row) {
      const changes = row.detail?.changes || 0;

      return [
        { id: 'open', label: 'Open in the workspace', icon: 'sparkle' },
        {
          id:       'review',
          label:    'Review changes',
          icon:     'compare',
          note:     changes ? `${ changes }` : 'none',
          disabled: !changes,
        },
        {
          id: 'files', label: 'Open files', icon: 'file', disabled: !row.ready, note: row.ready ? '' : 'still building',
        },
        {
          id: 'brief', label: 'Open the brief', icon: 'book', disabled: !row.ready, note: row.ready ? '' : 'still building',
        },
        { divider: true },
        {
          id:       'remove',
          label:    'Remove the local install',
          icon:     'trash',
          danger:   true,
          disabled: !row.version,
          note:     row.version ? `v${ row.version }` : 'not installed',
        },
      ];
    },

    onRowAction(row, id) {
      if (id === 'remove') {
        this.removing = row;

        return;
      }

      const route = {
        open: EDITOR_ROUTE, review: REVIEW_ROUTE, files: FILES_ROUTE, brief: BRIEF_ROUTE,
      }[id];

      if (route) {
        this.$router.push({ name: route, params: { extension: row.name } });
      }
    },

    /**
     * Delete the UIPlugin this extension was published as.
     *
     * The list is re-read afterwards rather than patched, because the row's State, Running on
     * and subtitle are all readings of what was just deleted and guessing at all three is how
     * they end up disagreeing with each other.
     */
    async removeInstall() {
      const row = this.removing;

      if (!row || this.removingBusy) {
        return;
      }

      this.removingBusy = true;

      try {
        const plugin = await removeLocalInstall(row.name);

        this.removing = null;
        toastSuccess(this.$store, `${ plugin } is no longer loaded by this Rancher. The extension itself is untouched.`);
        await this.load({ quiet: true });
      } catch (e) {
        toastError(this.$store, e.message || String(e));
      } finally {
        this.removingBusy = false;
      }
    },

  },
};
</script>

<template>
  <div class="studio-home">
    <!-- masthead (8:101) -->
    <div class="studio-home__masthead">
      <div class="studio-home__breadcrumb">
        <a
          class="studio-home__crumb"
          data-testid="studio-crumb-extensions"
          @click="openRancherExtensions"
        >Extensions</a>
        <SIcon name="chevronRight" :size="12" />
        <span class="studio-home__crumb-current">Studio</span>
      </div>

      <div class="studio-home__title-row">
        <h1 class="studio-home__title">
          Extension Studio
        </h1>
        <!--
          The Studio's settings, beside the name of the thing they are the settings for, where
          the count used to be. Icon only: a cog beside a title is read as "the settings for
          this", and the word was carrying no meaning the icon did not.

          It goes to the settings page rather than to the token modal - screen 09's caption
          makes that page the one home for connection, permissions, access and data, and a
          second surface editing the same values is the thing it replaces.
        -->
        <SButton
          variant="ghost"
          size="sm"
          icon="gear"
          icon-only
          title="Studio settings"
          aria-label="Studio settings"
          data-testid="studio-settings"
          @click="$router.push({ name: routes.SETTINGS_ROUTE })"
        />

        <span class="studio-home__grow" />

        <SButton variant="neutral" icon="github" @click="importing = true">
          Import
        </SButton>
        <SButton variant="primary" icon="plus" @click="newExtension">
          New extension
        </SButton>
      </div>

      <p
        class="studio-home__lede"
        title="Describe what you want in plain language; the assistant builds it against this Rancher. Nothing reaches users until you publish."
      >
        Describe what you want in plain language; the assistant builds it against this Rancher.
        Nothing reaches users until you publish.
      </p>
    </div>

    <!-- table (8:127) -->
    <div class="studio-home__table-wrap">
      <div class="studio-home__table">
        <div class="studio-home__head">
          <button
            v-for="col in columns"
            :key="col.id"
            type="button"
            class="studio-home__th"
            :style="col.width ? { width: `${ col.width }px`, flex: `0 0 ${ col.width }px` } : {}"
            :class="{
              'studio-home__th--grow': !col.width,
              'studio-home__th--plain': !col.label,
              'studio-home__th--sorted': col.id === sortKey,
            }"
            :aria-sort="col.id === sortKey ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
            :title="col.label ? sortHint(col) : null"
            @click="toggleSort(col)"
          >
            {{ col.label }}
            <SIcon
              v-if="col.label"
              :name="col.id === sortKey && sortDir === 'asc' ? 'chevronUp' : 'chevronDown'"
              :size="11"
              class="studio-home__sort"
              :class="{ 'studio-home__sort--on': col.id === sortKey }"
            />
          </button>
        </div>

        <SEmpty
          v-if="!loading && !filtered.length && !rows.length"
          icon="puzzle"
          title="No extensions yet"
          message="An extension is a pod in this cluster with a dev server in it. Make one and the assistant starts editing it straight away."
        >
          <SButton variant="primary" icon="plus" @click="newExtension">
            New extension
          </SButton>
        </SEmpty>

        <div
          v-for="row in sorted"
          :key="row.name"
          class="studio-home__row"
          @click="open(row.name)"
        >
          <div class="studio-home__td" :style="{ width: '128px', flex: '0 0 128px' }">
            <SBadge :status="row.state || 'draft'" />
          </div>

          <div class="studio-home__td studio-home__td--grow studio-home__td--stack">
            <span class="studio-home__name">{{ row.name }}</span>
            <span
              class="studio-home__subtitle"
              :class="{ 'studio-home__subtitle--error': row.state === 'failed' }"
            >{{ row.subtitle || '…' }}</span>
          </div>

          <div class="studio-home__td" :style="{ width: '268px', flex: '0 0 268px' }">
            <SIcon :name="row.github ? 'github' : 'sparkle'" :size="14" />
            <span class="studio-home__muted">{{ row.sourceLabel || '…' }}</span>
          </div>

          <div class="studio-home__td" :style="{ width: '168px', flex: '0 0 168px' }">
            <span class="studio-home__muted">{{ row.target || '-' }}</span>
          </div>

          <div class="studio-home__td" :style="{ width: '118px', flex: '0 0 118px' }">
            <span class="studio-home__muted" :title="row.whenHint || null">{{ row.when || '-' }}</span>
          </div>

          <div
            class="studio-home__td studio-home__td--actions"
            :style="{ width: '56px', flex: '0 0 56px' }"
          >
            <SMenu
              :items="rowMenu(row)"
              :aria-label="`Actions for ${ row.name }`"
              @select="onRowAction(row, $event)"
            />
          </div>
        </div>
      </div>
    </div>

    <StartingExtensions
      :names="starting"
      @open="open"
      @dismiss="starting = starting.filter((each) => each !== $event)"
    />

    <ImportExtensionModal
      v-if="importing"
      @close="importing = false"
      @create="onCreate"
    />

    <!--
      Removing the local install changes the Rancher everybody else is signed in to, so it asks
      - and says exactly how much it takes away, which is less than the word "remove" suggests.
    -->
    <SModal
      v-if="removing"
      title="Remove the local install?"
      icon="trash"
      :width="480"
      :busy="removingBusy"
      @close="removing = null"
    >
      <p class="studio-home__say">
        This Rancher stops loading <strong>{{ removing.name }}</strong>: its UIPlugin is deleted
        and the pages it adds go away for everybody signed in here.
      </p>
      <p class="studio-home__say">
        The extension itself is untouched. Its pod, its files and its history stay exactly as
        they are, and publishing puts it back.
      </p>

      <template #footer>
        <SButton variant="neutral" :disabled="removingBusy" @click="removing = null">
          Cancel
        </SButton>
        <SButton variant="danger" :loading="removingBusy" @click="removeInstall">
          Remove it
        </SButton>
      </template>
    </SModal>
  </div>
</template>

<style lang="scss" scoped>
.studio-home {
  display:        flex;
  flex-direction: column;
  height:         100%;
  overflow-y:     auto;
  background:     var(--studio-surface);

  &__masthead {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    padding:        var(--studio-space-20) var(--studio-space-24) var(--studio-space-16);
  }

  &__breadcrumb {
    display:     flex;
    align-items: center;
    gap:         6px;
    color:       var(--studio-text-tertiary);
  }

  &__crumb {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-link);
    cursor: pointer;

    &:hover { text-decoration: underline; }
  }

  &__crumb-current {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__title-row {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-12);
  }

  &__title {
    font:           var(--studio-heading-24);
    letter-spacing: var(--studio-tracking-heading);
    color:          var(--studio-text);
    margin:         0;
  }

  &__grow { flex: 1 1 auto; }

  &__lede {
    font:          var(--studio-body-14);
    color:         var(--studio-text-secondary);
    margin:        0;
    // One line. `max-width: 90ch` was narrower than the masthead, so the sentence broke with
    // a single word - "publish." - alone on the second line, which reads as a mistake rather
    // than as a paragraph.
    //
    // Ellipsis rather than overflow, so a narrow pane shortens the sentence instead of pushing
    // the masthead wider than the screen; the whole sentence stays on the element's title, so
    // nothing that was said becomes unreadable.
    white-space:   nowrap;
    overflow:      hidden;
    text-overflow: ellipsis;
  }

  &__table-wrap {
    padding: 0 var(--studio-space-24) var(--studio-space-24);
  }

  &__table {
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    overflow:      hidden;
  }

  &__head {
    display:       flex;
    align-items:   center;
    padding:       var(--studio-row-pad-y) var(--studio-space-16);
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border);
  }

  &__th {
    display:     flex;
    align-items: center;
    gap:         6px;
    border:      none;
    background:  none;
    padding:     0;
    text-align:  left;
    font:        var(--studio-heading-14);
    color:       var(--studio-text);
    cursor:      pointer;

    &--grow  { flex: 1 1 auto; min-width: 0; }
    &--plain { cursor: default; }
  }

  &__sort {
    color:   var(--studio-text-tertiary);
    opacity: 0.6;

    // The active column's caret is the only one that means anything, so it is the only one
    // drawn at full strength - the other five stay as the affordance they were.
    &--on {
      color:   var(--studio-text-link);
      opacity: 1;
    }
  }

  &__row {
    display:       flex;
    align-items:   center;
    padding:       var(--studio-row-pad-y) var(--studio-space-16);
    border-bottom: 1px solid var(--studio-border-subtle);
    cursor:        pointer;

    &:last-child { border-bottom: none; }

    &:hover { background: var(--studio-surface-subtle); }
  }

  &__td {
    display:     flex;
    align-items: center;
    gap:         6px;
    min-width:   0;
    color:       var(--studio-text-secondary);

    &--grow  { flex: 1 1 auto; }

    &--stack {
      flex-direction: column;
      align-items:    flex-start;
      gap:            var(--studio-space-2);
    }

    // The row menu alone now: the Review button that shared this column is gone, and the
    // menu's own "Review changes" is the way to the diff. The trigger still gives back the
    // padding it carries elsewhere, which is what keeps it inside the column.
    &--actions {
      justify-content: flex-end;
      gap:             var(--studio-space-4);

      :deep(.s-menu__trigger) { padding: var(--studio-space-4); }
    }
  }

  &__name {
    font:  var(--studio-heading-14);
    color: var(--studio-text-link);
  }

  &__subtitle,
  &__muted {
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    max-width:     100%;
  }

  &__subtitle--error { color: var(--studio-error); }

  &__say {
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
    margin: 0 0 var(--studio-space-8);

    &:last-child { margin-bottom: 0; }
  }
}
</style>
