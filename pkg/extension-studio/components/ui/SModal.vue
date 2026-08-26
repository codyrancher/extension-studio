<script>
// The dialog shell: scrim, centred card, title row, body, footer actions.
//
// Screens 06a, 07 and 09 are dialogs in the file, and the three modals this extension already
// has (import, publish-to-GitHub, settings) each drew their own chrome slightly differently.
// This is that chrome once.
import SIcon from './SIcon.vue';
import SButton from './SButton.vue';

export default {
  name: 'SModal',

  components: { SIcon, SButton },

  props: {
    title: {
      type:    String,
      default: '',
    },

    icon: {
      type:    String,
      default: '',
    },

    /** Body width. The file's dialogs are 520 and 760. */
    width: {
      type:    [Number, String],
      default: 520,
    },

    /** Blocks the scrim click and hides the x, for a dialog mid-operation. */
    busy: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['close'],

  mounted() {
    document.addEventListener('keydown', this.onKey);
  },

  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
  },

  methods: {
    onKey(e) {
      if (e.key === 'Escape' && !this.busy) {
        this.$emit('close');
      }
    },

    onScrim() {
      if (!this.busy) {
        this.$emit('close');
      }
    },

    widthPx() {
      return typeof this.width === 'number' ? `${ this.width }px` : this.width;
    },
  },
};
</script>

<template>
  <div class="s-modal" @click.self="onScrim">
    <div class="s-modal__card" :style="{ width: widthPx() }">
      <div v-if="title || $slots.header" class="s-modal__head">
        <SIcon v-if="icon" :name="icon" :size="16" />
        <div class="s-modal__title">
          <slot name="header">{{ title }}</slot>
        </div>
        <SButton
          v-if="!busy"
          variant="ghost"
          size="sm"
          icon="close"
          icon-only
          @click="$emit('close')"
        />
      </div>

      <div class="s-modal__body">
        <slot />
      </div>

      <div v-if="$slots.footer" class="s-modal__foot">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.s-modal {
  position:        fixed;
  inset:           0;
  z-index:         1000;
  display:         flex;
  align-items:     center;
  justify-content: center;
  padding:         var(--studio-space-24);
  background:      rgba(0, 0, 0, 0.45);

  &__card {
    display:        flex;
    flex-direction: column;
    max-width:      100%;
    max-height:     100%;
    background:     var(--studio-surface);
    border-radius:  var(--studio-radius);
    box-shadow:     var(--studio-shadow-modal);
    overflow:       hidden;
  }

  &__head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-12) var(--studio-space-16);
    border-bottom: 1px solid var(--studio-border);
  }

  &__title {
    flex: 1 1 auto;
    font: var(--studio-heading-16);
    color: var(--studio-text);
  }

  &__body {
    padding:    var(--studio-space-16);
    overflow-y: auto;
    min-height: 0;
  }

  &__foot {
    display:         flex;
    align-items:     center;
    justify-content: flex-end;
    gap:             var(--studio-space-8);
    padding:         var(--studio-space-12) var(--studio-space-16);
    border-top:      1px solid var(--studio-border);
    background:      var(--studio-surface-subtle);
  }
}
</style>
