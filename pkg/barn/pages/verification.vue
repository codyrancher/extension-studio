<script>
// Screen 13 · Verification — does it actually do the job? (Figma node 39:1109).
//
// The last screen in the review sequence, and the one that closes the loop the brief opened:
// the brief's acceptance criteria on the left, the running extension on the right, and a
// decision per criterion taken while looking at both.
//
// Real. The criteria are read out of BRIEF.md - the same file screen 10 wrote - so this is
// literally the checklist the author agreed to before any code existed. The preview is the
// extension's own dev server. The result is written back into the brief as ticked checkboxes
// and a verification block, so it lands in the repository next to the code rather than in a
// database this product does not have.
//
// Placeholder. Anything that would need the assistant to drive the preview itself: there is no
// automated check here, and the screen does not pretend otherwise - a person looks and says.
import {
  SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SBadge
} from '../components/ui';
import PreviewPanel from '../components/studio/PreviewPanel.vue';
import { toastNotYet, toastSuccess, toastError } from '../toast';
import {
  readExtensionFile, writeExtensionFile, extensionUrl, extensionReady, DEFAULT_EXTENSION
} from '../extensions';
import { REVIEW_QUEUE_ROUTE, BRIEF_ROUTE, EDITOR_ROUTE } from '../editor-product';
import '../design/tokens';
import fullBleed from '../design/full-bleed';

// The three segments of the verdict control (39:1232), in the order the design draws them.
// "Can't tell" is the resting state rather than a fourth thing: a criterion nobody has
// looked at yet and one somebody looked at and could not decide are the same criterion as
// far as the sign-off is concerned, so both are the empty verdict.
const VERDICTS = [
  { id: 'pass', label: 'Yes' },
  { id: 'fail', label: 'No' },
  { id: '', label: `Can't tell` },
];

