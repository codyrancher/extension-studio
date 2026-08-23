<script>
// Screen 11 · Review queue - what is waiting on you (Figma node 36:964).
//
// The queue is built from the cluster rather than from a review service, because there is no
// review service: an extension with uncommitted changes in its pod is a change waiting on
// somebody, and an extension whose last commit is recent is one that has been signed off. That
// is what the two tabs count.
//
// The footnote in the design states the rule this screen is built around - "rows lead with what
// the change is for, taken from its brief, not with a file count" - so each row's first line is
// the brief's opening paragraph, and a change with no brief says so plainly rather than falling
// back to a diffstat. The counts are on the line below, where they belong: they are how big the
// reading is, not what it is for.
//
// There used to be a third tab, "Waiting on others". It is gone: nothing in this product models
// a second reviewer, so it was a filter that could never match, carrying a hardcoded count of
// zero and an apology where its rows would be. What it was really saying - that you are both
// author and reviewer here - is a fact about the whole screen rather than about one row, and it
// is in the lede. There used to be a "Your part" column saying it once per row as though it
// varied between them; that is gone for the same reason.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, STabs, SMenu, SModal, SField
} from '../components/ui';
import {
  listExtensions, extensionDetail, readExtensionFile, countChanges, changedFiles, readDeferral
} from '../extensions';
import { STUDIO_ROUTE, REVIEW_CHANGE_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The orders the queue can be read in.
 *
 * The two by time say what they are ordered on in their note, and the note is not decoration:
 * what this screen can actually read is the last *commit*, so "oldest" means the change that
 * has been diverged from its branch longest, not the moment somebody typed. Calling that
 * "oldest" without saying so would be inventing a reading the cluster does not offer.
 */
const SORTS = [
  {
    id: 'oldest', label: 'Oldest first', icon: 'clock', note: 'by last commit'
  },
  {
    id: 'newest', label: 'Newest first', icon: 'clock', note: 'by last commit'
  },
  { id: 'most', label: 'Most changes', icon: 'compare' },
  { id: 'least', label: 'Least changes', icon: 'compare' },
];

/**
 * What this screen can be configured with, and where that is kept.
 *
 * Both settings change what the queue shows and both survive a reload, which is the whole test
 * of whether a settings dialog is a settings dialog. localStorage rather than the pod, because
 * neither is a fact about an extension: they are how one person likes to read the list, the
 * same place and for the same reason the editor keeps its splitter position.
 *
 * The gear used to open the *editor's* settings - a GitHub token - from a button labelled
 * "Review settings".
 */
const SETTINGS_KEY = 'barn.review.settings';
const DEFAULTS = { sort: 'oldest', signedOffDays: 7 };

function readReviewSettings() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
    const days = parseInt(raw.signedOffDays, 10);

    return {
      sort:          SORTS.some((each) => each.id === raw.sort) ? raw.sort : DEFAULTS.sort,
      signedOffDays: days > 0 ? Math.min(90, days) : DEFAULTS.signedOffDays,
    };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function writeReviewSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    // A browser with storage turned off keeps the choice for this session and loses it on
    // reload. Nothing here is worth an error dialog.
  }
}

/** Markdown that is prose rather than code. */
const PROSE = /\.(md|markdown|txt)$/i;
/** The files that decide what the extension depends on. */
const MANIFEST = /(^|\/)package(-lock)?\.json$/;
/** The files Rancher loads first - a mistake in one of these takes the whole extension down. */
const ENTRY = /(^|\/)(index|product|routing)\.(ts|js)$/;

/**
 * How much of a reviewer's attention this change wants, and the one line saying why.
 *
 * The rating used to be a file count and nothing else, which cannot tell a ten-file
 * documentation pass from ten files of the extension's entry point. It reads the paths and the
 * diff sizes it already has: whether anything but prose changed, whether the dependency
 * manifest moved, whether the files Rancher loads first are among them, and how many lines.
 *
 * The reason is three clauses because that is what the design draws ("Read-only · no new
 * dependencies · one page"), and every clause is a reading rather than a judgement.
 */
