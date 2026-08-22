<script>
// Screen 01 · Extensions — Studio home (Figma node 8:30).
//
// The frame draws Rancher's nav rail and header around this; we are inside Rancher already, so
// only its `content` (8:72) is ours - a masthead and a table.
//
// The table is real. Its rows are the extensions this cluster actually has, and every column is
// a live reading: the state badge from the deployment and the working tree, the source from the
// annotation recorded when the extension was created, the branch and change count and last
// commit from one exec per pod, and where it is running from the published UIPlugin.
//
// Two things are drawn and not wired, and say so: sorting (the header's carets) and the
// per-row overflow menu. Search and the two buttons are real.
import {
  SButton, SBadge, SIcon, SEmpty
} from '../components/ui';
import ImportExtensionModal from '../components/ImportExtensionModal.vue';
import StartingExtensions from '../components/StartingExtensions.vue';
import { toastNotYet } from '../toast';
import {
  listExtensions, extensionDetail, extensionSource, parseGithubSource, publishedVersion,
  ensureExtension
} from '../extensions';
import { EDITOR_ROUTE, NEW_EXTENSION_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// The columns, at the widths the frame gives them. Name is the one that flexes.
const COLUMNS = [
  { id: 'state', label: 'State', width: 128 },
  { id: 'name', label: 'Name', width: null },
  { id: 'source', label: 'Source', width: 268 },
  { id: 'target', label: 'Running on', width: 168 },
  { id: 'when', label: 'Last change', width: 118 },
  { id: 'actions', label: '', width: 104 },
];

function relative(iso) {
  if (!iso) {
    return '—';
  }

  const then = Date.parse(iso);

  if (isNaN(then)) {
    return '—';
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
    SButton, SBadge, SIcon, SEmpty, ImportExtensionModal, StartingExtensions
  },

  mixins: [fullBleed],

  data() {
    return {
      rows:     [],
      loading:  true,
      search:    '',
      importing: false,
      pollTimer: null,
      // Extensions that have been asked for and are coming up. A list rather than one, because
      // nothing stops you asking for a second while the first is still installing.
      starting:  [],
      error:     '',
    };
  },

  computed: {
    columns() {
      return COLUMNS;
    },

    filtered() {
      const q = this.search.trim().toLowerCase();

      if (!q) {
        return this.rows;
      }

      return this.rows.filter((r) => {
        return r.name.toLowerCase().includes(q) || (r.sourceLabel || '').toLowerCase().includes(q);
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
      row.when = relative(detail?.lastChange);
      row.target = version ? `catalog · v${ version }` : (row.ready ? 'local (preview)' : '—');
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
        return 'Compiling — the preview reloads when it finishes';
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

    open(name) {
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: name } });
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
        this.error = e.message || String(e);
      }
    },

    notYet(what) {
      toastNotYet(this.$store, what);
    },
  },
};
</script>

<template>
  <div class="studio-home">
    <!-- masthead (8:101) -->
    <div class="studio-home__masthead">
      <div class="studio-home__breadcrumb">
        <a class="studio-home__crumb" @click="$router.push({ name: 'home' })">Extensions</a>
        <SIcon name="chevronRight" :size="12" />
        <span class="studio-home__crumb-current">Studio</span>
      </div>

      <div class="studio-home__title-row">
        <h1 class="studio-home__title">
          Extension Studio
        </h1>
        <span class="studio-home__count">{{ rows.length }}</span>

        <span class="studio-home__grow" />

        <div class="studio-home__search">
          <SIcon name="search" :size="13" />
          <input
            v-model="search"
            class="studio-home__search-input"
            placeholder="Search"
            aria-label="Search extensions"
          >
        </div>

        <SButton variant="neutral" icon="github" @click="importing = true">
          Import
        </SButton>
        <SButton variant="primary" icon="plus" @click="newExtension">
          New extension
        </SButton>
      </div>

      <p class="studio-home__lede">
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
            :class="{ 'studio-home__th--grow': !col.width, 'studio-home__th--plain': !col.label }"
            @click="col.label && notYet('sorting the extension list')"
          >
            {{ col.label }}
            <SIcon v-if="col.label" name="chevronDown" :size="11" class="studio-home__sort" />
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

        <SEmpty
          v-else-if="!loading && !filtered.length"
          icon="search"
          title="Nothing matches"
          :message="`No extension matches “${ search }”.`"
        />

        <div
          v-for="row in filtered"
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
            <span class="studio-home__muted">{{ row.target || '—' }}</span>
          </div>

          <div class="studio-home__td" :style="{ width: '118px', flex: '0 0 118px' }">
            <span class="studio-home__muted">{{ row.when || '—' }}</span>
          </div>

          <div
            class="studio-home__td studio-home__td--actions"
            :style="{ width: '104px', flex: '0 0 104px' }"
          >
            <SButton
              v-if="row.state === 'unsaved'"
              variant="secondary"
              size="sm"
              @click.stop="open(row.name)"
            >
              Review
            </SButton>
            <SButton
              v-else
              variant="ghost"
              size="sm"
              icon="more"
              icon-only
              aria-label="More"
              @click.stop="notYet('the row menu')"
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
      @settings="notYet('opening settings from here')"
    />
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

  &__count {
    padding:       var(--studio-space-2) var(--studio-space-8);
    background:    var(--studio-surface-nav);
    border-radius: var(--studio-radius-control);
    font:          var(--studio-caption-12);
    color:         var(--studio-text-secondary);
  }

  &__grow { flex: 1 1 auto; }

  &__search {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    width:         180px;
    padding:       7px 10px;
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
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
    font:       var(--studio-body-14);
    color:      var(--studio-text);
  }

  &__lede {
    font:      var(--studio-body-14);
    color:     var(--studio-text-secondary);
    margin:    0;
    max-width: 90ch;
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

    &--actions { justify-content: flex-end; }
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
}
</style>
