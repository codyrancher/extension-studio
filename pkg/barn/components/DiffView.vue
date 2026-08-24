<script>
// A unified diff, rendered the way a pull request renders one.
//
// The first version of this was `git show` in a `pre` with four colours on it, which is readable
// and is not what anybody means by a diff view: no line numbers, no file boundaries, and a
// header block of `index 4adc0ae..5c05c67 100644` at the top of every file that carries nothing
// for a person. So this parses the patch instead - files, then hunks, then lines - and renders
// what a reviewer expects: a bar per file, a gutter of old and new line numbers, and the two
// directions coloured across the whole row rather than only on the text.
//
// Unified by default, because side by side needs twice the width to say the same thing and
// this is a pane inside a dialog inside a pane. `mode="split"` is the other one: the design
// draws the layout as a named, changeable thing (14:433) rather than as a fact about the
// renderer, so the caller chooses and the reader can change their mind. See `rows()` for how a
// hunk's runs of removals and additions are paired into two columns.
//
// Two optional scoped slots, `hunk-head` and `hunk-foot`, put a caller's own row above and
// below each hunk's lines - which is how screen 12 hangs a provenance strip and a comment
// thread off a hunk without a second copy of this parser. Each is handed `{ file, hunk, index }`
// and renders nothing at all when the caller does not fill it, so every other caller of this
// component is unchanged.

// The token sheet, so this file's diff colours resolve whether or not the screen around it
// happens to have imported it.
import '../design/tokens';

/**
 * Split a patch into files, and each file into hunks.
 *
 * Deliberately tolerant about what it skips, and deliberately strict about what it keeps:
 * anything before the first `diff --git` is ignored, and inside a hunk only ' ', '+', '-' and
 * '\\' start a row. A line that is none of those is not a line of the diff - most often the
 * empty string `split('\n')` leaves on the end of every patch, which used to be kept as
 * context and drawn as a numbered but textless row. A patch that
 * confuses this should render as something slightly wrong rather than as nothing at all.
 */
function parsePatch(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of (patch || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      // `diff --git a/path b/path`, and the b-side is the one worth showing: for a rename it is
      // where the file ended up, and for everything else the two are the same.
      const match = line.match(/ b\/(.+)$/);

      file = { path: match ? match[1] : line.slice('diff --git '.length), hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }

    if (!file) {
      continue;
    }

    if (line.startsWith('@@')) {
      // `@@ -oldStart,oldCount +newStart,newCount @@ trailing context`
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);

      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[2]) : 0;
      hunk = { header: match ? match[3].trim() : '', lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    // Everything between the file header and the first hunk: `index`, `--- a/x`, `+++ b/x`,
    // `new file mode`, and so on. None of it is worth a row.
    if (!hunk) {
      continue;
    }

    if (line.startsWith('+')) {
      hunk.lines.push({
        kind: 'add', old: null, new: newNo++, text: line.slice(1)
      });
    } else if (line.startsWith('-')) {
      hunk.lines.push({
        kind: 'remove', old: oldNo++, new: null, text: line.slice(1)
      });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file", which belongs to the line before it.
      hunk.lines.push({
        kind: 'note', old: null, new: null, text: line.slice(2)
      });
    } else if (line.startsWith(' ')) {
      hunk.lines.push({
        kind: 'context', old: oldNo++, new: newNo++, text: line.slice(1)
      });
    }

    // Anything else is not a line of the diff. The one that matters is the empty string
    // `split('\n')` leaves on the end of every patch: it used to fall into the context branch
    // and be rendered as a numbered, textless row - and for a newly added file, whose hunk
    // header is `@@ -0,0 +1,n @@`, its old number was 0. That is the stray "0" that appeared
    // under the last line of the diff on the review screens.
  }

  return files;
}

