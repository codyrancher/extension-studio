<script>
// The Changes tab: the change sets this extension is made of, newest first.
//
// It used to be one `git diff` of the working tree. That answered "what is uncommitted right
// now", which after a finished turn is nothing at all - the assistant commits what it did, so
// the tab was empty exactly when somebody had just asked for something and wanted to see it.
//
// A change set here is a turn: the prompt somebody typed, the files it touched, and the commit
// it ended in. That is the unit the pod already records (pod/barn-provenance.mjs), and it is
// the unit a person thinks in - "the one where I asked for the heading" - rather than a range
// of commits they never chose.
//
// The rendering follows the change screen (38:1060): a rail of change sets on the left, and the
// selected one's evidence beside it, Before against After. The pictures are taken in the pod by
// the barn-screenshot skill it is given, so a change set carries what it looked like rather than
// only what it touched.
import {
  SButton, SEmpty, SIcon, SChip
} from '../ui';
import {
  workingDiff, assistantTurns, readExtensionFile, pushCaptureSetup,
  approvalState, approveUpTo, rejectAfter
} from '../../extensions';
import { toastSuccess, toastError } from '../../toast';
import { routesFromSource } from '../../extension-routes';
import { promptSaid, promptContextChips } from '../../prompt-context';
import { stickToBottom } from '../../stick-to-bottom';


