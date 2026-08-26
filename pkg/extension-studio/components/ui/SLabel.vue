<script>
// Caption/11 SemiBold Caps, which the file uses as the section label above every group.
//
// A component rather than a class because the tracking cannot ride in the `font:` shorthand,
// so every use would otherwise be two declarations that have to agree.
export default {
  name: 'SLabel',

  props: {
    text: {
      type:    String,
      default: '',
    },
  },
};
</script>

<template>
  <div class="s-label">
    <slot>{{ text }}</slot>
  </div>
</template>

<style lang="scss" scoped>
.s-label {
  font:           var(--studio-caption-11-caps);
  letter-spacing: var(--studio-tracking-caps);
  text-transform: uppercase;
  color:          var(--studio-text-tertiary);
}
</style>