function assessRisk(files) {
  if (!files.length) {
    return { level: 'none', reason: 'Nothing uncommitted since the last commit' };
  }

  const lines = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  const proseOnly = files.every((f) => PROSE.test(f.path));
  const deps = files.some((f) => MANIFEST.test(f.path));
  const entry = files.some((f) => ENTRY.test(f.path));

  let level = 'low';

  if (files.length > 8 || lines > 400) {
    level = 'high';
  } else if (deps || entry || files.length > 3 || lines > 80) {
    level = 'medium';
  }

  if (proseOnly) {
    // Prose cannot break the extension, however much of it there is.
    level = 'low';
  }

  const reason = [
    proseOnly ? 'Prose only, no code' : `${ lines } line${ lines === 1 ? '' : 's' } changed`,
    deps ? 'moves the dependencies' : 'no dependency changes',
    entry ? 'touches the entry point' : `${ files.length } file${ files.length === 1 ? '' : 's' }`,
  ];

  return { level, reason: reason.join(' · ') };
}

/**
 * The brief's opening paragraph, whole.
 *
 * Skips the title and the `## The problem` heading and takes what is under it, joining the
 * lines up to the next blank line or heading. Taking one *line* was the bug: BRIEF.md is hard
 * wrapped, so the sentence the row exists to show stopped mid-clause - "apart from a slow" -
 * and the half that said what the problem was never appeared.
 */
