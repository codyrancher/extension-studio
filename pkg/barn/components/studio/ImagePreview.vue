<script>
// A screenshot, big enough to read, with pan and zoom.
//
// The composer's attachment chips name a file and nothing else, so the only way to check that
// the right picture went into the conversation was to remove it and paste again. A chip is now
// a button and this is what it opens.
//
// Zoom is kept on the wrapper as a transform rather than by resizing the image, because a
// transform is composited: dragging a 4K screenshot around stays smooth, and the browser never
// re-decodes the bitmap at a new size. `imageRendering: pixelated` past 1:1 is deliberate - a
// screenshot zoomed past its own resolution is being read for its pixels (which control is
// outlined, what the label says), and smoothing them is the opposite of what that wants.
import { SIcon, SButton } from '../ui';

/** Past this the picture is bigger than any screen and the controls stop helping. */
const MAX = 8;

/** Below this it is a thumbnail nobody can read. */
const MIN = 0.1;

export default {
  name: 'ImagePreview',

  components: { SIcon, SButton },

  props: {
    /** A data: URL. Empty while the bytes are still being read out of the pod. */
    src: {
      type:    String,
      default: '',
    },

    /** What to call it in the title row. */
    name: {
      type:    String,
      default: 'Screenshot',
    },

    /** Set while the pod is being read, so the shell can say so rather than show nothing. */
    loading: {
      type:    Boolean,
      default: false,
    },

    /** Why there is no picture, when there is no picture. */
    error: {
      type:    String,
      default: '',
    },
  },

  emits: ['close'],

  data() {
    return {
      scale: 1,
      x:     0,
      y:     0,
      // The pointer offset the drag started at, or null when nothing is being dragged.
      from:  null,
      // Set once the bitmap has decoded, so "fit" has a size to fit.
      ready: false,
    };
  },

  computed: {
    /** One transform, so a drag moves the picture in one composited step. */
    frameStyle() {
      return {
        transform: `translate(${ this.x }px, ${ this.y }px) scale(${ this.scale })`,
        cursor:    this.from ? 'grabbing' : 'grab',
      };
    },

    percent() {
      return `${ Math.round(this.scale * 100) }%`;
    },
  },

  watch: {
    // A different picture is a different view of it. Without this, opening a tall screenshot
    // after a wide one inherited the wide one's pan and opened on empty space.
    src() {
      this.reset();
    },
  },

  mounted() {
    document.addEventListener('keydown', this.onKey);
  },

  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
    this.endDrag();
  },

  methods: {
    reset() {
      this.scale = 1;
      this.x = 0;
      this.y = 0;
      this.ready = false;
    },

    clamp(value) {
      return Math.min(MAX, Math.max(MIN, value));
    },

    /**
     * Zoom about a point, so the pixel under the pointer stays under the pointer.
     *
     * Zooming about the centre instead is what makes a viewer feel like it is fighting you:
     * the thing being looked at slides away exactly when it is being magnified.
     */
    zoomAt(factor, clientX, clientY) {
      const box = this.$refs.stage?.getBoundingClientRect();

      if (!box) {
        return;
      }

      const next = this.clamp(this.scale * factor);
      const ratio = next / this.scale;

      // Where the pointer is relative to the stage's centre, which is what the translate is
      // measured from.
      const px = clientX - box.left - box.width / 2;
      const py = clientY - box.top - box.height / 2;

      this.x = px - (px - this.x) * ratio;
      this.y = py - (py - this.y) * ratio;
      this.scale = next;
    },

    onWheel(e) {
      e.preventDefault();

      // deltaY is lines in some browsers and pixels in others; only its sign is portable.
      this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    },

    step(factor) {
      const box = this.$refs.stage?.getBoundingClientRect();

      if (box) {
        this.zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2);
      }
    },

    startDrag(e) {
      // Left button only. A middle-click drag is the browser's own autoscroll and a right-click
      // is the context menu; hijacking either of them surprises people.
      if (e.button !== 0) {
        return;
      }

      e.preventDefault();
      this.from = {
        x: e.clientX - this.x, y: e.clientY - this.y,
      };
      // On the window rather than the element: a fast drag leaves the image behind and the
      // pointer keeps moving, and a listener on the image would stop tracking at the edge.
      window.addEventListener('pointermove', this.onDrag);
      window.addEventListener('pointerup', this.endDrag);
    },

    onDrag(e) {
      if (!this.from) {
        return;
      }

      this.x = e.clientX - this.from.x;
      this.y = e.clientY - this.from.y;
    },

    endDrag() {
      this.from = null;
      window.removeEventListener('pointermove', this.onDrag);
      window.removeEventListener('pointerup', this.endDrag);
    },

    /** Back to the size it opened at, which is the whole picture inside the stage. */
    fit() {
      this.scale = 1;
      this.x = 0;
      this.y = 0;
    },

    /**
     * One image pixel per screen pixel.
     *
     * `naturalWidth` against the width it is actually drawn at: the picture is laid out with
     * `max-width: 100%`, so a 2560px screenshot in a 900px stage is already at 0.35 and "100%"
     * has to mean that ratio undone rather than scale 1.
     */
    actual() {
      const img = this.$refs.image;

      if (!img?.naturalWidth || !img.clientWidth) {
        return;
      }

      this.scale = this.clamp(img.naturalWidth / img.clientWidth);
      this.x = 0;
      this.y = 0;
    },

    onKey(e) {
      if (e.key === 'Escape') {
        this.$emit('close');

        return;
      }

      if (e.key === '+' || e.key === '=') {
        this.step(1.25);
      } else if (e.key === '-' || e.key === '_') {
        this.step(1 / 1.25);
      } else if (e.key === '0') {
        this.fit();
      } else if (e.key === '1') {
        this.actual();
      }
    },
  },
};
</script>

