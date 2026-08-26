<script>
// The Studio's split button: the design system's Button beside Rancher's dropdown trigger.
//
// The near half is `SButton`, so Publish is drawn to the same spec as every other control in
// the action bar. It used to be `RcButton size="small"`, which is Rancher's spec, and the two
// do not agree on height, padding, radius or type ramp - which is why Publish never quite
// lined up with the buttons next to it.
//
// The dropdown machinery below is still Rancher's, composed here rather than imported.
//
// The shell ships one - `@components/RcButtonSplit` - and this is its markup, its class names
// and its stylesheet copied across. What it is not is its `<script setup>`, and that is the
// whole reason this file exists: that component takes its props as a TypeScript type that
// spreads `IconProps` imported from `@components/RcButton/types`, and `@vue/compiler-sfc` has
// to resolve that import itself to turn the type into runtime props. It resolves it against a
// tsconfig beside the file being compiled, which for a component inside `node_modules/@rancher/
// shell` is the shell's own - never this package's - so the alias is unknown and the build
// stops at "Failed to resolve import source". Adding the alias to our tsconfig does not help,
// for the same reason.
//
// Everything underneath is the shell's and is imported normally: those are value imports,
// which webpack resolves with the alias it already has. So this is Rancher's split button in
// every respect a person can see, assembled one level down from the wrapper that cannot
// compile in an extension.
import { RcDropdown, RcDropdownItem, RcDropdownTrigger } from '@components/RcDropdown';
import { RcIcon } from '@components/RcIcon';
import SButton from './ui/SButton.vue';

export default {
  name: 'PublishSplit',

  components: {
    RcDropdown, RcDropdownItem, RcDropdownTrigger, RcIcon, SButton
  },

  props: {
    /** What the near half says, and does when pressed. */
    label: {
      type:     String,
      required: true,
    },

    /** `{ id, label }` per line in the dropdown. `select` carries the id back. */
    items: {
      type:    Array,
      default: () => [],
    },

    disabled: {
      type:    Boolean,
      default: false,
    },

    /** What the caret half is called for anyone not looking at it. */
    ariaLabelTrigger: {
      type:    String,
      default: 'More actions',
    },

    /** The glyph before the label. Button/Primary in the masthead draws icon/rocket (9:221). */
    icon: {
      type:    String,
      default: '',
    },
  },

  emits: ['click', 'select'],
};
</script>

<template>
  <RcDropdown placement="bottom-end">
    <div class="rc-button-split">
      <!--
        The test id lives here, on the button, not on the component.
        A `data-testid` set where this component is used falls through to its root - which is
        RcDropdown, a component that does not forward it - so it never reached the DOM at all.
        The publish button was unaddressable by automation, which is how a recording of the
        publish flow came to click nothing and wait quietly for a build that never started.
      -->
      <SButton
        class="rc-button-split-action"
        data-testid="barn-publish-button"
        variant="primary"
        size="sm"
        :icon="icon"
        :disabled="disabled"
        @click="$emit('click', $event)"
      >
        {{ label }}
      </SButton>

      <RcDropdownTrigger
        class="rc-button-split-trigger"
        variant="primary"
        size="small"
        :disabled="disabled"
        :aria-label="ariaLabelTrigger"
      >
        <RcIcon
          type="chevron-down"
          size="inherit"
        />
      </RcDropdownTrigger>
    </div>

    <template #dropdownCollection>
      <RcDropdownItem
        v-for="item in items"
        :key="item.id"
        @click="$emit('select', item.id)"
      >
        {{ item.label }}
      </RcDropdownItem>
    </template>
  </RcDropdown>
</template>

<style lang="scss" scoped>
// The two halves have to read as one control, and the near half is now the Studio's own button
// rather than Rancher's. That is the whole point of this block: `RcButton size="small"` brought
// Rancher's height, padding, radius and type ramp into a bar where every other control is drawn
// to the Figma file's Button (5px 11px, gap 7px, radius 4, Heading/14 SemiBold, icon 15), so
// Publish sat a few pixels short of "See what changed" and "Undo" beside it. The caret half is
// still RcDropdownTrigger, because the dropdown needs it, so it is matched to the near half here.
.rc-button-split {
  display:     inline-flex;
  align-items: stretch;

  // Round only the outer left edge of the main button.
  :deep(.rc-button-split-action) {
    border-top-right-radius:    0;
    border-bottom-right-radius: 0;
  }

  // The caret, brought onto the near half's metrics. Height rather than padding-block: the two
  // halves are different components and only a shared height keeps their edges flush.
  :deep(button.rc-button-split-trigger) {
    display:                   inline-flex;
    align-items:               center;
    justify-content:           center;
    min-width:                 unset;
    box-sizing:                border-box;
    // The shell's `button { min-height: 40px }` floors this half too - see the note in
    // SButton. Without it the caret stays 40px while the label half shrinks, and the split
    // button comes apart into two different-sized pieces.
    min-height:                var(--studio-control-sm, 30px);
    height:                    var(--studio-control-sm, 30px);
    padding:                   0 8px;
    border:                    1px solid transparent;
    border-top-left-radius:    0;
    border-bottom-left-radius: 0;
    border-radius:             0 var(--studio-radius) var(--studio-radius) 0;
    background:                var(--studio-green-500);
    color:                     var(--studio-text-inverse);
    font:                      var(--studio-heading-14);
    line-height:               1.4286;

    &:hover:not(:disabled)  { background: var(--studio-green-600); }
    &:active:not(:disabled) { background: var(--studio-green-700); }

    &:disabled {
      opacity: 0.5;
      cursor:  not-allowed;
    }
  }

  // The separator between the halves.
  :deep(button.rc-button-split-trigger) {
    border-left: 1px solid rgb(255 255 255 / 30%);
  }
}
</style>