function intentFrom(brief) {
  if (!brief || !brief.trim()) {
    return '';
  }

  const lines = brief.split('\n').map((l) => l.trim());
  const heading = lines.findIndex((l) => /^##\s+The problem/i.test(l));
  const from = heading >= 0 ? heading + 1 : 0;

  for (let i = from; i < lines.length; i++) {
    if (!lines[i] || lines[i].startsWith('#') || lines[i] === '_not stated_') {
      continue;
    }

    const paragraph = [];

    for (let j = i; j < lines.length && lines[j] && !lines[j].startsWith('#'); j++) {
      paragraph.push(lines[j]);
    }

    return paragraph.join(' ');
  }

  return '';
}

/** How many acceptance criteria the brief sets, which is what a sign-off is measured against. */
function criteriaCount(brief) {
  const lines = (brief || '').split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => /^##\s+How we will know it worked/i.test(l));

  if (at < 0) {
    return 0;
  }

  let n = 0;

  for (let i = at + 1; i < lines.length && !lines[i].startsWith('#'); i++) {
    if (/^- \[[ xX]\]/.test(lines[i])) {
      n++;
    }
  }

  return n;
}

/** The extension's own version, off the package.json in its pod. '' if it does not say. */
function versionFrom(packageJson) {
  try {
    return JSON.parse(packageJson || '{}').version || '';
  } catch (e) {
    return '';
  }
}

export default {
  name: 'BarnReviewQueue',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, STabs, SMenu, SModal, SField
  },

  mixins: [fullBleed],

  data() {
    const settings = readReviewSettings();

    return {
      rows:          [],
      tab:           'you',
      loading:       true,
      sort:          settings.sort,
      signedOffDays: settings.signedOffDays,
      showSettings:  false,
      // The modal's working copy. Nothing is applied until Save, so Cancel leaves the queue as
      // it was rather than half-changed behind the dialog.
      draft:         { ...settings },
    };
  },

  computed: {
    waitingOnYou() {
      return this.rows.filter((r) => r.changes > 0);
    },

    signedOff() {
      const span = this.signedOffDays * DAY;

      return this.rows.filter((r) => r.changes === 0 && r.committedAt && (Date.now() - r.committedAt) < span);
    },

    signedOffLabel() {
      if (this.signedOffDays === 7) {
        return 'Signed off this week';
      }

      return `Signed off in ${ this.signedOffDays } day${ this.signedOffDays === 1 ? '' : 's' }`;
    },

    tabs() {
      return [
        { id: 'you', label: 'Waiting on you', count: this.waitingOnYou.length },
        { id: 'signed', label: this.signedOffLabel, count: this.signedOff.length },
      ];
    },

    /**
     * The route names the template pushes to.
     *
     * A plain `<script>` block's module scope is not the render function's scope, so a
     * constant imported above and used bare in the template resolves to `undefined` and the
     * push is silently dropped. That is what the breadcrumb was doing. See the same computed
     * in files.vue.
     */
    routes() {
      return { STUDIO_ROUTE };
    },

    sortOptions() {
      // The chosen line is marked rather than hidden, so the menu is the same four lines every
      // time it opens and the current order is readable without closing it again.
      return SORTS.map((each) => ({
        ...each,
        note: each.id === this.sort ? [each.note, 'current'].filter(Boolean).join(' · ') : each.note,
      }));
    },

    sortLabel() {
      return (SORTS.find((each) => each.id === this.sort) || SORTS[0]).label;
    },

    draftSortOptions() {
      return SORTS.map((each) => ({
        ...each,
        note: each.id === this.draft.sort ? [each.note, 'current'].filter(Boolean).join(' · ') : each.note,
      }));
    },

    draftSortLabel() {
      return (SORTS.find((each) => each.id === this.draft.sort) || SORTS[0]).label;
    },

    shown() {
      const rows = this.tab === 'signed' ? this.signedOff : this.waitingOnYou;

      return this.inOrder(rows);
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;

      const summaries = await listExtensions().catch(() => []);

      this.rows = summaries.map((s) => {
        const existing = this.rows.find((r) => r.name === s.name);

        return {
          ...(existing || {}),
          name:    s.name,
          ready:   s.ready,
          changes: existing?.changes || 0,
        };
      });
      this.loading = false;

      await Promise.all(summaries.map((s) => this.enrich(s.name)));
    },

    /**
     * Fill in one row's readings.
     *
     * The row is re-found after the reads rather than held across them - see the same note in
     * the extensions list. A reference captured before an await survives a reload of `rows`
     * only as an orphan, and writes to it go nowhere visible.
     */
    async enrich(name) {
      const [detail, changes, files, brief, manifest, deferred] = await Promise.all([
        extensionDetail(name).catch(() => null),
        countChanges(name).catch(() => 0),
        changedFiles(name).catch(() => []),
        readExtensionFile(name, 'BRIEF.md').catch(() => ''),
        readExtensionFile(name, 'package.json').catch(() => ''),
        readDeferral(name).catch(() => null),
      ]);

      const row = this.rows.find((r) => r.name === name);

      if (!row) {
        return;
      }

      const risk = assessRisk(files);

      row.changes = changes;
      row.deferred = deferred;
      row.deferredLabel = deferred ? `Deferred ${ this.ago(deferred.at) }${ deferred.note ? ` - ${ deferred.note }` : '' }` : '';
      row.branch = detail?.branch || '';
      row.committedAt = detail?.lastChange ? Date.parse(detail.lastChange) || null : null;
      row.intent = intentFrom(brief);
      row.version = versionFrom(manifest);
      row.criteria = criteriaCount(brief);
      row.size = this.sizeOf(files, row.criteria);
      row.risk = risk.level;
      row.riskReason = risk.reason;
    },

    /**
     * The row's second-line counts (36:1086): how big the reading is.
     *
     * A row with nothing uncommitted says so rather than printing "0 files · +0 -0", and a
     * brief with no criteria leaves the criteria clause off rather than claiming zero of
     * something it never had.
     */
    sizeOf(files, criteria) {
      const clauses = [];

      if (files.length) {
        const added = files.reduce((n, f) => n + (f.added || 0), 0);
        const removed = files.reduce((n, f) => n + (f.removed || 0), 0);

        clauses.push(`${ files.length } file${ files.length === 1 ? '' : 's' }`);
        clauses.push(`+${ added } -${ removed }`);
      } else {
        clauses.push('nothing uncommitted');
      }

      if (criteria) {
        clauses.push(`${ criteria } acceptance criteri${ criteria === 1 ? 'on' : 'a' }`);
      }

      return clauses.join(' · ');
    },

    /** "8 minutes ago", for the deferral marker's tooltip. */
    ago(iso) {
      const then = Date.parse(iso);

      if (isNaN(then)) {
        return 'at an unknown time';
      }

      const mins = Math.max(0, Math.round((Date.now() - then) / 60000));

      if (mins < 1) {
        return 'just now';
      }

      if (mins < 60) {
        return `${ mins } minute${ mins === 1 ? '' : 's' } ago`;
      }

      const hours = Math.round(mins / 60);

      if (hours < 24) {
        return `${ hours } hour${ hours === 1 ? '' : 's' } ago`;
      }

      const days = Math.round(hours / 24);

      return `${ days } day${ days === 1 ? '' : 's' } ago`;
    },

    riskTone(risk) {
      return {
        high: 'error', medium: 'warning', low: 'success', none: 'default',
      }[risk] || 'default';
    },

    /**
     * The chosen order, over a copy.
     *
     * A row that has never been committed has no timestamp at all, and it goes last whichever
     * way the list is pointing - "unknown" is not older than everything or newer than
     * everything, and putting it at one end or the other depending on the direction would be
     * claiming one of those. Name breaks ties so the order does not shuffle between loads.
     */
    inOrder(rows) {
      const by = this.sort;

      return [...rows].sort((a, b) => {
        if (by === 'most' || by === 'least') {
          const d = (a.changes || 0) - (b.changes || 0);

          return (by === 'most' ? -d : d) || a.name.localeCompare(b.name);
        }

        if (!a.committedAt || !b.committedAt) {
          return (a.committedAt ? 0 : 1) - (b.committedAt ? 0 : 1) || a.name.localeCompare(b.name);
        }

        const d = a.committedAt - b.committedAt;

        return (by === 'newest' ? -d : d) || a.name.localeCompare(b.name);
      });
    },

    /** Reordering is a setting, not a mood: the queue opens the way you last left it. */
    chooseSort(id) {
      this.sort = id;
      this.draft = { ...this.draft, sort: id };
      this.persist();
    },

    persist() {
      writeReviewSettings({ sort: this.sort, signedOffDays: this.signedOffDays });
    },

    openSettings() {
      this.draft = { sort: this.sort, signedOffDays: this.signedOffDays };
      this.showSettings = true;
    },

    saveSettings() {
      const days = parseInt(this.draft.signedOffDays, 10);

      this.sort = this.draft.sort;
      this.signedOffDays = days > 0 ? Math.min(90, days) : DEFAULTS.signedOffDays;
      this.persist();
      this.showSettings = false;
    },

    open(row) {
      this.$router.push({
        name:   REVIEW_CHANGE_ROUTE,
        params: { extension: row.name, change: 'working' },
      });
    },
  },
};
</script>

