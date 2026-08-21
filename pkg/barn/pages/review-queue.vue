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
// Placeholder: "Waiting on others" (nothing here models a second reviewer), the sort control,
// and Review settings.
import {
  SButton, SBadge, SChip, SIcon, SEmpty, STabs
} from '../components/ui';
import { toastNotYet } from '../toast';
import {
  listExtensions, extensionDetail, readExtensionFile, countChanges
} from '../extensions';
import { STUDIO_ROUTE, REVIEW_CHANGE_ROUTE, EDITOR_ROUTE } from '../editor-product';
import '../design/tokens';

const WEEK = 7 * 24 * 60 * 60 * 1000;

export default {
  name: 'BarnReviewQueue',

  components: {
    SButton, SBadge, SChip, SIcon, SEmpty, STabs
  },

  data() {
    return {
      rows:    [],
      tab:     'you',
      loading: true,
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
        { id: 'others', label: 'Waiting on others', count: 0 },
        { id: 'signed', label: 'Signed off this week', count: this.signedOff.length },
      ];
    },

    shown() {
      if (this.tab === 'you') {
        return this.waitingOnYou;
      }

      return this.tab === 'signed' ? this.signedOff : [];
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;

      const summaries = await listExtensions().catch(() => []);

      this.rows = summaries.map((s) => ({
        name: s.name, ready: s.ready, changes: 0, intent: '', risk: '', committedAt: null,
      }));
      this.loading = false;

      await Promise.all(this.rows.map((row) => this.enrich(row)));
    },

    async enrich(row) {
      const [detail, changes, brief] = await Promise.all([
        extensionDetail(row.name).catch(() => null),
        countChanges(row.name).catch(() => 0),
        readExtensionFile(row.name, 'BRIEF.md').catch(() => ''),
      ]);

      row.changes = changes;
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

    open(row) {
      this.$router.push({
        name:   REVIEW_CHANGE_ROUTE,
        params: { extension: row.name, change: 'working' },
      });
    },

    notYet(what) {
      toastNotYet(this.$store, what);
    },
  },
};
</script>

<template>
  <div class="queue">
    <!-- masthead (36:1035) -->
    <div class="queue__masthead">
      <div class="queue__breadcrumb">
        <a class="queue__crumb" @click="$router.push({ name: STUDIO_ROUTE })">Extensions</a>
        <SIcon name="chevronRight" :size="12" />
        <span class="queue__crumb-current">Reviews</span>
      </div>

      <div class="queue__title-row">
        <h1 class="queue__title">
          Reviews
        </h1>
        <span class="queue__grow" />

        <SChip
          label="Oldest first"
          icon="filter"
          clickable
          @click="notYet('sorting the review queue')"
        />
        <SButton variant="neutral" icon="gear" @click="notYet('review settings')">
          Review settings
        </SButton>
      </div>

      <p class="queue__lede">
        Nothing in this list is live. Everything here is still running only in its author's
        preview.
      </p>
    </div>

    <STabs
      v-model="tab"
      :tabs="tabs"
      variant="panel"
      class="queue__tabs"
    />

    <!-- list (36:1075) -->
    <div class="queue__list">
      <SEmpty
        v-if="tab === 'others'"
        icon="user"
        title="Nothing is waiting on anybody else"
        message="This Studio has one reviewer — you. When a change can be handed to a second person, the ones you are waiting on appear here."
      />

      <SEmpty
        v-else-if="!loading && !shown.length && tab === 'you'"
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
            <SBadge :state="row.changes ? 'unsaved' : 'live'" />
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

  &__lede {
    font:   var(--studio-body-14);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__tabs { padding-top: 14px; }

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
    gap:            5px;
    flex:           0 0 auto;

    &--part { width: 150px; }
    &--risk { width: 200px; }
    &--who  { width: 110px; gap: var(--studio-space-4); }
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
