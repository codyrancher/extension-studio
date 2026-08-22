<script>
// Screen 11 · Review queue — what is waiting on you (Figma node 36:964).
//
// The queue is built from the cluster rather than from a review service, because there is no
// review service: an extension with uncommitted changes in its pod is a change waiting on
// somebody, and an extension whose last commit is recent is one that has been signed off. That
// is what the three tabs count.
//
// The footnote in the design states the rule this screen is built around - "rows lead with what
// the change is for, taken from its brief, not with a file count" - so each row's first line is
// the first heading-free line of BRIEF.md, and a change with no brief says so plainly rather
// than falling back to a diffstat.
//
// There used to be a third tab, "Waiting on others". It is gone: nothing in this product models
// a second reviewer, so it was a filter that could never match, carrying a hardcoded count of
// zero and an apology where its rows would be. What it was really saying - that you are both
// author and reviewer here - is a fact about the whole screen rather than about one filter, and
// the lede and every row's "Your part" column already say it.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, STabs, SMenu
} from '../components/ui';
import EditorSettingsModal from '../components/EditorSettingsModal.vue';
import {
  listExtensions, extensionDetail, readExtensionFile, countChanges, readDeferral
} from '../extensions';
import { STUDIO_ROUTE, REVIEW_CHANGE_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

const WEEK = 7 * 24 * 60 * 60 * 1000;

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

export default {
  name: 'BarnReviewQueue',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, STabs, SMenu, EditorSettingsModal
  },

  mixins: [fullBleed],

  data() {
    return {
      rows:    [],
      tab:     'you',
      loading: true,
      sort:    'oldest',
      showSettings: false,
    };
  },

  computed: {
    waitingOnYou() {
      return this.rows.filter((r) => r.changes > 0);
    },

    signedOff() {
      return this.rows.filter((r) => r.changes === 0 && r.committedAt && (Date.now() - r.committedAt) < WEEK);
    },

    tabs() {
      return [
        { id: 'you', label: 'Waiting on you', count: this.waitingOnYou.length },
        { id: 'signed', label: 'Signed off this week', count: this.signedOff.length },
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
      const [detail, changes, brief, deferred] = await Promise.all([
        extensionDetail(name).catch(() => null),
        countChanges(name).catch(() => 0),
        readExtensionFile(name, 'BRIEF.md').catch(() => ''),
        readDeferral(name).catch(() => null),
      ]);

      const row = this.rows.find((r) => r.name === name);

      if (!row) {
        return;
      }

      row.changes = changes;
      row.deferred = deferred;
      row.deferredLabel = deferred ? `Deferred ${ this.ago(deferred.at) }${ deferred.note ? ` — ${ deferred.note }` : '' }` : '';
      row.branch = detail?.branch || '';
      row.committedAt = detail?.lastChange ? Date.parse(detail.lastChange) || null : null;
      row.intent = this.intentFrom(brief);
      row.risk = this.riskOf(changes);
    },

    /**
     * The brief's first real sentence.
     *
     * Skips the title and the `## The problem` heading and takes the line under it, which is
     * the one sentence the brief exists to make somebody write.
     */
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

    intentFrom(brief) {
      if (!brief.trim()) {
        return '';
      }

      const lines = brief.split('\n').map((l) => l.trim());
      const at = lines.findIndex((l) => /^##\s+The problem/i.test(l));

      if (at >= 0) {
        const next = lines.slice(at + 1).find((l) => l && !l.startsWith('#'));

        if (next && next !== '_not stated_') {
          return next;
        }
      }

      return lines.find((l) => l && !l.startsWith('#') && l !== '_not stated_') || '';
    },

    riskOf(changes) {
      if (changes === 0) {
        return 'none';
      }

      return changes > 8 ? 'high' : (changes > 3 ? 'medium' : 'low');
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
          @select="sort = $event"
        >
          <template #trigger>
            <SChip :label="sortLabel" icon="filter" />
            <SIcon name="chevronDown" :size="11" />
          </template>
        </SMenu>
        <SButton variant="neutral" icon="gear" @click="showSettings = true">
          Review settings
        </SButton>
      </div>

      <p class="queue__lede">
        Nothing in this list is live. Everything here is still running only in its author's
        preview, and you are its only reviewer, so nothing here is waiting on anybody else.
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
        title="Nothing signed off this week"
        message="Extensions committed in the last seven days appear here."
      />

      <div
        v-for="row in shown"
        :key="row.name"
        class="queue__card"
        @click="open(row)"
      >
        <div class="queue__card-body">
          <div class="queue__main">
            <div class="queue__row-title">
              {{ row.name }}
            </div>
            <div v-if="row.intent" class="queue__intent">
              {{ row.intent }}
            </div>
            <div v-else class="queue__no-brief">
              <SIcon name="alert" :size="13" />
              No brief — nobody wrote down what this is for.
            </div>
          </div>

          <div class="queue__col queue__col--part">
            <span class="queue__label">Your part</span>
            <span class="queue__value">Author and reviewer</span>
          </div>

          <div class="queue__col queue__col--risk">
            <span class="queue__label">Risk</span>
            <SChip :label="row.risk" :tone="riskTone(row.risk)" />
          </div>

          <div class="queue__col queue__col--who">
            <span class="queue__label">Branch</span>
            <span class="queue__value">{{ row.branch || '—' }}</span>
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
            <SButton variant="secondary" size="sm" @click.stop="open(row)">
              Review
            </SButton>
          </div>
        </div>
      </div>

      <!-- foot note (36:1218) -->
      <div class="queue__footnote">
        <SIcon name="sparkle" :size="15" />
        <p class="queue__footnote-text">
          Rows lead with what the change is for, taken from its brief — not with a file count. A
          change with no brief says so, which is the point: a reviewer should never have to
          reverse-engineer intent from a diff.
        </p>
      </div>
    </div>

    <EditorSettingsModal v-if="showSettings" @close="showSettings = false" />
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
    gap:            6px;
    flex:           1 1 auto;
    min-width:      0;
  }

  &__row-title {
    font:  var(--studio-heading-16);
    color: var(--studio-text);
  }

  &__intent {
    font:  var(--studio-body-14);
    color: var(--studio-text-secondary);
  }

  &__no-brief {
    display:     flex;
    align-items: center;
    gap:         6px;
    font:        var(--studio-caption-12);
    color:       var(--studio-warning);
  }

  &__col {
    display:        flex;
    flex-direction: column;
    align-items:    flex-start;
    // The three columns share one baseline for their caps labels, which centring each
    // column in the row cannot give: the risk pill is taller than the text the other two
    // carry, so a centred RISK column sits its label above the other two.
    align-self:     flex-start;
    gap:            5px;
    flex:           0 0 auto;

    &--part { width: 150px; }
    &--risk { width: 200px; }
    &--who  { width: 110px; gap: var(--studio-space-4); }

    // The risk pill hugs its label (36:1096). Left to stretch it became a 200px green band
    // across the column, and the extra height pushed the column's caps label off the
    // baseline it shares with YOUR PART and BRANCH.
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

  &__action {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex:        0 0 auto;
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