export default {
  name: 'DiffView',

  props: {
    /** The output of `git show` or `git diff`. */
    patch: {
      type:    String,
      default: '',
    },

    /** Shown above the diff: the commit's own message, when there is one. */
    subject: {
      type:    String,
      default: '',
    },

    /** `unified` (one column, signed rows) or `split` (old on the left, new on the right). */
    mode: {
      type:      String,
      default:   'unified',
      validator: (v) => ['unified', 'split'].includes(v),
    },

    /**
     * Whether a line is something the caller wants pressed.
     *
     * Off by default, so every existing caller renders exactly what it did before. On, each
     * changed line becomes a button-shaped row - a pointer, a hover, a title - and emits
     * `line` with the parsed line and the hunk it is in. Only added and removed lines: a
     * context line is not part of the change and an affordance on it would promise something
     * about a line this patch did not touch.
     */
    linkLines: {
      type:    Boolean,
      default: false,
    },

    /** The new-file line number to mark as the one being looked at. Null for none. */
    activeLine: {
      type:    Number,
      default: null,
    },
  },

  emits: ['line'],

  computed: {
    files() {
      return parsePatch(this.patch);
    },

    split() {
      return this.mode === 'split';
    },

    /**
     * How wide a full-width row is, which differs between the two layouts.
     *
     * The hunk header and the two slot rows span the table, and a colspan that does not match
     * the number of columns is how a table quietly grows a fourth column of nothing.
     */
    cols() {
      return this.split ? 4 : 3;
    },

    /**
     * Added and removed across the whole patch.
     *
     * Counted here rather than read from `--stat`, so this component takes one input and the
     * caller does not have to pass a summary alongside the thing it summarises.
     */
    totals() {
      let added = 0;
      let removed = 0;

      for (const file of this.files) {
        for (const hunk of file.hunks) {
          for (const line of hunk.lines) {
            if (line.kind === 'add') {
              added++;
            } else if (line.kind === 'remove') {
              removed++;
            }
          }
        }
      }

      return { added, removed };
    },
  },

  methods: {
    counts(file) {
      let added = 0;
      let removed = 0;

      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === 'add') {
            added++;
          } else if (line.kind === 'remove') {
            removed++;
          }
        }
      }

      return { added, removed };
    },

    sign(kind) {
      return { add: '+', remove: '-' }[kind] || ' ';
    },

    /**
     * A hunk's lines as side-by-side pairs: what was there, and what is there now.
     *
     * A unified hunk is a sequence of runs - some context, then some removals, then some
     * additions, then more context - and a split view is that same sequence with each run of
     * removals sat beside the run of additions that replaced it. So this buffers the two runs
     * and flushes them together whenever the run ends, pairing them off by position and
     * padding the shorter side with blanks. Anything that is only on one side (a pure
     * deletion, a pure addition) gets a blank opposite it, which is exactly what makes the
     * shape of the change visible in this layout.
     *
     * "\ No newline at end of file" belongs to neither column, so it stays a full-width row.
     */
    rows(hunk) {
      const out = [];
      let removed = [];
      let added = [];

      const flush = () => {
        for (let i = 0; i < Math.max(removed.length, added.length); i++) {
          out.push({ left: removed[i] || null, right: added[i] || null, note: null });
        }

        removed = [];
        added = [];
      };

      for (const line of hunk.lines) {
        if (line.kind === 'remove') {
          removed.push(line);
        } else if (line.kind === 'add') {
          added.push(line);
        } else {
          flush();

          if (line.kind === 'note') {
            out.push({ left: null, right: null, note: line });
          } else {
            out.push({ left: line, right: line, note: null });
          }
        }
      }

      flush();

      return out;
    },

    /** The class for one side of a split row: its own kind, or an empty half. */
    sideClass(cell) {
      return `diff__row--${ cell ? cell.kind : 'blank' }`;
    },

    /** Whether this particular line is one the caller wants pressed. */
    pressable(line) {
      return this.linkLines && (line.kind === 'add' || line.kind === 'remove');
    },

    active(line) {
      return this.activeLine !== null && line.new === this.activeLine;
    },

    press(file, hunk, index, line) {
      if (!this.pressable(line)) {
        return;
      }

      this.$emit('line', {
        file, hunk, index, line,
      });
    },
  },
};
</script>

