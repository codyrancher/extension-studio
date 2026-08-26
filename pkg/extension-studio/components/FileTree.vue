<script>
// One directory of a file tree, and every directory under it.
//
// Recursive, which in a single-file component means the `name` above is load-bearing: it is how
// the template below resolves itself. Vue registers a component under its own name for exactly
// this, and without it the tree renders one level deep and silently stops.
//
// The shape is the one a pull request's file list uses, because that is the shape people already
// know how to read: a caret per directory, a click to fold it, one indent per level, and a
// directory with a single child folded into its parent so a path nobody branched at does not
// cost four rows to walk past.
export default {
  name: 'FileTree',

  props: {
    node: {
      type:     Object,
      required: true,
    },

    // The file currently open, so the row for it can say so.
    current: {
      type:    String,
      default: '',
    },

    // What git says about each path, keyed by path: 'new' | 'edited' | 'gone'. Optional and
    // empty by default, so a caller that has no git reading to hand renders exactly what it
    // rendered before this existed.
    marks: {
      type:    Object,
      default: () => ({}),
    },
  },

  emits: ['select'],

  data() {
    return {
      // Open by default. There are a handful of these files and the reason to look at the tree
      // at all is to see them; starting folded would mean clicking through to find that out.
      open: true,
    };
  },
};
</script>

<template>
  <div class="file-tree">
    <button
      type="button"
      class="file-tree__dir"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        class="file-tree__caret"
        :class="{ 'file-tree__caret--open': open }"
      >&#9656;</span>
      {{ node.name }}
    </button>

    <div
      v-if="open"
      class="file-tree__children"
    >
      <FileTree
        v-for="child in node.dirs"
        :key="child.path"
        :node="child"
        :current="current"
        :marks="marks"
        @select="$emit('select', $event)"
      />
      <button
        v-for="file in node.files"
        :key="file.path"
        type="button"
        class="file-tree__file"
        :class="{ 'file-tree__file--current': file.path === current }"
        @click="$emit('select', file.path)"
      >
        <span class="file-tree__name">{{ file.name }}</span>
        <span
          v-if="marks[file.path]"
          class="file-tree__mark"
          :class="`file-tree__mark--${ marks[file.path] }`"
        >{{ marks[file.path] }}</span>
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.file-tree {
  &__dir,
  &__file {
    display:     block;
    width:       100%;
    text-align:  left;
    // 22:972 / 22:977: the row is 5px above and below, 8px to the right and 6px to the left -
    // the same box the loose list on this screen draws, so a nested row and a top-level one
    // are on one pitch rather than two.
    padding:     5px var(--studio-space-8) 5px var(--studio-space-6);
    gap:         7px;
    border:      none;
    background:  none;
    cursor:      pointer;
    // One family for the whole list, which is Lato: 22:965 sets every row of the tree in
    // Body/13 Regular, folders and files alike, and the loose root files this tree is
    // interleaved with on screen 05 take Caption/12 from the same family. The files used to
    // carry `font-family: monospace` on the theory that a file is content and a folder is
    // structure, and the result was one list of file names in two typefaces - the root-level
    // ones in Lato, the ones a level down in mono, immediately below them.
    font:        var(--studio-caption-12);
    // Explicit, and `min-height` with it: the shell gives every button a minimum height for
    // touch targets, which is right for a form and turns a twenty-row tree into a scroll.
    line-height: 16px;
    min-height:  0;
    white-space: nowrap;
    overflow:    hidden;
    text-overflow: ellipsis;
    border-radius: var(--studio-radius-control);
  }

  // Muted, because a directory is the address of a file rather than a thing to open, and the
  // files are what the eye should land on.
  //
  // A flex row rather than the shared `display: block`, so the caret is centred against the
  // name instead of sitting on its baseline. An inline-block at a smaller font size aligns to
  // the baseline of the text beside it, which for a triangle glyph put it above the middle of
  // the row, and rotating it on open moved it again.
  &__dir {
    display:     flex;
    align-items: center;
    color:       var(--muted);
  }

  &__file {
    // The colour a link is, which is what these are: the tree is a list of things to open.
    color: var(--link);
    // A flex row so a change badge can sit at the right of the name. The padding above is
    // shared with the loose rows on screen 05 and is measured against the frame, so it stays.
    display:     flex;
    align-items: center;

    // A different colour from the selected row below, not the same one. They were both
    // --accent-btn, which meant the row under the pointer and the file actually open looked
    // identical and the tree appeared to select things it had not.
    &:hover {
      background: var(--nav-hover, var(--accent-btn));
    }

    &--current {
      background: var(--accent-btn);
      color:      var(--body-text);
      font-weight: 600;
    }
  }

  &__name {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
  }

  // 22:1000 "new" / 22:1013 "edited": which files differ from what this Rancher is running.
  &__mark {
    flex:           0 0 auto;
    padding:        0 5px;
    border-radius:  2px;
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    line-height:    15px;
    color:          var(--studio-on-status);
    background:     var(--studio-text-tertiary);

    &--new { background: var(--studio-success); }
    &--edited { background: var(--studio-warning); }
    &--gone { background: var(--studio-error); }
  }

  &__caret {
    flex:            0 0 12px;
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    // Its own line box, so the glyph is centred in the square rather than resting on the text's
    // baseline, and so the rotation below turns about the middle of that square.
    line-height:     1;
    font-size:       10px;
    color:           var(--muted);
    transition:      transform 100ms;

    &--open {
      transform: rotate(90deg);
    }
  }

  // One indent per level, applied by the nesting itself rather than by a depth prop, so a tree
  // of any depth is a tree of any depth.
  &__children {
    padding-left: 11px;
  }
}
</style>