<template>
  <div class="preview" @click.self="$emit('close')">
    <div class="preview__dialog">
      <div class="preview__head">
        <SIcon name="eye" :size="14" />
        <span class="preview__title">{{ name }}</span>

        <span class="preview__grow" />

        <span class="preview__zoom" data-testid="preview-zoom">{{ percent }}</span>
        <SButton
          variant="ghost"
          size="sm"
          icon="minus"
          icon-only
          title="Zoom out (-)"
          @click="step(1 / 1.25)"
        />
        <SButton
          variant="ghost"
          size="sm"
          icon="plus"
          icon-only
          title="Zoom in (+)"
          @click="step(1.25)"
        />
        <SButton variant="ghost" size="sm" title="Fit the whole picture (0)" @click="fit">
          Fit
        </SButton>
        <SButton variant="ghost" size="sm" title="One image pixel per screen pixel (1)" @click="actual">
          1:1
        </SButton>
        <SButton
          variant="ghost"
          size="sm"
          icon="close"
          icon-only
          title="Close (Esc)"
          data-testid="preview-close"
          @click="$emit('close')"
        />
      </div>

      <!--
        The stage clips; the frame inside it is what moves. Keeping the transform off the
        scrolling box means a pan never turns into a scroll of the dialog itself.
      -->
      <div
        ref="stage"
        class="preview__stage"
        data-testid="preview-stage"
        @wheel="onWheel"
        @pointerdown="startDrag"
        @dblclick="scale > 1 ? fit() : actual()"
      >
        <p v-if="error" class="preview__note">
          {{ error }}
        </p>
        <p v-else-if="loading || !src" class="preview__note">
          Reading the picture out of the pod.
        </p>
        <div v-else class="preview__frame" :style="frameStyle">
          <img
            ref="image"
            :src="src"
            :alt="name"
            class="preview__image"
            data-testid="preview-image"
            draggable="false"
            @load="ready = true"
          >
        </div>
      </div>

      <div class="preview__foot">
        Drag to pan · scroll to zoom · double-click to toggle · Esc to close
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.preview {
  position:        fixed;
  inset:           0;
  z-index:         100;
  display:         flex;
  align-items:     center;
  justify-content: center;
  padding:         32px;
  background:      rgb(0 0 0 / 55%);

  &__dialog {
    display:        flex;
    flex-direction: column;
    width:          min(1200px, 100%);
    height:         min(860px, 100%);
    min-height:     0;
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius-panel, 6px);
    background:     var(--studio-surface);
    overflow:       hidden;
  }

  &__head {
    display:       flex;
    align-items:   center;
    gap:           6px;
    padding:       8px 10px 8px 14px;
    border-bottom: 1px solid var(--studio-border);
  }

  &__title {
    font-weight:   600;
    font-size:     13px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__grow { flex: 1; }

  &__zoom {
    min-width:   44px;
    text-align:  right;
    font-family: var(--mono, monospace);
    font-size:   11px;
    color:       var(--muted);
  }

  &__stage {
    flex:            1;
    min-height:      0;
    display:         flex;
    align-items:     center;
    justify-content: center;
    overflow:        hidden;
    // A screenshot is usually pale, and a pale picture on a pale surface has no edge. This is
    // the one surface in the studio that is deliberately darker than the panel around it.
    background:      var(--studio-surface-terminal, #1B1C21);
    touch-action:    none;
  }

  &__frame {
    // The origin the translate in `frameStyle` is measured from.
    transform-origin: center center;
    will-change:      transform;
    line-height:      0;
  }

  &__image {
    display:         block;
    max-width:       100%;
    max-height:      100%;
    user-select:     none;
    -webkit-user-drag: none;
    image-rendering: pixelated;
  }

  &__note {
    margin:    0;
    padding:   24px;
    font-size: 12px;
    color:     var(--muted);
  }

  &__foot {
    padding:    8px 14px;
    border-top: 1px solid var(--studio-border);
    font-size:  11px;
    color:      var(--muted);
  }
}
</style>