export default {
  name: 'WorkingChanges',

  components: {
    SButton, SEmpty, SIcon, SChip
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

    /**
     * The route the preview is showing. Used only when it is already inside this extension -
     * see findRoute, which explains why the preview is the wrong default.
     */
    page: {
      type:    String,
      default: '',
    },
  },

  emits: ['update:selected', 'route', 'reverted', 'context'],

  data() {
    return {
      sets:     [],
      // The bottom-pinning handle for the rail. Not reactive: it holds DOM listeners.
      railPin:  null,
      // The element the handle above is bound to, so a re-render that replaces it is noticed.
      railEl:   null,
      patch:    '',
      selected: '',
      loading:  true,
      error:    '',
      /** How far review has got, and what is waiting. Read with the change sets. */
      approval: {
        sha: '', pending: [], clear: true,
      },
      /** The commit an approve or reject is running for, so its row can say so. */
      working:  '',
    };
  },

  computed: {
    /** The change set on screen, which is the newest until somebody picks another. */
    current() {
      // The last one, not the first: the rail runs oldest to newest now.
      return this.sets.find((set) => set.commit === this.selected) || this.sets[this.sets.length - 1] || null;
    },

    /** The commits waiting for review, as a set, for a per-row test that is not a scan. */
    pending() {
      return new Set(this.approval.pending.map((sha) => sha.slice(0, 40)));
    },


  },

  watch: {
    extension: 'load',
    revision:  'load',
    current:   {
      handler(set) {
        this.$emit('update:selected', set || null);
      },
      immediate: true,
    },
  },

  mounted() {
    // Not here: the rail is behind a `v-else` and does not exist while this is still loading,
    // so wiring it up at mount bound to nothing at all - a no-op handle that looked present
    // (it is an object) and never scrolled anything. It is wired the first time the element
    // is really there, in `load`.
    this.load();
  },

  beforeUnmount() {
    this.railPin?.stop();
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';

      try {
        // Both, because they answer different questions and a tab that showed only one of them
        // was wrong half the time: the change sets are what has been done, and the working diff
        // is what is in flight and belongs to nobody's turn yet.
        const [sets, patch, approval] = await Promise.all([
          assistantTurns(this.extension, 30).catch(() => []),
          workingDiff(this.extension).catch(() => ''),
          approvalState(this.extension).catch(() => ({
            sha: '', pending: [], clear: false, read: false,
          })),
        ]);

        // Oldest first, which is the order the conversation beside this reads in.
        //
        // `assistantTurns` answers newest first, because that is what a list of what happened
        // most recently wants. This is not that list: it is the same turns the Assistant tab
        // shows, and there they run down the page in the order they were asked, like any
        // conversation. Two panes about the same events running in opposite directions is the
        // sort of thing nobody reports and everybody misreads.
        this.sets = sets.filter((set) => set.commit).reverse();
        this.patch = patch;
        this.approval = approval;
        this.findRoute();

        if (!this.sets.some((set) => set.commit === this.selected)) {
          this.selected = this.sets[this.sets.length - 1]?.commit || '';
        }
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.loading = false;
      }

      // The newest change set is the last row now, so the end of the rail is where the thing
      // somebody just did is. Pinned rather than scrolled once: a row's chips wrap and its
      // bubble reflows after it first renders, and each of those makes the rail taller than it
      // was when the scroll ran.
      this.$nextTick(() => this.bindRail());

    },

    /**
     * Wire the rail to the bottom, once there is a rail.
     *
     * Called after every load rather than at mount, because until the first load answers there
     * is no element: the rail renders under a `v-else`, so at mount the ref is undefined and
     * anything wired to it is wired to nothing. Re-bound when the element itself changes,
     * which happens when the pane goes from its empty state to a list.
     */
    bindRail() {
      const el = this.$refs.rail;

      if (!el) {
        return;
      }

      if (this.railEl !== el) {
        this.railPin?.stop();
        this.railPin = stickToBottom(el);
        this.railEl = el;
      }

      this.railPin.pin();
    },

    select(set) {
      this.selected = set.commit;
    },

    /**
     * Which page a picture of this extension should be a picture of.
     *
     * Read out of the extension's own routing table rather than taken from the preview: the
     * preview is wherever somebody last navigated it, which is usually Rancher's home page, and
     * a change set photographed there shows a page the change had nothing to do with. That is
     * what the first working capture came back as.
     *
     * The preview's route is used only when it is already inside this extension, because then
     * it is a better answer than the extension's first route - it is the page being looked at.
     */
    async findRoute() {
      if (this.page && this.page.startsWith(`/${ this.extension }`)) {
        this.$emit('route', this.page);

        return;
      }

      const [routing, product] = await Promise.all([
        readExtensionFile(this.extension, 'routing/index.ts').catch(() => ''),
        readExtensionFile(this.extension, 'product.ts').catch(() => ''),
      ]);

      const first = routesFromSource(routing, product)[0];

      // No routing table this can read is not a reason to guess a path. The capture falls back
      // to the extension's root, which renders, rather than to a route that may 404.
      const route = first ? first.path.replace(/:cluster/g, 'local') : '/';

      this.$emit('route', route);

      // The pod takes the next turn's before shot the moment a prompt arrives, so what it needs
      // to do that has to be there before then rather than when somebody opens this tab. Best
      // effort: a change set with no picture says so, and nothing else depends on it.
      pushCaptureSetup(this.extension, route).catch(() => {});
    },

    /**
     * Accept this change set and everything under it.
     *
     * "And everything under it" is not a shortcut - it is what approving a linear history
     * means. A change set only makes sense on top of the ones before it, so approving the
     * third while the second is unreviewed would be approving something nobody has seen in
     * the state it will actually ship in.
     */
    async approve(set) {
      this.working = set.commit;

      try {
        await approveUpTo(this.extension, set.commit);
        toastSuccess(this.$store, `Reviewed up to ${ set.commit.slice(0, 7) }.`, { title: 'Approved' });
        await this.load();
      } catch (e) {
        toastError(this.$store, e?.message || String(e));
      } finally {
        this.working = '';
      }
    },

    /**
     * Undo everything newer than this change set.
     *
     * Reverted rather than rewritten, so the turns that made these changes keep their prompts
     * and their pictures. What is undone is the code; what happened is still on the record.
     */
    async reject(set) {
      this.working = set.commit;

      try {
        await rejectAfter(this.extension, set.commit);
        toastSuccess(this.$store, `Everything after ${ set.commit.slice(0, 7) } was reverted.`, { title: 'Rejected' });
        this.$emit('reverted');
        await this.load();
      } catch (e) {
        toastError(this.$store, e?.message || String(e));
      } finally {
        this.working = '';
      }
    },

    /**
     * The context the composer wrote onto a prompt, as the chips it was made from.
     *
     * `withContext` in the assistant panel writes `Context: a; b :: ` before what somebody
     * typed. The rail was showing that prefix as prose - "Context: the preview is on /...;
     * pkg/.../Home.vue (the p.base-home__stamp element)." - which is the product's own
     * plumbing quoted back as though a person had said it, and it buried the sentence they
     * actually wrote under it.
     *
     * The same facts are chips in the composer, so they are chips here: same shape, same
     * reading, and the prompt underneath is what was asked.
     */
    /** What it was made from, and what pressing it does. Same wording as the conversation. */
    chipTitle(chip) {
      const does = {
        page:    'Click to point the preview at this page',
        element: 'Click to outline this in the preview',
        image:   'Click to open this picture',
      }[chip.kind];

      return does ? `${ chip.title }\n${ does }` : chip.title;
    },

    /** The same glyph per kind the composer and the conversation use. */
    chipIcon(chip) {
      if (chip.kind === 'page') {
        return 'compare';
      }

      if (chip.kind === 'element') {
        return 'target';
      }

      return chip.kind === 'image' ? 'upload' : 'file';
    },

    /** The context the composer attached, as chips. See prompt-context.ts. */
    contextChips(text) {
      return promptContextChips(text);
    },

    /**
     * The prompt, whole.
     *
     * It used to be cut to 160 characters here, in the model, which meant the rest of the
     * sentence did not exist in the document at all - no amount of wrapping or widening the
     * pane could bring it back, and the selected row could not show what was actually asked.
     * The row is now given the entire prompt and the clamp is done in CSS, where it is a
     * number of lines rather than a number of characters and where selecting a row can undo
     * it. Newlines collapse to spaces so a pasted multi-line prompt stays one paragraph.
     */
    full(text) {
      // The context prefix comes off: it is drawn as chips above this, and leaving it in makes
      // every row open with the same paragraph.
      const said = promptSaid(text);

      return said.replace(/\s+/g, ' ').trim() || 'a prompt this pod did not record';
    },

    when(at) {
      if (!at) {
        return '';
      }

      const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));

      if (seconds < 60) {
        return `${ seconds }s ago`;
      }

      if (seconds < 3600) {
        return `${ Math.round(seconds / 60) }m ago`;
      }

      if (seconds < 86400) {
        return `${ Math.round(seconds / 3600) }h ago`;
      }

      // Past a day, the date - and the time with it, to the second.
      //
      // It was the date alone, so everything from yesterday read as one moment: a rail of
      // "2026-08-25" says nothing about which of those came first, which is the one thing the
      // order of the list is trying to tell you.
      return this.exact(at);
    },

    /** The whole moment, to the second, in the reader's own locale. */
    exact(at) {
      if (!at) {
        return '';
      }

      const when = new Date(at);

      if (Number.isNaN(when.getTime())) {
        return '';
      }

      const day = when.toLocaleDateString([], {
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const time = when.toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });

      return `${ day } ${ time }`;
    },
  },
};
</script>

