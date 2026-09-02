<script>
import { statPodPath, listPodDir, readPodFileBase64 } from '../extensions';

// What a browser can show inline. Anything else is named and sized rather than guessed at.
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const VIDEO = ['mp4', 'webm', 'mov', 'mkv'];
const AUDIO = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf',
};

/**
 * A file, or a directory, from inside the pod the terminal is attached to.
 *
 * Opened by clicking a path the session printed. A directory lists and can be walked, which is
 * what makes a printed output directory worth clicking at all.
 */
export default {
  name: 'PodFileViewer',

  props: {
    pod:  { type: String, required: true },
    path: { type: String, required: true },
  },

  emits: ['close'],

  data() {
    return {
      current: this.path, kind: '', size: 0, entries: [], text: '', dataUrl: '',
      loading: true, error: '', zoom: false,
    };
  },

  computed: {
    extension() {
      return (this.current.split('/').pop() || '').split('.').slice(1).pop()?.toLowerCase() || '';
    },
    isImage() {
      return IMAGE.includes(this.extension);
    },
    isVideo() {
      return VIDEO.includes(this.extension);
    },
    isAudio() {
      return AUDIO.includes(this.extension);
    },
    isPdf() {
      return this.extension === 'pdf';
    },
    parent() {
      const trimmed = this.current.replace(/\/+$/, '');
      const at = trimmed.lastIndexOf('/');

      return at > 0 ? trimmed.slice(0, at) : at === 0 ? '/' : '';
    },
    sizeDisplay() {
      if (this.size < 1024) {
        return `${ this.size } B`;
      }

      return this.size < 1024 * 1024 ? `${ Math.round(this.size / 1024) } KB` : `${ (this.size / 1024 / 1024).toFixed(1) } MB`;
    },
  },

  watch: {
    current: {
      immediate: true,
      handler() {
        this.load();
      },
    },
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';
      this.entries = [];
      this.text = '';
      this.dataUrl = '';
      this.zoom = false;

      try {
        const stat = await statPodPath(this.pod, this.current);

        this.kind = stat.kind;
        this.size = stat.size;

        if (stat.kind === 'none') {
          this.error = 'not readable from this pod';
        } else if (stat.kind === 'dir') {
          this.entries = await listPodDir(this.pod, this.current);
        } else {
          const base64 = await readPodFileBase64(this.pod, this.current);

          if (this.isImage || this.isVideo || this.isAudio || this.isPdf) {
            this.dataUrl = `data:${ MIME[this.extension] || 'application/octet-stream' };base64,${ base64 }`;
          } else {
            // Text is the fallback for anything without a media extension, because a file a
            // session printed the path of is far more often readable than not.
            this.text = decodeURIComponent(escape(atob(base64)));
          }
        }
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    open(entry) {
      this.current = `${ this.current.replace(/\/+$/, '') }/${ entry.name }`;
    },
  },
};
</script>

<template>
  <div
    class="pfv"
    @click.self="$emit('close')"
  >
    <div class="pfv__panel">
      <div class="pfv__head">
        <button
          v-if="parent"
          class="btn role-tertiary btn-sm"
          @click="current = parent"
        >
          <i class="icon icon-chevron-left" /> Up
        </button>
        <code class="pfv__path">{{ current }}</code>
        <span
          v-if="kind === 'file'"
          class="text-muted"
        >{{ sizeDisplay }}</span>
        <button
          class="btn role-tertiary btn-sm pfv__close"
          @click="$emit('close')"
        >
          <i class="icon icon-close" />
        </button>
      </div>

      <div class="pfv__body">
        <div v-if="loading">
          Loading&hellip;
        </div>
        <div
          v-else-if="error"
          class="text-error"
        >
          {{ error }}
        </div>

        <ul
          v-else-if="kind === 'dir'"
          class="pfv__list"
        >
          <li
            v-for="entry in entries"
            :key="entry.name"
          >
            <button
              class="pfv__entry"
              @click="open(entry)"
            >
              <i :class="entry.dir ? 'icon icon-folder' : 'icon icon-file'" />
              {{ entry.name }}
            </button>
          </li>
          <li v-if="!entries.length">
            <span class="text-muted">empty</span>
          </li>
        </ul>

        <img
          v-else-if="isImage"
          :src="dataUrl"
          :class="{ 'pfv__img--zoom': zoom }"
          class="pfv__img"
          @click="zoom = !zoom"
        >
        <video
          v-else-if="isVideo"
          :src="dataUrl"
          controls
          class="pfv__media"
        />
        <audio
          v-else-if="isAudio"
          :src="dataUrl"
          controls
          class="pfv__media"
        />
        <iframe
          v-else-if="isPdf"
          :src="dataUrl"
          class="pfv__pdf"
        />
        <pre
          v-else
          class="pfv__text"
        >{{ text }}</pre>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.pfv {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}

.pfv__panel {
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  width: min(1100px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}

.pfv__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.pfv__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pfv__close {
  flex: none;
}

.pfv__body {
  padding: 12px;
  overflow: auto;
}

.pfv__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pfv__entry {
  background: none;
  border: none;
  color: var(--link);
  cursor: pointer;
  padding: 4px 0;
  font-family: var(--font-family-mono);
}

.pfv__img {
  max-width: 100%;
  max-height: 72vh;
  cursor: zoom-in;
}

// Zoomed, the image is shown at its own size and the body scrolls to it, which is the whole
// point of opening a screenshot from a terminal - reading the small print in it.
.pfv__img--zoom {
  max-width: none;
  max-height: none;
  cursor: zoom-out;
}

.pfv__media {
  width: 100%;
}

.pfv__pdf {
  width: 100%;
  height: 72vh;
  border: none;
}

.pfv__text {
  margin: 0;
  white-space: pre;
  font-family: var(--font-family-mono);
  font-size: 12px;
}
</style>
