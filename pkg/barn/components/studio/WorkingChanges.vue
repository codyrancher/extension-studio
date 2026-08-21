<script>
// The Changes tab: what is different in the pod's working tree right now.
//
// The design's changes summary (11:305) says "14 changes since v0.1.0" and offers Review; this
// is what Review opens. It is a real read - `git diff` in the pod, with untracked files folded
// in - rendered through the diff view this extension already had.
import { SButton, SEmpty, SIcon } from '../ui';
import DiffView from '../DiffView.vue';
import { workingDiff } from '../../extensions';

export default {
  name: 'WorkingChanges',

  components: {
    SButton, SEmpty, SIcon, DiffView
  },

  props: {
    extension: {
      type:     String,
      required: true,
    },

    /** Re-reads when this changes, so the parent can refresh on tab entry. */
    revision: {
      type:    Number,
      default: 0,
    },
  },

  data() {
    return {
      patch:   '',
      loading: true,
      error:   '',
    };
  },

  watch: {
    extension: 'load',
    revision:  'load',
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';

      try {
        this.patch = await workingDiff(this.extension);
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<template>
  <div class="working-changes">
    <div class="working-changes__bar">
      <span class="working-changes__title">Uncommitted changes</span>
      <span class="working-changes__grow" />
      <SButton
        variant="ghost"
        size="sm"
        icon="refresh"
        icon-only
        title="Re-read the working tree"
        @click="load"
      />
    </div>

    <div class="working-changes__body">
      <div v-if="loading" class="working-changes__loading">
        <SIcon name="spinner" :size="20" class="working-changes__spin" />
        Reading the working tree
      </div>

      <SEmpty
        v-else-if="error"
        icon="alert"
        title="Could not read the changes"
        :message="error"
      >
        <SButton variant="secondary" icon="refresh" @click="load">
          Try again
        </SButton>
      </SEmpty>

      <SEmpty
        v-else-if="!patch.trim()"
        icon="check"
        title="Nothing has changed"
        message="The working tree matches the last commit. Anything the assistant edits will show up here."
      />

      <DiffView v-else :patch="patch" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.working-changes {
  display:        flex;
  flex-direction: column;
  flex:           1 1 auto;
  min-height:     0;
  min-width:      0;

  &__bar {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) var(--studio-space-12);
    border-bottom: 1px solid var(--studio-border);
    flex:          0 0 auto;
  }

  &__title {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__grow { flex: 1 1 auto; }

  &__body {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
    overflow:   auto;

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

  &__spin { animation: wc-spin 0.9s linear infinite; }
}

@keyframes wc-spin {
  to { transform: rotate(360deg); }
}
</style>