export default {
  name: 'BarnVerification',

  components: {
    SButton, SChip, SIcon, SEmpty, SBanner, SLabel, SBadge, PreviewPanel
  },

  mixins: [fullBleed],

  data() {
    return {
      brief:      '',
      criteria:   [],
      previewUrl: '',
      problem:    '',
      loading:    true,
      saving:     false,
      notes:      '',
      VERDICTS,
    };
  },

  computed: {
    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },

    passed() {
      return this.criteria.filter((c) => c.verdict === 'pass').length;
    },

    failed() {
      return this.criteria.filter((c) => c.verdict === 'fail').length;
    },

    undecided() {
      return this.criteria.filter((c) => !c.verdict).length;
    },

    verdict() {
      if (!this.criteria.length) {
        return 'none';
      }

      if (this.failed) {
        return 'fail';
      }

      return this.undecided ? 'partial' : 'pass';
    },

    verdictBadge() {
      return {
        pass: 'live', fail: 'failed', partial: 'building', none: 'draft',
      }[this.verdict];
    },

    verdictLabel() {
      return {
        pass:    'Every criterion checked',
        fail:    `${ this.failed } not met`,
        partial: `${ this.undecided } still to check`,
        none:    'No criteria',
      }[this.verdict];
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;

      this.brief = await readExtensionFile(this.extension, 'BRIEF.md').catch(() => '');
      this.criteria = this.criteriaFrom(this.brief);
      this.problem = this.sectionOf(this.brief, 'The problem');
      this.loading = false;

      if (await extensionReady(this.extension).catch(() => false)) {
        this.previewUrl = extensionUrl(this.extension);
      }
    },

    /** The `- [ ]` lines under "How we will know it worked". */
    criteriaFrom(brief) {
      const body = this.sectionOf(brief, 'How we will know it worked');

      return body.split('\n')
        .map((l) => l.trim())
        .filter((l) => /^- \[[ xX]\]/.test(l))
        .map((l) => ({
          text:    l.replace(/^- \[[ xX]\]\s*/, ''),
          // A brief written before verification has everything unticked; one verified before
          // keeps what it was given, so re-opening this screen does not lose the last pass.
          verdict: /^- \[[xX]\]/.test(l) ? 'pass' : '',
        }));
    },

    sectionOf(brief, title) {
      const lines = brief.split('\n');
      const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${ title.toLowerCase() }`);

      if (at < 0) {
        return '';
      }

      const rest = lines.slice(at + 1);
      const end = rest.findIndex((l) => l.trim().startsWith('##') || l.trim() === '---');

      return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
    },

    set(criterion, verdict) {
      criterion.verdict = verdict;
    },

    /**
     * Write the verdict back into the brief.
     *
     * The ticked boxes go back into the same `- [ ]` lines they came out of, and a Verification
     * section is appended (or replaced) underneath. That means the record of whether this thing
     * did its job lives in the repository, in the file that said what the job was.
     */
    async save() {
      this.saving = true;

      try {
        let out = this.brief;
        let i = 0;

        out = out.split('\n').map((line) => {
          if (!/^\s*- \[[ xX]\]/.test(line)) {
            return line;
          }

          const c = this.criteria[i++];

          if (!c) {
            return line;
          }

          return line.replace(/- \[[ xX]\]/, c.verdict === 'pass' ? '- [x]' : '- [ ]');
        }).join('\n');

        // Replace a previous verification block rather than stacking them up.
        out = out.replace(/\n## Verification[\s\S]*$/, '').trimEnd();

        const block = [
          '',
          '',
          '## Verification',
          '',
          `Verdict: **${ this.verdictLabel }**`,
          `Passed ${ this.passed } of ${ this.criteria.length }.`,
        ];

        if (this.notes.trim()) {
          block.push('', this.notes.trim());
        }

        await writeExtensionFile(this.extension, 'BRIEF.md', out + block.join('\n') + '\n');
        toastSuccess(this.$store, 'Verification recorded', 'Written into BRIEF.md.');
        await this.load();
      } catch (e) {
        toastError(this.$store, 'Could not record the verification', e?.message || String(e));
      } finally {
        this.saving = false;
      }
    },

    notYet(what) {
      toastNotYet(this.$store, what);
    },
  },
};
</script>

<template>
  <div class="verify">
    <!-- masthead -->
    <div class="verify__masthead">
      <SButton
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        icon-only
        aria-label="Back to the queue"
        @click="$router.push({ name: REVIEW_QUEUE_ROUTE })"
      />

      <div class="verify__name">
        <div class="verify__title">
          {{ extension }}
        </div>
        <div class="verify__eyebrow">
          Verification · does it actually do the job?
        </div>
      </div>

      <SBadge :status="verdictBadge" :label="verdictLabel" />

      <span class="verify__grow" />

      <SButton
        variant="ghost"
        size="sm"
        icon="book"
        @click="$router.push({ name: BRIEF_ROUTE, params: { extension } })"
      >
        Open the brief
      </SButton>
    </div>

    <div class="verify__body">
      <!-- the checklist -->
      <div class="verify__list">
        <div class="verify__panel-head">
          <SIcon name="list" :size="14" />
          <span class="verify__panel-title">How we said we would know</span>
          <span class="verify__grow" />
          <SChip :label="`${ passed }/${ criteria.length }`" tone="subtle" />
        </div>

        <div class="verify__list-body">
          <SEmpty
            v-if="!loading && !criteria.length"
            icon="book"
            title="No acceptance criteria"
            message="This extension's brief has no checklist, or has no brief at all. Verification is checking a thing against what somebody said it should do — without that, there is nothing to check against."
          >
            <SButton
              variant="secondary"
              icon="book"
              @click="$router.push({ name: BRIEF_ROUTE, params: { extension } })"
            >
              Write the brief
            </SButton>
          </SEmpty>

          <template v-else>
            <!-- what this pass is for, and what it is not (39:1212) -->
            <SBanner v-if="problem" type="success" class="verify__framing">
              <span class="verify__framing-lead">The problem this was for</span>
              <p class="verify__framing-text">
                {{ problem }}
              </p>
            </SBanner>

            <!-- one card, one row per criterion (39:1217) -->
            <div class="verify__criteria">
              <div
                v-for="(c, i) in criteria"
                :key="i"
                class="verify__criterion"
                :class="{
                  'verify__criterion--pass': c.verdict === 'pass',
                  'verify__criterion--fail': c.verdict === 'fail',
                }"
              >
                <span
                  class="verify__badge"
                  :class="{
                    'verify__badge--pass': c.verdict === 'pass',
                    'verify__badge--fail': c.verdict === 'fail',
                  }"
                >
                  <SIcon v-if="c.verdict === 'pass'" name="check" :size="13" />
                  <SIcon v-else-if="c.verdict === 'fail'" name="close" :size="13" />
                  <template v-else>{{ i + 1 }}</template>
                </span>

                <p class="verify__criterion-text">
                  {{ c.text }}
                </p>

                <div class="verify__verdicts" role="group" :aria-label="`Verdict for criterion ${ i + 1 }`">
                  <button
                    v-for="v in VERDICTS"
                    :key="v.label"
                    type="button"
                    class="verify__verdict"
                    :class="c.verdict === v.id ? `verify__verdict--on-${ v.id || 'unset' }` : ''"
                    :aria-pressed="c.verdict === v.id"
                    @click="set(c, v.id)"
                  >
                    {{ v.label }}
                  </button>
                </div>
              </div>
            </div>

            <div class="verify__notes">
              <SLabel text="Notes" />
              <textarea
                v-model="notes"
                class="verify__notes-input"
                rows="3"
                placeholder="Anything the checklist does not cover — what you tried, what surprised you."
              />
            </div>

            <SBanner type="info">
              Recording the result ticks these boxes in <strong>BRIEF.md</strong> and appends a
              verification block, so the record lives in the repository next to the code.
            </SBanner>
          </template>
        </div>
      </div>

      <!-- the thing being verified -->
      <div class="verify__preview">
        <div class="verify__panel-head">
          <SIcon name="eye" :size="14" />
          <span class="verify__panel-title">The extension, running</span>
          <span class="verify__grow" />
          <SButton
            variant="ghost"
            size="sm"
            icon="sparkle"
            @click="$router.push({ name: EDITOR_ROUTE, params: { extension } })"
          >
            Back to the workspace
          </SButton>
        </div>

        <PreviewPanel
          v-if="previewUrl"
          class="verify__frame"
          :url="previewUrl"
          :extension="extension"
        />
        <SEmpty
          v-else
          icon="monitor"
          title="The preview is not up"
          message="The dev server is still compiling. You cannot verify what you cannot look at, so this waits for it."
        />
      </div>
    </div>

    <!-- sign-off bar (39:1391) -->
    <div class="verify__signoff">
      <SIcon name="user" :size="15" />
      <span class="verify__signoff-text">
        <template v-if="!criteria.length">
          Nothing to sign off — this extension has no acceptance criteria.
        </template>
        <template v-else-if="undecided">
          {{ passed }} of {{ criteria.length }} checked, {{ undecided }} still to look at.
        </template>
        <template v-else-if="failed">
          {{ failed }} of {{ criteria.length }} not met. Recording this says so in the brief.
        </template>
        <template v-else>
          Every criterion met. Recording this ticks them off in the brief.
        </template>
      </span>

      <span class="verify__grow" />

      <SButton
        variant="ghost"
        icon="sparkle"
        @click="notYet('having the assistant verify a criterion for you')"
      >
        Ask the assistant to check
      </SButton>
      <SButton
        variant="primary"
        icon="check"
        :loading="saving"
        :disabled="!criteria.length"
        @click="save"
      >
        Record the result
      </SButton>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.verify {
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  background:     var(--studio-surface);

  &__masthead {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       10px var(--studio-space-16);
    border-bottom: 1px solid var(--studio-border);
    flex:          0 0 auto;
  }

  &__name { display: flex; flex-direction: column; gap: 1px; }
  &__title { font: var(--studio-heading-16); color: var(--studio-text); }

  &__eyebrow {
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-tertiary);
  }

  &__grow { flex: 1 1 auto; }

  &__body {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
  }

  // The criteria fill and the preview is the fixed one (39:1211 fill, 39:1355 fixed) - the
  // way round the design has it, and the way round the screen needs: pinning the criteria
  // wrapped every one of them onto two lines while the preview sat on spare width.
  &__list {
    display:        flex;
    flex-direction: column;
    // Basis 0, not auto: on auto the column asks for its content width and the pinned
    // preview next to it spends its whole shrink budget answering.
    flex:           1 1 0;
    min-width:      var(--studio-panel-main-min);
    min-height:     0;
  }

  &__preview {
    display:        flex;
    flex-direction: column;
    flex:           0 1 var(--studio-panel-assistant);
    min-width:      var(--studio-panel-assistant-min);
    border-left:    1px solid var(--studio-border);
    background:     var(--studio-surface-subtle);
    min-height:     0;
  }

  &__frame { flex: 1 1 auto; min-height: 0; }

  &__panel-head {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) 14px;
    background:    var(--studio-surface-subtle);
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    flex:          0 0 auto;
  }

  &__panel-title { font: var(--studio-heading-14); color: var(--studio-text); }

  &__list-body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
    padding:        14px var(--studio-space-16);
    overflow-y:     auto;
    min-height:     0;
    flex:           1 1 auto;
  }

  // 39:1212: the green block that says what this pass is and is not. It is the Banner
  // component - a status wash behind a 4px bar - so it is drawn with one rather than
  // re-cut here.
  &__framing {
    :deep(.s-banner__body) {
      display:        flex;
      flex-direction: column;
      gap:            3px;
    }
  }

  &__framing-lead {
    font:  var(--studio-body-13-semi);
    color: var(--studio-text);
  }

  &__framing-text {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  // One card, its rows divided (39:1217) - not four cards. A checklist is one list.
  &__criteria {
    display:        flex;
    flex-direction: column;
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    overflow:       hidden;
  }

  &__criterion {
    display:        flex;
    align-items:    flex-start;
    gap:            var(--studio-space-12);
    padding:        13px var(--studio-space-16);
    border-bottom:  1px solid var(--studio-border-subtle);

    &:last-child { border-bottom: none; }

    // Only the failing row is washed. A met criterion is marked by its badge going green;
    // tinting it as well makes a checklist that is mostly done unreadably loud.
    &--fail { background: var(--studio-error-bg); }
  }

  // 39:1220: the criterion's number, and where the answer shows up.
  &__badge {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           22px;
    height:          22px;
    flex:            0 0 22px;
    border-radius:   var(--studio-radius-pill);
    background:      var(--studio-surface-nav);
    color:           var(--studio-neutral);
    font:            var(--studio-caption-12-semi);

    &--pass { background: var(--studio-green-500); color: var(--studio-text-inverse); }
    &--fail { background: var(--studio-error); color: var(--studio-text-inverse); }
  }

  &__criterion-text {
    flex:   1 1 auto;
    font:   var(--studio-body-14);
    color:  var(--studio-text);
    margin: 0;
  }

  // 39:1232: one joined control, not two buttons. Three segments, because "I looked and I
  // cannot tell" is an answer and the screen has to let somebody give it.
  &__verdicts {
    display:       flex;
    width:         216px;
    height:        30px;
    flex:          0 0 auto;
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    overflow:      hidden;
  }

  &__verdict {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    flex:            1 1 0;
    padding:         0;
    border:          none;
    background:      transparent;
    color:           var(--studio-text-secondary);
    font:            var(--studio-caption-12-semi);
    cursor:          pointer;

    &:hover { background: var(--studio-surface-subtle); }

    &--on-pass,
    &--on-pass:hover { background: var(--studio-green-500); color: var(--studio-text-inverse); }

    &--on-fail,
    &--on-fail:hover { background: var(--studio-error); color: var(--studio-text-inverse); }

    &--on-unset,
    &--on-unset:hover { background: var(--studio-surface-nav); color: var(--studio-text-secondary); }
  }

  &__notes {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
  }

  &__signoff {
    display:     flex;
    align-items: center;
    gap:         10px;
    padding:     var(--studio-space-12) var(--studio-space-20);
    border-top:  1px solid var(--studio-border);
    color:       var(--studio-text-tertiary);
    flex:        0 0 auto;
  }

  &__signoff-text {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  &__notes-input {
    padding:       10px var(--studio-space-12);
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    outline:       none;
    resize:        vertical;
    font:          var(--studio-body-14);
    color:         var(--studio-text);

    &:focus { border-color: var(--studio-border-focus); }
    &::placeholder { color: var(--studio-text-tertiary); }
  }
}
</style>
