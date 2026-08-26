<script>
// The empty state. Not drawn in the file, which shows every screen full - which is exactly
// why it needs to exist here: a list with nothing in it is the first thing a real user sees,
// and the concept never accounts for it.
import SIcon from './SIcon.vue';

export default {
  name: 'SEmpty',

  components: { SIcon },

  props: {
    icon: {
      type:    String,
      default: 'puzzle',
    },

    title: {
      type:    String,
      default: '',
    },

    message: {
      type:    String,
      default: '',
    },
  },
};
</script>

<template>
  <div class="s-empty">
    <SIcon :name="icon" :size="28" class="s-empty__icon" />
    <div v-if="title" class="s-empty__title">
      {{ title }}
    </div>
    <div v-if="message" class="s-empty__message">
      {{ message }}
    </div>
    <div v-if="$slots.default" class="s-empty__actions">
      <slot />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.s-empty {
  display:         flex;
  flex-direction:  column;
  align-items:     center;
  justify-content: center;
  gap:             var(--studio-space-8);
  padding:         var(--studio-space-40) var(--studio-space-24);
  text-align:      center;
  flex:            1 1 auto;

  &__icon    { color: var(--studio-text-tertiary); opacity: 0.7; }
  &__title   { font: var(--studio-heading-16); color: var(--studio-text); }
  &__message { font: var(--studio-body-13); color: var(--studio-text-secondary); max-width: 42ch; }
  &__actions { margin-top: var(--studio-space-8); display: flex; gap: var(--studio-space-8); }
}
</style>