<template>
  <div class="diff">
    <div
      v-if="subject || files.length"
      class="diff__summary"
    >
      <span
        v-if="subject"
        class="diff__subject"
      >{{ subject }}</span>
      <span class="diff__counts">
        {{ files.length }} file{{ files.length === 1 ? '' : 's' }}
        <span class="diff__added">+{{ totals.added }}</span>
        <span class="diff__removed">&minus;{{ totals.removed }}</span>
      </span>
    </div>

    <div
      v-for="file in files"
      :key="file.path"
      class="diff__file"
    >
      <div class="diff__file-head">
        <span class="diff__path">{{ file.path }}</span>
        <span class="diff__added">+{{ counts(file).added }}</span>
        <span class="diff__removed">&minus;{{ counts(file).removed }}</span>
      </div>

      <table class="diff__table" :class="{ 'diff__table--split': split }">
        <tbody>
          <template
            v-for="(hunk, h) in file.hunks"
            :key="h"
          >
            <tr class="diff__hunk">
              <td
                class="diff__gutter"
                :colspan="split ? 1 : 2"
              />
              <td class="diff__hunk-head" :colspan="cols - 1">
                {{ hunk.header || '…' }}
              </td>
            </tr>
            <tr v-if="$slots['hunk-head']" class="diff__aside">
              <td :colspan="cols" class="diff__aside-cell">
                <slot name="hunk-head" :file="file" :hunk="hunk" :index="h" />
              </td>
            </tr>

            <!-- side by side: the run that went, beside the run that replaced it -->
            <template v-if="split">
              <tr
                v-for="(row, r) in rows(hunk)"
                :key="`s${ h }-${ r }`"
                class="diff__row"
              >
                <td v-if="row.note" class="diff__code diff__row--note" :colspan="cols">{{ row.note.text }}</td>
                <template v-else>
                  <td class="diff__gutter" :class="sideClass(row.left)">
                    {{ row.left?.old ?? '' }}
                  </td>
                  <td class="diff__code" :class="sideClass(row.left)"><span class="diff__sign">{{ row.left ? sign(row.left.kind) : ' ' }}</span>{{ row.left?.text ?? '' }}</td>
                  <td class="diff__gutter diff__gutter--right" :class="sideClass(row.right)">
                    {{ row.right?.new ?? '' }}
                  </td>
                  <td class="diff__code" :class="sideClass(row.right)"><span class="diff__sign">{{ row.right ? sign(row.right.kind) : ' ' }}</span>{{ row.right?.text ?? '' }}</td>
                </template>
              </tr>
            </template>

            <!-- unified: one column, the two directions coloured across the whole row -->
            <tr
              v-for="(line, l) in (split ? [] : hunk.lines)"
              :key="`${ h }-${ l }`"
              :class="[
                `diff__row diff__row--${ line.kind }`,
                { 'diff__row--pressable': pressable(line), 'diff__row--active': active(line) },
              ]"
              :title="pressable(line) ? 'See what this line changes in the rendered result' : null"
              @click="press(file, hunk, h, line)"
            >
              <td class="diff__gutter">
                {{ line.old ?? '' }}
              </td>
              <td class="diff__gutter">
                {{ line.new ?? '' }}
              </td>
              <td class="diff__code"><span class="diff__sign">{{ sign(line.kind) }}</span>{{ line.text }}</td>
            </tr>
            <tr v-if="$slots['hunk-foot']" class="diff__aside">
              <td :colspan="cols" class="diff__aside-cell">
                <slot name="hunk-foot" :file="file" :hunk="hunk" :index="h" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div
      v-if="!files.length"
      class="text-muted"
    >
      Nothing to show.
    </div>
  </div>
