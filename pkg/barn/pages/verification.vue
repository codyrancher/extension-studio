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
//
// Four states, not three. "Can't tell" is an answer somebody gives, so it is a verdict of its
// own; the fourth state is the one before any of them, where nothing is pressed. Folding the
// two together - which is what an empty "Can't tell" did - loses the distinction the sign-off
// bar exists to make, and tells a screen reader that every criterion nobody has read yet is
// answered "Can't tell, pressed".
//
// The design draws three of the four: 39:1233 and 39:1287 are the saturated status fill with
// inverse text a chosen segment gets, and 39:1330 is the weak wash on the row nobody has
// looked at. A deliberate "Can't tell" is that same selection rule in the hue this token set
// already keeps for "we do not know" - warning.
const VERDICTS = [
  { id: 'pass', label: 'Yes' },
  { id: 'fail', label: 'No' },
  { id: 'unsure', label: `Can't tell` },
];

/** Just the clock, for the provenance line under a criterion (39:1225). */
function clock(at) {
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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
      // The path the preview is showing, reported by the panel on the right. It is the route
      // a verdict was taken against, which is the auditable half of a tick.
      route:      '',
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

    /** Looked at and could not be judged - which is not the same as not looked at. */
    unsure() {
      return this.criteria.filter((c) => c.verdict === 'unsure').length;
    },

    /** Nobody has answered these. Only the empty verdict counts here. */
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

      if (this.undecided) {
        return 'partial';
      }

      return this.unsure ? 'unsure' : 'pass';
    },

    verdictBadge() {
      return {
        pass: 'live', fail: 'failed', partial: 'building', unsure: 'unsaved', none: 'draft',
      }[this.verdict];
    },

    verdictLabel() {
      return {
        pass:    'Every criterion checked',
        fail:    `${ this.failed } not met`,
        partial: `${ this.undecided } still to check`,
        unsure:  `${ this.unsure } could not be judged`,
        none:    'No criteria',
      }[this.verdict];
    },

    /**
     * The sign-off sentence, which is where the four states have to be told apart: a criterion
     * somebody looked at and could not judge is a decision, and one nobody has opened yet is
     * an outstanding job, so they are counted separately and said separately.
     */
    signoffText() {
      if (!this.criteria.length) {
        return 'Nothing to sign off — this extension has no acceptance criteria.';
      }

      const total = this.criteria.length;
      const judged = this.unsure ? `, ${ this.unsure } could not be judged` : '';

      if (this.undecided) {
        return `${ this.passed } of ${ total } met${ judged }, ${ this.undecided } still to look at.`;
      }

      if (this.failed) {
        return `${ this.failed } of ${ total } not met${ judged }. Recording this says so in the brief.`;
      }

      if (this.unsure) {
        return `${ this.passed } of ${ total } met, ${ this.unsure } looked at and could not be judged.`;
      }

      return 'Every criterion met. Recording this ticks them off in the brief.';
    },

    /**
     * Whoever is signed in, for the provenance line. Same getters the assistant panel uses -
     * the shell has no `auth/principal`, and the named user is not always fetched yet.
     */
    signedInAs() {
      const g = this.$store?.getters || {};
      const user = g['auth/user'] || g['auth/selfUser'];
      const named = user?.loginName || user?.username || user?.name;

      if (named) {
        return named;
      }

      const id = g['auth/principalId'] || '';
      const tail = String(id).split('://').pop();

      return tail && tail !== id ? tail : '';
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
          // Provenance for a verdict taken in this session (39:1225). The brief records the
          // tick, not who took it or when, so a criterion read back off the file has none -
          // and the line says nothing rather than making something up.
          taken:   '',
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

    /**
     * Answer a criterion, or take the answer back.
     *
     * Pressing the segment that is already pressed clears it, which is the toggle button's own
     * behaviour and the only way back to "nobody has looked at this" after a misclick.
     */
    set(criterion, verdict) {
      const off = criterion.verdict === verdict;

      criterion.verdict = off ? '' : verdict;
      criterion.taken = off ? '' : this.provenance();
    },

    /** "Checked 12:41 · admin", or just the time when the shell has no name for the user. */
    provenance() {
      const at = `Checked ${ clock(new Date()) }`;

      return this.signedInAs ? `${ at } · ${ this.signedInAs }` : at;
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

        if (this.unsure) {
          block.push(`Looked at and could not judge ${ this.unsure }.`);
        }

        if (this.undecided) {
          block.push(`Not looked at: ${ this.undecided }.`);
        }

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
                  :class="`verify__badge--${ c.verdict || 'unanswered' }`"
                >
                  <SIcon v-if="c.verdict === 'pass'" name="check" :size="13" />
                  <SIcon v-else-if="c.verdict === 'fail'" name="close" :size="13" />
                  <template v-else>{{ i + 1 }}</template>
                </span>

                <div class="verify__criterion-main">
                  <p class="verify__criterion-text">
                    {{ c.text }}
                  </p>

                  <!-- where the verdict was taken, and by whom (39:1225) -->
                  <div
                    v-if="c.taken || route"
                    class="verify__meta"
                  >
                    <SIcon name="eye" :size="12" />
                    <span v-if="c.taken">{{ c.taken }}</span>
                    <span
                      v-if="c.taken && route"
                      class="verify__meta-sep"
                    >·</span>
                    <span
                      v-if="route"
                      class="verify__meta-route"
                    >{{ route }}</span>
                  </div>
                </div>

                <div
                  class="verify__verdicts"
                  :class="{ 'verify__verdicts--unanswered': !c.verdict }"
                  role="group"
                  :aria-label="`Verdict for criterion ${ i + 1 }`"
                >
                  <button
                    v-for="v in VERDICTS"
                    :key="v.id"
                    type="button"
                    class="verify__verdict"
                    :class="c.verdict === v.id ? `verify__verdict--on-${ v.id }` : ''"
                    :aria-pressed="c.verdict === v.id"
                    @click="set(c, v.id)"
                  >
                    {{ v.label }}
                  </button>
                </div>

                <!-- 39:1239: the neutral button that puts the criterion on the screen -->
                <SButton
                  class="verify__show"
                  variant="neutral"
                  size="sm"
                  icon="play"
                  @click="notYet('driving the preview to a criterion for you')"
                >
                  Show me
                </SButton>
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
          @route="route = $event"
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
      <span class="verify__signoff-text">{{ signoffText }}</span>

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
// 39:1232: the control's own box, and the numbers the segments below are cut from. Figma
// draws a stroke over a frame rather than inside its layout, so its three segments each fill
// the whole 216x30 - which in CSS means they overlap the border rather than sit inside it.
$verdicts-width:  216px;
$verdicts-height: 30px;
$verdicts-edge:   1px;

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
    // 39:1211. The app puts a panel head above this body that the design's frame does not
    // have, so the frame's top padding lands under that head.
    padding:        var(--studio-space-16) var(--studio-space-20) var(--studio-space-20);
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

    // One hue per state, the same hue the chosen segment takes, so the badge and the control
    // never disagree about what was answered.
    &--pass { background: var(--studio-green-500); color: var(--studio-text-inverse); }
    &--fail { background: var(--studio-error); color: var(--studio-text-inverse); }
    &--unsure { background: var(--studio-warning); color: var(--studio-on-warning); }
  }

  // The criterion and its provenance line - a column between the badge and the controls, so
  // the meta line sits under the text rather than beside the number.
  &__criterion-main {
    display:        flex;
    flex-direction: column;
    flex:           1 1 auto;
    gap:            var(--studio-space-4);
    min-width:      0;
  }

  // 39:1239, and the shell's 40px button minimum once more: on a row whose other control is
  // 30 tall, it is the button that has to give.
  &__show {
    flex:       0 0 auto;
    min-height: 0;
  }

  &__criterion-text {
    flex:   1 1 auto;
    font:   var(--studio-body-14);
    color:  var(--studio-text);
    margin: 0;
  }

  // 39:1225: how this criterion can be checked again - where it was looked at, and by whom
  // when we know. A tick nobody can retrace is not evidence of anything.
  &__meta {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-6);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-tertiary);
    min-width:   0;
  }

  &__meta-sep { color: var(--studio-border-strong); }

  &__meta-route {
    font:          var(--studio-mono-11);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // 39:1232: one joined control, not two buttons. Three segments, because "I looked and I
  // cannot tell" is an answer and the screen has to let somebody give it.
  &__verdicts {
    display:       flex;
    width:         $verdicts-width;
    height:        $verdicts-height;
    flex:          0 0 auto;
    background:    var(--studio-surface);
    border:        $verdicts-edge solid var(--studio-border);
    border-radius: var(--studio-radius);
    overflow:      hidden;

    // 39:1330: the row nobody has answered wears the weak wash across the whole control,
    // rather than one segment looking chosen.
    &--unanswered { background: var(--studio-surface-nav); }
  }

  &__verdict {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    // 39:1233: a third of the control, full height. The negative margins put the segment over
    // the border rather than inside it, which is where the design has it; the control's
    // overflow trims what hangs past the edge.
    flex:            0 0 calc(#{ $verdicts-width } / 3);
    height:          $verdicts-height;
    margin:          (-$verdicts-edge) 0;
    padding:         0;
    border:          none;
    // The shell's 40px minimum for touch targets, again: on a 30px control it pushes 5px of
    // segment out through the top and bottom of the border.
    min-height:      0;
    background:      transparent;
    color:           var(--studio-text-secondary);
    font:            var(--studio-caption-12-semi);
    cursor:          pointer;

    &:hover { background: var(--studio-surface-subtle); }

    // A chosen segment is the status fill with inverse text (39:1233, 39:1287) - one rule,
    // three hues, including the one the design never had a sample of.
    &--on-pass,
    &--on-pass:hover { background: var(--studio-green-500); color: var(--studio-text-inverse); }

    &--on-fail,
    &--on-fail:hover { background: var(--studio-error); color: var(--studio-text-inverse); }

    &--on-unsure,
    &--on-unsure:hover { background: var(--studio-warning); color: var(--studio-on-warning); }
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