<template>
  <div class="queue">
    <!-- masthead (36:1035) -->
    <div class="queue__masthead">
      <div class="queue__breadcrumb">
        <a class="queue__crumb" @click="$router.push({ name: routes.STUDIO_ROUTE })">Extensions</a>
        <SIcon name="chevronRight" :size="12" />
        <span class="queue__crumb-current">Reviews</span>
      </div>

      <div class="queue__title-row">
        <h1 class="queue__title">
          Reviews
        </h1>
        <span class="queue__grow" />

        <SMenu
          :items="sortOptions"
          aria-label="Sort the queue"
          class="queue__sort"
          @select="chooseSort"
        >
          <template #trigger>
            <SChip :label="sortLabel" icon="filter" />
            <SIcon name="chevronDown" :size="11" />
          </template>
        </SMenu>
        <SButton
          variant="neutral"
          icon="gear"
          data-testid="queue-review-settings"
          @click="openSettings"
        >
          Review settings
        </SButton>
      </div>

      <p class="queue__lede">
        Nothing in this list is live. Everything here is still running only in its author's
        preview, and you are both its author and its only reviewer, so nothing here is waiting
        on anybody else.
      </p>
    </div>

    <STabs
      v-model="tab"
      :tabs="tabs"
      variant="page"
      class="queue__tabs"
    />

    <!-- list (36:1075) -->
    <div class="queue__list">
      <SEmpty
        v-if="!loading && !shown.length && tab === 'you'"
        icon="check"
        title="Nothing is waiting on you"
        message="Every extension in this cluster matches its last commit. Changes show up here as soon as the assistant edits something."
      />

      <SEmpty
        v-else-if="!loading && !shown.length"
        icon="clock"
        :title="`Nothing signed off in the last ${ signedOffDays } day${ signedOffDays === 1 ? '' : 's' }`"
        message="Extensions committed inside that window appear here. Review settings changes how far back it reaches."
      />

      <div
        v-for="row in shown"
        :key="row.name"
        class="queue__card"
        @click="open(row)"
      >
        <div class="queue__card-body">
          <div class="queue__main">
            <!-- what the change is for, first (36:1079) -->
            <div v-if="row.intent" class="queue__row-title">
              {{ row.intent }}
            </div>
            <div v-else class="queue__row-title queue__no-brief">
              <SIcon name="alert" :size="15" />
              No brief - nobody wrote down what this is for.
            </div>

            <!-- then which extension it is (36:1084) and how big the reading is (36:1086) -->
            <div class="queue__ident">
              {{ row.name }}<span v-if="row.version"> · v{{ row.version }}</span>
            </div>

            <div class="queue__size">
              {{ row.size || '…' }}
            </div>
          </div>

          <div class="queue__col queue__col--risk">
            <span class="queue__label">Risk</span>
            <SChip :label="row.risk" :tone="riskTone(row.risk)" />
            <span class="queue__reason">{{ row.riskReason }}</span>
          </div>

          <div class="queue__col queue__col--who">
            <span class="queue__label">Branch</span>
            <span class="queue__value">{{ row.branch || '-' }}</span>
          </div>

          <div class="queue__action">
            <SChip
              v-if="row.deferred"
              label="Deferred"
              icon="clock"
              tone="warning"
              :title="row.deferredLabel"
            />
            <SBadge :status="row.changes ? 'unsaved' : 'live'" />
            <SButton
              variant="secondary"
              size="sm"
              :data-testid="`queue-review-${ row.name }`"
              @click.stop="open(row)"
            >
              Review
            </SButton>
          </div>
        </div>
      </div>

      <!-- foot note (36:1218) -->
      <div class="queue__footnote">
        <SIcon name="sparkle" :size="15" />
        <p class="queue__footnote-text">
          Rows lead with what the change is for, taken from its brief - not with a file count. A
          change with no brief says so, which is the point: a reviewer should never have to
          reverse-engineer intent from a diff.
        </p>
      </div>
    </div>

    <!--
      Review settings (36:1050). Two settings, both of which change what this screen shows and
      both of which survive a reload. The note says what is not configurable rather than
      leaving somebody hunting for it.
    -->
    <SModal
      v-if="showSettings"
      title="Review settings"
      icon="gear"
      :width="520"
      @close="showSettings = false"
    >
      <div class="queue__settings">
        <div class="queue__setting">
          <span class="queue__label">Order the queue by</span>
          <SMenu
            :items="draftSortOptions"
            aria-label="Default order for the queue"
            align="left"
            class="queue__sort"
            @select="draft = { ...draft, sort: $event }"
          >
            <template #trigger>
              <SChip :label="draftSortLabel" icon="filter" />
              <SIcon name="chevronDown" :size="11" />
            </template>
          </SMenu>
        </div>

        <SField
          :model-value="draft.signedOffDays"
          label="Count as signed off for"
          type="number"
          hint="Days. An extension whose last commit is inside this window shows in the second tab."
          data-testid="queue-signed-off-days"
          @update:model-value="draft = { ...draft, signedOffDays: $event }"
        />

        <p class="queue__settings-note">
          There is nothing here about who reviews what. This product has one reviewer - you -
          and a setting that could only ever have one value would be a control that lies.
        </p>
      </div>

      <template #footer>
        <SButton variant="ghost" @click="showSettings = false">
          Cancel
        </SButton>
        <SButton variant="primary" data-testid="queue-settings-save" @click="saveSettings">
          Save
        </SButton>
      </template>
    </SModal>
  </div>
