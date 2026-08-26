<script>
// The design's Labeled Input (Figma component set 4:23).
//
// Its description is the reason it is not a plain input with a label above it: "Rancher
// LabeledInput: label sits inside the field so the value never loses its name when the form
// scrolls." So the label is inside the bordered box, above the value, at Caption/12 - and the
// four states in the set are default, filled, focus (2px blue border) and error (red border
// plus a message underneath).
export default {
  name: 'SField',

  props: {
    modelValue: {
      type:    [String, Number],
      default: '',
    },

    label: {
      type:    String,
      default: '',
    },

    placeholder: {
      type:    String,
      default: '',
    },

    /** Renders a textarea instead. `rows` sets its height. */
    multiline: {
      type:    Boolean,
      default: false,
    },

    rows: {
      type:    Number,
      default: 3,
    },

    type: {
      type:    String,
      default: 'text',
    },

    /** The message under the field. Its presence is what puts the field in the error state. */
    error: {
      type:    String,
      default: '',
    },

    /** Sub-label under the field when there is no error. */
    hint: {
      type:    String,
      default: '',
    },

    disabled: {
      type:    Boolean,
      default: false,
    },

    autofocus: {
      type:    Boolean,
      default: false,
    },

    /**
     * A `data-testid` for the input itself.
     *
     * Needed because a `data-testid` written on this component falls through to its root, which
     * is the wrapper div and not the thing anybody types into. Automation that wants the control
     * has to be given the control.
     */
    inputTestid: {
      type:    String,
      default: '',
    },
  },

  emits: ['update:modelValue', 'enter', 'focus', 'blur'],

  data() {
    return { focused: false };
  },

  mounted() {
    if (this.autofocus) {
      this.$refs.input?.focus();
    }
  },

  methods: {
    onInput(e) {
      this.$emit('update:modelValue', e.target.value);
    },

    onFocus() {
      this.focused = true;
      this.$emit('focus');
    },

    onBlur() {
      this.focused = false;
      this.$emit('blur');
    },

    focus() {
      this.$refs.input?.focus();
    },
  },
};
</script>

<template>
  <div class="s-field" :class="{ 's-field--disabled': disabled }">
    <div
      class="s-field__box"
      :class="{
        's-field__box--focus': focused && !error,
        's-field__box--error': !!error,
      }"
      @click="focus"
    >
      <label v-if="label" class="s-field__label">{{ label }}</label>

      <textarea
        v-if="multiline"
        ref="input"
        class="s-field__input"
        :data-testid="inputTestid || null"
        :value="modelValue"
        :placeholder="placeholder"
        :rows="rows"
        :disabled="disabled"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
      />

      <input
        v-else
        ref="input"
        class="s-field__input"
        :data-testid="inputTestid || null"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keyup.enter="$emit('enter')"
      >
    </div>

    <div v-if="error" class="s-field__error">
      {{ error }}
    </div>
    <div v-else-if="hint" class="s-field__hint">
      {{ hint }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.s-field {
  display:        flex;
  flex-direction: column;
  gap:            var(--studio-space-4);
  width:          100%;

  &--disabled { opacity: 0.6; }

  &__box {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    padding:        var(--studio-space-8) var(--studio-space-12);
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius-control);
    cursor:         text;

    // The focus state is a 2px border in the set. Insetting a second ring rather than
    // growing the border keeps the field from shifting the layout by a pixel on focus.
    &--focus {
      border-color: var(--studio-border-focus);
      box-shadow:   inset 0 0 0 1px var(--studio-border-focus);
    }

    &--error { border-color: var(--studio-error); }
  }

  &__label {
    font:           var(--studio-caption-12);
    color:          var(--studio-text-secondary);
    cursor:         text;
    user-select:    none;
  }

  &__input {
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    font:       var(--studio-body-14);
    color:      var(--studio-text);
    width:      100%;
    resize:     vertical;

    &::placeholder { color: var(--studio-text-tertiary); }
  }

  &__error {
    font:  var(--studio-caption-12);
    color: var(--studio-error);
  }

  &__hint {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }
}
</style>
