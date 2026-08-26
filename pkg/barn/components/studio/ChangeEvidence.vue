<script>
// What a change set looked like, before it and after it.
//
// It takes the right-hand pane on the Changes tab, where the live preview sits on every other
// tab. That is the point of it: the preview answers "what does this extension look like now",
// which on a tab about a particular change is the wrong question - the one being asked there is
// "what did *this* do", and that needs two pictures rather than one.
//
// Before is the build installed in this Rancher and After is the pod's dev server, the same
// reading the change screen uses (38:1354): the installed build is the only unchanged rendering
// of this extension that exists anywhere. Nothing published means no Before, and this says so
// rather than showing the same page twice with one of them captioned "before".
import { SIcon, SChip, SLabel } from '../ui';
import { changeSetShot } from '../../extensions';
import { regionsBetween } from '../../image-diff';
import { padded } from '../../change-regions';

/**
 * The geometry the capture records rectangles in now.
 *
 * Kept in step with GEOMETRY_VERSION in the barn-screenshot skill, which is the thing that
 * writes it. A change set stamped lower than this was measured by a version whose rectangles
 * are a header's height out, and is re-measured from its pictures instead.
 */
const GEOMETRY_VERSION = 2;

export default {
  name: 'ChangeEvidence',

  components: { SIcon, SChip, SLabel },

  props: {
    extension: {
      type:     String,
      required: true,
    },

    /** The change set on show, or null while the rail has nothing selected. */
    change: {
      type:    Object,
      default: null,
    },

    /** The route to photograph. The extension's own page, not whatever the preview last showed. */
    route: {
      type:    String,
      default: '',
    },
  },

  emits: ['use-region'],

  data() {
    return {
      /** Pictures by commit, so going back to one already taken is free. */
      shots:    {},
      shooting: '',
    };
  },

  computed: {
    shot() {
      return this.change ? this.shots[this.change.commit] || null : null;
    },

    /** The regions in paint order: biggest first, so the tightest is on top. See the template. */
    stackedRegions() {
      const regions = this.shot?.regions || [];

      return [...regions].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    },
  },

  watch: {
    change: {
      handler: 'shoot',
      immediate: true,
    },
    route: 'shoot',
  },

  methods: {
    /**
     * Take this change set's picture, once.
     *
     * Only the selected one, and only once: each picture is two page loads in the namespace's
     * browser, and shooting thirty change sets on opening a tab would be a stampede for
     * evidence nobody has asked to see.
     */
    /**
     * Where a region sits on the rendered picture, as percentages.
     *
     * The capture measured it in the pixels of the image; the pane draws that image at whatever
     * width it has. Percentages are the only placement that survives that, and they need the
     * size the picture was taken at - which is why the capture records it.
     */
    hotspotStyle(region) {
      const w = this.shot?.width || 0;
      const h = this.shot?.height || 0;

      if (!w || !h) {
        return { display: 'none' };
      }

      // The same rectangle the click will crop, so what is outlined is what arrives in the
      // conversation. See REGION_PAD.
      const box = padded(region, w, h);

      return {
        left:   `${ (box.x / w) * 100 }%`,
        top:    `${ (box.y / h) * 100 }%`,
        width:  `${ (box.width / w) * 100 }%`,
        height: `${ (box.height / h) * 100 }%`,
      };
    },

    /** The short name on the box: the element it came from, and how it was found. */
    regionTag(region) {
      const from = region.match || region.selector || '';
      // A path selector is spelled `body > div > p:nth-of-type(2)`; its last step is the part
      // that identifies the element, and the rest is how to reach it.
      const last = from.split('>').pop().trim();

      return region.kind ? `${ last } · ${ region.kind }` : last;
    },

    /** The whole of what is known about a box, for anyone hovering it. */
    regionTitle(region) {
      return [
        region.match || region.selector || 'an unnamed region',
        region.kind ? `Found because its ${ region.kind } changed.` : '',
        this.shot?.derived
          ? 'Measured by comparing the two pictures here.'
          : 'Measured in the page by the capture.',
        `${ Math.round(region.width) }x${ Math.round(region.height) } at ${ Math.round(region.x) },${ Math.round(region.y) } in a ${ this.shot?.width || '?' }x${ this.shot?.height || '?' } picture.`,
        'Click to put this part in the conversation.',
      ].filter(Boolean).join('\n');
    },

    async shoot() {
      const set = this.change;

      // The route arrives a moment after the change set does - it is read out of the
      // extension's routing table in the pod - and shooting before it lands photographs the
      // dashboard's home page instead of this extension's. Nothing to do until it is here;
      // the watcher fires again when it arrives.
      if (!set || !set.commit || !this.route || this.shots[set.commit] || this.shooting === set.commit) {
        return;
      }

      this.shooting = set.commit;

      const shot = await changeSetShot(this.extension, set.commit, this.route)
        .catch((e) => ({ image: '', why: e?.message || String(e) }));

      this.shots = { ...this.shots, [set.commit]: shot };
      this.shooting = '';

      this.findRegions(set.commit);
    },

    /**
     * Work out where the change is, here, from the two pictures.
     *
     * The capture records where it drew its outlines and the pane places hotspots on them -
     * but only for change sets whose capture found something to outline. A change that named
     * nothing (a computed property, a timestamp format, a deleted line) recorded no regions,
     * and a change set captured before the pod learned to compare its own pictures recorded
     * none either. Both cases are permanent from the pod's side: `changeSetShot` reads the
     * files a commit left behind and never re-shoots.
     *
     * The two pictures are here though, and comparing them is arithmetic. So when a change set
     * arrives with no regions, they are worked out in this browser instead - which fixes every
     * change set already recorded, rather than only the ones taken from now on.
     */
    async findRegions(commit) {
      const shot = this.shots[commit];

      if (!shot?.before || !shot?.after) {
        return;
      }

      // Recorded regions are kept only when the capture found the element by name AND measured
      // it the way the picture was actually taken.
      //
      // A region with a real selector behind it is exact - the capture asked the document where
      // that element was - and no comparison of pictures beats it. Two kinds are not exact and
      // are re-measured here instead:
      //
      //   `changed-pixels` is the pod's own comparison as it stood when that change set was
      //   committed, before boxes were snapped out to the block they sit in.
      //
      //   Anything stamped with a geometry older than this one was recorded as the element's
      //   box plus the header's height, on the assumption that padding the body pushes the page
      //   down by that much. This page's layout ignores it, so those rectangles sit a header
      //   below what they name. Re-shooting cannot repair them - the rendering they belong to
      //   is gone, and a fresh capture would photograph today's page against yesterday's prompt
      //   - but the two pictures are right, and measuring them again needs nothing from the pod.
      const recorded = shot.regions || [];
      const named = recorded.filter((r) => r.selector && r.selector !== 'changed-pixels');

      if (named.length && (shot.geometry || 0) >= GEOMETRY_VERSION) {
        return;
      }

      const found = await regionsBetween(shot.before, shot.after).catch(() => null);

      if (!found?.regions?.length || this.shots[commit] !== shot) {
        return;
      }

      this.shots = {
        ...this.shots,
        [commit]: {
          ...shot,
          regions: found.regions.map((r) => ({ ...r, selector: 'changed-pixels', label: 'changed here' })),
          width:   found.width,
          height:  found.height,
          derived: true,
        },
      };
    },
  },
};
</script>