<template>
  <div class="working-changes">
    <!--
      The header bar was here: the words "Change sets", the count, the review reading and a
      refresh button. Taken out. The tab this sits in is already called Changes and carries the
      count on its own badge, and the rail re-reads itself whenever the tab is opened - so the
      bar restated a title, repeated a number and offered a button for something that had
      already happened.
    -->

    <div v-if="error" class="working-changes__body">
      <SEmpty icon="alert" title="Could not read the changes" :detail="error" />
    </div>

    <div v-else-if="loading && !sets.length" class="working-changes__body">
      <SEmpty icon="clock" title="Reading the change sets" />
    </div>

    <div v-else-if="!sets.length" class="working-changes__body">
      <SEmpty
        icon="check"
        title="Nothing has been asked for yet"
        detail="Every turn the assistant finishes becomes a change set here: what was asked, what it touched, and what it looked like afterwards."
      />
    </div>

    <div v-else class="working-changes__split">
      <!-- The rail: one row per prompt (38:1131). -->
      <div ref="rail" class="working-changes__rail" data-testid="changes-rail">
        <!--
          The loop wraps both the row and its actions. It used to sit on the button alone, with
          the actions as a sibling after it - which put `set` out of scope in the sibling, threw
          on render, and blanked the whole tab rather than dropping the actions.
        -->
        <template v-for="(set, i) in sets" :key="set.commit">
        <div
          class="working-changes__card"
          :class="{
            'working-changes__card--on': current && set.commit === current.commit,
            'working-changes__card--alt': i % 2 === 1,
          }"
        >
        <button
          type="button"
          class="working-changes__set"
          :class="{ 'working-changes__set--on': current && set.commit === current.commit }"
          :data-testid="`changes-set-${ set.commit.slice(0, 7) }`"
          @click="select(set)"
        >
          <!-- What the composer attached, as the chips it was attached as. -->
          <span v-if="contextChips(set.prompt).length" class="working-changes__context">
            <!-- Same glyph per kind as the composer and the conversation. -->
            <SChip
              v-for="chip in contextChips(set.prompt)"
              :key="chip.title"
              :label="chip.label"
              :title="chipTitle(chip)"
              :icon="chipIcon(chip)"
              :clickable="chip.kind !== 'plain'"
              tone="subtle"
              @click.stop="$emit('context', chip)"
            />
          </span>

          <span
            class="working-changes__prompt"
            :class="{ 'working-changes__prompt--full': current && set.commit === current.commit }"
          >{{ full(set.prompt) }}</span>
          <span class="working-changes__meta">
            <SIcon name="file" :size="11" />
            {{ set.files.length }}
            <span class="working-changes__dot">·</span>
            <!--
              No author. Every change set in a pod is made by the one assistant on behalf of
              whoever asked, so the name was the same on every row and told nobody anything.
              It is still on the turn in the conversation, where the turns differ.
            -->
            <span :title="exact(set.endedAt || set.at)">{{ when(set.endedAt || set.at) }}</span>

            <!--
              Three states, not two.
              
              It was `pending ? "not reviewed" : "reviewed"`, and a read that failed produces an
              empty pending list - so every change set in the rail said "reviewed" the moment
              this could not find out, which is the one claim it must never make by accident.
            -->
            <span class="working-changes__dot">·</span>
            <span
              v-if="!approval.read"
              class="working-changes__state"
              title="The pod could not be asked what has been reviewed. Publishing stays blocked until it can."
            >review state unknown</span>
            <span
              v-else-if="pending.has(set.commit)"
              class="working-changes__state"
            >not reviewed</span>
            <span v-else class="working-changes__state working-changes__state--ok">
              <SIcon name="check" :size="11" /> reviewed
            </span>
          </span>
        </button>

        <!--
          The actions sit outside the row's own button rather than inside it: a button in a
          button is not a thing a browser will render, and approving is a different act from
          selecting, which is what the row does.
        -->
        <div
          v-if="approval.read && pending.has(set.commit)"
          class="working-changes__actions"
          :data-testid="`changes-actions-${ set.commit.slice(0, 7) }`"
        >
          <SButton
            variant="secondary"
            size="sm"
            icon="check"
            :loading="working === set.commit"
            :title="`Accept this change set and everything before it`"
            @click="approve(set)"
          >
            Approve
          </SButton>
          <!--
            Danger, not ghost. This reverts work, and it sits a few pixels from Approve - the
            two most similar-looking controls on the tab doing the most opposite things.
          -->
          <SButton
            variant="danger"
            size="sm"
            icon="undo"
            :disabled="working === set.commit"
            title="Revert everything newer than this change set"
            @click="reject(set)"
          >
            Reject newer
          </SButton>
        </div>
        </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.working-changes {
  display:        flex;
  flex-direction: column;
  min-height:     0;
  // The one that makes everything inside wrap. This is a flex item of the panel's
  // pane, and a flex item's `min-width` defaults to `auto` - its content width - so
  // without this the card refuses to shrink to its pane no matter what the rail and
  // the prompt say. The pane clips the overflow, which is why a long prompt looked
  // like it was "not wrapping": it had all the room it asked for, off the edge.
  min-width:      0;
  height:         100%;





  &__body {
    flex:    1;
    display: flex;
    padding: 24px;
  }

  &__split {
    flex:       1;
    display:    flex;
    min-height: 0;
    min-width:  0;
  }

  &__rail {
    flex:       1;
    min-width:  0;
    overflow-y: auto;
    // Never sideways. A prompt is prose: it wraps. A rail that scrolled
    // horizontally cut the front off every line - which is what "ome.vue only:"
    // was, the left-hand end of the sentence pushed out of view.
    overflow-x: hidden;
  }

  // A change set is drawn as the Assistant tab draws a turn: a bubble holding what was
  // said, and a quiet meta line under it. They are the same thing seen twice - a prompt
  // and what it did - and they were reading as two unrelated widgets.
  // One change set, one card.
  //
  // They used to be rows divided by a hairline, and a rail of them read as one column of text:
  // the next set's chips sat as close to this set's meta line as that meta line sat to its own
  // prompt, so nothing said where one ended.
  &__card {
    margin:        10px 12px;
    border:        0;
    border-radius: var(--studio-radius, 4px);
    // Raised, like a message in the conversation. These are the same turns seen twice, so they
    // are the same shape twice: a card sitting on the panel rather than a bordered rectangle
    // ruled off from its neighbours.
    background:    var(--studio-surface-raised);
    box-shadow:    var(--studio-raised-shadow);
    overflow:      hidden;
    transition:    box-shadow .12s ease, outline-color .12s ease;
    outline:       1px solid transparent;
    outline-offset: -1px;

    // Every other one set back instead of raised.
    //
    // A gap alone separates three cards; at twenty the eye needs somewhere to land, and
    // alternating between the two surfaces the rest of the Studio already uses is the answer
    // that needs no new colour: one sits on the panel, the next is cut into it.
    &--alt {
      background: var(--studio-surface-inset);
      box-shadow: var(--studio-inset-shadow);
    }

    // The selection reads the same on either stripe.
    &--alt.working-changes__card--on { outline-color: color-mix(in srgb, var(--primary) 55%, transparent); }

    // The one the pictures beside this belong to.
    //
    // A dashed line, and a muted one. It has been a solid accent border with a matching ring
    // outside it, which doubled the line and made the selected card read as a different and
    // heavier component rather than as the same card, chosen. Selection is not an alert: next
    // to twenty quiet cards it only has to be findable, and a dash is legible at a glance
    // while carrying none of the weight a solid accent line does.
    // The selection is an outline rather than a border, because the card no longer has one -
    // and an outline takes no space, so nothing shifts when it appears.
    &--on { outline-color: color-mix(in srgb, var(--primary) 55%, transparent); }
  }

  &__set {
    display:        flex;
    flex-direction: column;
    // The gap the Assistant tab puts between a turn's parts.
    gap:            6px;
    width:          100%;
    min-width:      0;
    // Both of these, and on the element that holds the text as well. This is a <button>,
    // and a button's UA style centres its content in every browser; one `text-align` on
    // the container is undone by anything that resets alignment further in.
    text-align:     left;
    align-items:    stretch;
    // A button's content does not wrap: the shell's button rules set `white-space: nowrap`
    // and white-space inherits, so the prompt inside was being laid out on one line however
    // wide that came out. `overflow-wrap` cannot override it - it decides where a break may
    // go, not whether breaking is allowed at all - which is why every wrap fix so far
    // changed nothing. This is the property that was actually in the way.
    white-space:    normal;
    padding:        10px 12px;
    background:     none;
    // No border and no left rail. The card around this draws the boundary and the selection
    // now; the row keeping its own divider and its 3px accent edge was the leftover that made
    // a selected card carry three separate marks saying the same thing.
    border:         0;
    cursor:         pointer;
    transition:     background .12s ease;

    &:hover {
      background: var(--studio-hover);

      .working-changes__prompt { border-color: var(--studio-border); }
    }

    &:focus-visible {
      outline:        2px solid var(--studio-border-focus, var(--outline));
      outline-offset: -2px;
    }

    &--on { background: var(--studio-selected, var(--studio-hover)); }
  }

  // The turn bubble (ActivityTurn's `__bubble`), so a prompt here looks like the same
  // prompt does in the conversation.
  &__prompt {
    display:        block;
    box-sizing:     border-box;
    width:          100%;
    max-width:      100%;
    text-align:     left;
    // Repeated on the element that holds the text, not only on the button, so a rule that
    // resets it further in cannot put it back.
    white-space:    normal;
    padding:        10px var(--studio-space-12);
    background:     var(--studio-surface-subtle);
    border:         1px solid var(--studio-border-subtle);
    border-radius:  var(--studio-radius);
    font:           var(--studio-body-14);
    color:          var(--studio-text);
    transition:     border-color .12s ease;
    // A long word - a path, a quoted selector - must break rather than widen the
    // row past the pane. Both properties: `overflow-wrap` is the one that is
    // supposed to do this, `word-break` is the one that actually stops the box
    // being sized by an unbreakable token.
    overflow-wrap:  anywhere;
    word-break:     break-word;
    // Prose, so it wraps; but an unselected row is a target to pick rather than
    // something to read, and one 300-word prompt would otherwise push every other
    // change set off the pane. Four lines, then an ellipsis drawn by the browser.
    display:            -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    overflow:           hidden;

    // The one being looked at is shown whole. This is what "see the complete
    // context" asks for: the clamp is a convenience for the rows nobody picked.
    &--full {
      -webkit-line-clamp: unset;
      display:            block;
      overflow:           visible;
    }
  }

  // The picked row's bubble takes the full border tier, so it reads as chosen rather than
  // only tinted.
  &__set--on &__prompt {
    border-color: var(--studio-border);
  }



  &__state {
    display:     inline-flex;
    align-items: center;
    gap:         3px;
    color:       var(--studio-warning);

    &--ok { color: var(--studio-text-tertiary); }
  }

  // Under the row, not inside it: a row is one button and these are two more.
  // Inside the card, so it needs no divider of its own.
  &__actions {
    display: flex;
    gap:     6px;
    padding: 0 12px 10px;
  }

  &__context {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;

    // Legible against whatever they sit on.
    //
    // They were quieted to stop them shouting over the message, and then the card underneath
    // them became a raised surface - against which a transparent chip with a blended border is
    // very nearly nothing at all. So they take a fill of their own: set into the card the way
    // the assistant's turn is set into the panel, which reads as a distinct thing on the card
    // without being louder than the words beside it.
    :deep(.s-chip) {
      max-width:    15rem;
      min-width:    0;
      border-color: var(--studio-border);
      background:   var(--studio-surface-inset);
      color:        var(--studio-text-secondary);
    }

    :deep(.s-chip:hover) {
      border-color: var(--studio-border-strong, var(--studio-border));
      color:        var(--studio-text);
    }

    :deep(.s-chip__label) {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      min-width:     0;
    }
  }




  &__meta {
    display:     flex;
    align-items: center;
    flex-wrap:   wrap;
    white-space: normal;
    text-align:  left;
    gap:         6px;
    font:        var(--studio-caption-12);
    color:       var(--studio-text-tertiary);
  }

  &__dot { opacity: .6; }

  &__detail {
    flex:           1;
    min-width:      0;
    overflow:       auto;
    display:        flex;
    flex-direction: column;
    gap:            12px;
    padding:        12px 16px;
  }

  &__panel-head {
    display:     flex;
    align-items: center;
    gap:         8px;
  }

  &__panel-title {
    font-weight: 600;
    font-size:   13px;
  }

  &__commit {
    font-family: var(--mono, monospace);
    font-size:   11px;
    color:       var(--muted);
  }

  &__shot {
    width:         100%;
    display:       block;
    border:        1px solid var(--studio-border);
    border-radius: 4px;
  }

  &__why {
    font-size: 12px;
    color:     var(--muted);
    margin:    0;
  }

  &__files {
    display:     flex;
    align-items: center;
    flex-wrap:   wrap;
    gap:         6px;
  }

  &__uncommitted {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    min-height:     0;
  }
}
</style>