</template>

<style lang="scss" scoped>
.queue {
  display:        flex;
  flex-direction: column;
  height:         100%;
  overflow-y:     auto;
  background:     var(--studio-surface);

  &__masthead {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    padding:        var(--studio-space-20) var(--studio-space-24) 0;
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

  &__crumb-current { font: var(--studio-caption-12); color: var(--studio-text-secondary); }

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

  // The chip is the trigger, so the button around it gives back its own padding and lets the
  // chip's own box be the control - otherwise the drawn chip sits inside a second, larger one.
  &__sort {
    :deep(.s-menu__trigger) {
      padding: 0 var(--studio-space-4) 0 0;
      gap:     var(--studio-space-4);
    }
  }

  &__lede {
    font:   var(--studio-body-14);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__list {
    display:        flex;
    flex-direction: column;
    gap:            10px;
    padding:        var(--studio-space-16) var(--studio-space-24) var(--studio-space-24);
  }

  &__card {
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    cursor:        pointer;

    &:hover { border-color: var(--studio-border-strong); }
  }

  &__card-body {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-16);
    padding:     14px 18px;
  }

  &__main {
    display:        flex;
    flex-direction: column;
    gap:            5px;
    flex:           1 1 auto;
    min-width:      0;
  }

  // The purpose sentence is the row's lede (36:1079), so it carries the row's weight. The name
  // is identification and sits under it - which is the way round the design draws it, and the
  // opposite of what this rendered.
  &__row-title {
    font:  var(--studio-heading-16);
    color: var(--studio-text);
  }

  &__ident {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  &__size {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  // A row with no brief has nothing to lead with, so the missing brief leads instead - at the
  // lede's own size, because it is the most important thing about the row.
  &__no-brief {
    display:     flex;
    align-items: center;
    gap:         6px;
    color:       var(--studio-warning);
  }

  &__col {
    display:        flex;
    flex-direction: column;
    align-items:    flex-start;
    // The columns share one baseline for their caps labels, which centring each column in the
    // row cannot give: the risk pill is taller than the text the other one carries, so a
    // centred RISK column sits its label above the other.
    align-self:     flex-start;
    gap:            5px;
    flex:           0 0 auto;

    &--risk { width: 200px; }
    &--who  { width: 110px; gap: var(--studio-space-4); }

    // The risk pill hugs its label (36:1096). Left to stretch it became a green band across
    // the column, and the extra height pushed the column's caps label off the baseline it
    // shares with BRANCH.
    :deep(.s-chip) { padding: 3px var(--studio-space-8); }
  }

  &__label {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__value {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  // The rating on its own says how much attention to give the row; this says what it read to
  // get there, which is the half a reviewer can argue with.
  &__reason {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__action {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex:        0 0 auto;
  }

  &__settings {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-16);
  }

  &__setting {
    display:        flex;
    flex-direction: column;
    align-items:    flex-start;
    gap:            var(--studio-space-8);
  }

  &__settings-note {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;
  }

  &__footnote {
    display:       flex;
    gap:           10px;
    padding:       11px 14px;
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    color:         var(--studio-info);
  }

  &__footnote-text {
    flex:   1 1 auto;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }
}
</style>