</template>

<style lang="scss" scoped>
.diff {
  font-family: monospace;
  font-size:   12px;

  &__summary {
    display:       flex;
    align-items:   baseline;
    gap:           10px;
    margin-bottom: 10px;
  }

  &__subject {
    // The commit's own words, so not the code font.
    font-family: inherit;
    font-weight: 600;
  }

  &__counts {
    margin-left: auto;
    color:       var(--muted);
    white-space: nowrap;
  }

  &__added {
    color: var(--success);
  }

  &__removed {
    color: var(--error);
  }

  // A caller's own row above or below a hunk (see the slots at the top). The cell gives the
  // slot the full width and gets out of the way; the wrapping is undone because slot content
  // is prose, not code, and the caller sets its own font on what it puts in here.
  &__aside > &__aside-cell {
    padding:     0;
    white-space: normal;
  }

  &__file {
    margin-bottom: 14px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    overflow:      hidden;
  }

  &__file-head {
    display:       flex;
    align-items:   center;
    gap:           8px;
    padding:       5px 10px;
    background:    var(--accent-btn);
    border-bottom: 1px solid var(--border);
  }

  &__path {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    font-weight:   600;
  }

  &__table {
    width:           100%;
    border-collapse: collapse;
    table-layout:    auto;
  }

  &__row,
  &__hunk {
    line-height: 18px;
  }

  // The numbers, which are chrome: fixed width, unselectable, so copying a diff copies the code
  // and not a column of integers down the left of it.
  &__gutter {
    width:         1%;
    padding:       0 8px;
    text-align:    right;
    color:         var(--muted);
    background:    var(--body-bg);
    border-right:  1px solid var(--border);
    user-select:   none;
    white-space:   nowrap;
    vertical-align: top;
  }

  &__code {
    padding:     0 10px 0 4px;
    white-space: pre-wrap;
    word-break:  break-word;
  }

  &__sign {
    display:     inline-block;
    width:       1ch;
    margin-right: 4px;
    color:       var(--muted);
    user-select: none;
  }

  &__hunk-head {
    padding:    0 10px;
    color:      var(--primary);
    background: var(--body-bg);
  }

  // The whole row, not just the text: it is the shape of the change that is read first.
  //
  // The tokens rather than literals: studio.css already carries diff/added-bg and
  // diff/removed-bg from Foundations, with dark-theme values, and these two hand-rolled
  // rgba() greens bypassed both - so the design's diff colours were not the ones on screen
  // and they did not follow the theme.
  &__row--add {
    background: var(--studio-diff-added-bg);
  }

  &__row--remove {
    background: var(--studio-diff-removed-bg);
  }

  &__row--note {
    color: var(--muted);
  }

  // A line the caller has made pressable (see `linkLines`). The affordance is on the row and not
  // on a control inside it, because the thing being pressed is the line.
  &__row--pressable {
    cursor: pointer;

    &:hover {
      outline:        1px solid var(--studio-accent-text);
      outline-offset: -1px;
    }
  }

  &__row--active {
    outline:        2px solid var(--studio-accent-text);
    outline-offset: -2px;
  }

  // Side by side. The colour moves off the row and onto the cell, because in this layout the
  // two halves of one row are a removal and an addition and they are not the same colour. A
  // half with nothing opposite it is shaded as absent rather than left white, so a pure
  // addition reads as an addition and not as a line that failed to render.
  &__table--split {
    table-layout: fixed;

    .diff__code {
      width:     50%;
      max-width: 0;
    }

    .diff__gutter--right {
      border-left: 1px solid var(--border);
    }

    .diff__row--add    { background: var(--studio-diff-added-bg); }
    .diff__row--remove { background: var(--studio-diff-removed-bg); }
    .diff__row--blank  { background: var(--studio-surface-subtle); }
  }
}
</style>