<template>
  <div class="evidence">
    <div class="evidence__head">
      <SIcon name="eye" :size="14" />
      <span class="evidence__title">Before and after</span>
      <span class="evidence__grow" />
      <code v-if="change" class="evidence__commit">{{ change.commit.slice(0, 7) }}</code>
    </div>

    <div v-if="!change" class="evidence__note">
      Pick a change set to see what it did.
    </div>

    <template v-else>
      <!--
        The prompt was repeated here, under the heading. It is the first thing on the change
        set's own row a few centimetres to the left, and the row is what was clicked to get
        here - so this said it twice and pushed the pictures, which are the only thing this
        pane has that the rail does not, further down the page.
      -->

      <!--
        Two pictures, one after the other, rather than one image with both in it. A composed
        side-by-side is a layout baked into a PNG: unreadable at half the width, and stuck that
        way. Stacked, each is the full width of the pane and each carries its own caption.
      -->
      <figure v-if="shot && shot.before" class="evidence__panel">
        <figcaption class="evidence__caption">Before this prompt</figcaption>
        <img
          :src="shot.before"
          class="evidence__shot"
          :alt="`Before: ${ change.prompt }`"
          data-testid="evidence-before"
        >
      </figure>

      <figure v-if="shot && shot.after" class="evidence__panel">
        <figcaption class="evidence__caption">
          After it
          <span v-if="!shot.before" class="evidence__caption-why">· no Before recorded</span>
          <span v-else-if="shot.regions.length" class="evidence__caption-why">
            ·
            <template v-if="shot.derived">
              outlined by comparing the two pictures ·
            </template>
            click an outlined part to put it in the conversation
          </span>
        </figcaption>

        <!--
          The outlines are drawn into the picture, so the picture already shows where the change
          is. These sit on top of exactly the same rectangles and make them answer to a pointer:
          the capture wrote down where it drew each one, in the picture's own pixels, and they
          are placed as percentages so they stay put however the pane is sized.
        -->
        <div class="evidence__frame">
          <img
            :src="shot.after"
            class="evidence__shot"
            :alt="`After: ${ change.prompt }`"
            data-testid="evidence-after"
          >
          <!--
            Largest first, so the smallest ends up on top.
            
            These are absolutely positioned siblings with no z-index, so the last one painted is
            the one the pointer finds. `tightest` hands them over smallest-first, which put the
            child underneath the parent that contains it: hovering the changed word highlighted
            the block around it and clicking attached the block. Reversed here rather than in
            `tightest`, because the order that sorts them by significance and the order that
            stacks them are different questions - the list is still smallest-first everywhere
            else that reads it.
          -->
          <button
            v-for="(region, i) in stackedRegions"
            :key="`${ region.selector }-${ i }`"
            type="button"
            class="evidence__hotspot"
            :style="hotspotStyle(region)"
            :title="regionTitle(region)"
            :data-testid="`evidence-region-${ i }`"
            @click="$emit('use-region', { change, region, image: shot.after })"
          >
            <!--
              What this box is, on the box.
              
              It used to be in the `title` only, which meant the one question somebody asks of a
              highlight that looks wrong - "what did you think you were pointing at?" - could
              only be answered by hovering it. A box that names the element it came from is a
              box that can be argued with.
            -->
            <span class="evidence__hotspot-tag">{{ regionTag(region) }}</span>
          </button>
        </div>
      </figure>

      <p v-if="shot && shot.why" class="evidence__note" data-testid="evidence-why">
        {{ shot.why }}
      </p>
      <p v-if="!shot" class="evidence__note">
        Taking this change set's picture in the pod.
      </p>

      <div class="evidence__files">
        <SLabel text="Files" />
        <SChip
          v-for="file in change.files"
          :key="file"
          :label="file"
          icon="file"
          tone="subtle"
        />
        <span v-if="!change.files.length" class="evidence__note">
          This turn committed nothing that names a file.
        </span>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.evidence {
  display:        flex;
  flex-direction: column;
  gap:            12px;
  min-height:     0;
  // Same reason as WorkingChanges: a flex item defaults to min-width:auto, and this
  // holds pictures and file chips that are happy to be wider than the pane.
  min-width:      0;
  height:         100%;
  overflow:       auto;
  padding:        12px 16px;
  background:     var(--studio-surface);

  &__head {
    display:     flex;
    align-items: center;
    gap:         8px;
  }

  &__title {
    font-weight: 600;
    font-size:   13px;
  }

  &__grow { flex: 1; }

  &__commit {
    font-family: var(--mono, monospace);
    font-size:   11px;
    color:       var(--muted);
  }

  &__panel {
    margin:         0;
    display:        flex;
    flex-direction: column;
    gap:            4px;
  }

  &__caption {
    font-size:   11px;
    font-weight: 600;
    color:       var(--muted);
  }

  &__caption-why {
    font-weight: 400;
  }

  // The border lives on the frame rather than on the picture inside it. A border on
  // the image inset its content by 1px from the box the hotspots are positioned
  // against, so every outline sat a pixel up and to the left of the one drawn into
  // the picture. Bordering the frame makes its padding box exactly the image.
  &__frame {
    position:      relative;
    display:       block;
    border:        1px solid var(--studio-border);
    border-radius: 4px;
    overflow:      hidden;
    line-height:   0;
  }

  &__shot {
    width:         100%;
    display:       block;
    border:        1px solid var(--studio-border);
    border-radius: 4px;
  }

  // Inside a frame the frame already draws the border, so the picture must not draw
  // a second one inside it.
  &__frame &__shot {
    border:        0;
    border-radius: 0;
  }

  &__hotspot {
    position:      absolute;
    display:       flex;
    align-items:   flex-start;
    padding:       0;
    // Drawn, not transparent.
    //
    // These used to be invisible until hovered, on the argument that the picture already has
    // the outline drawn into it. That argument holds only while the capture managed to draw
    // one - and when it did not, the pane had the region recorded, knew exactly where the
    // change was, and showed a picture with nothing marked on it. A region this is sure
    // enough about to make clickable is a region worth drawing.
    border:        2px solid rgb(255 51 51 / 90%);
    border-radius: 3px;
    background:    rgb(255 51 51 / 10%);
    cursor:        pointer;

    &:hover,
    &:focus-visible {
      border-color: var(--primary);
      background:   rgb(48 186 120 / 18%);
    }
  }

  &__hotspot-tag {
    position:      absolute;
    top:           -1px;
    left:          -1px;
    transform:     translateY(-100%);
    max-width:     100%;
    padding:       1px 5px;
    border-radius: 3px 3px 0 0;
    background:    rgb(255 51 51 / 90%);
    color:         #fff;
    font:          600 10px/1.5 var(--studio-font, sans-serif);
    white-space:   nowrap;
    overflow:      hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  &__note {
    margin:    0;
    font-size: 12px;
    color:     var(--muted);
  }

  &__files {
    display:     flex;
    align-items: center;
    flex-wrap:   wrap;
    gap:         6px;
  }
}
</style>
