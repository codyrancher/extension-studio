<script>
// Screen 07 - Publish, choose where it goes (Figma frame 16:459).
//
// The frame draws four independently-tickable destinations, a version field, a release summary,
// two sign-offs and three pre-flight checks. Its caption is "every destination is an explicit,
// separate choice", replacing "the single Publish locally split button", so nothing here may be
// ticked for you and nothing may be implied.
//
// Two of the four destinations exist in this product and two do not, and this dialog says which
// is which rather than drawing four boxes and quietly dropping two of them:
//
//   This Rancher     - real. Builds in the pod and points a UIPlugin at the result. Ungated by
//                      design (INTENT rule 2: "dev preview and developer load ask nobody").
//   OCI repository   - THE GATE, and not built. Nothing in this product produces an OCI artefact
//                      or pushes one, so the box is not offered. The sign-offs it would demand
//                      are still read and shown, because they are real and they are what the
//                      row would be waiting for.
//   GitHub           - real, but it is a push to the repository's default branch, not the pull
//                      request the design promises. The row says so in those words. See the
//                      return note: fixing that is `publishExtensionToGithub()`'s job, and that
//                      function lives in a file this screen does not own.
//   SUSE catalog     - no catalog to submit to from anywhere in this environment, and no
//                      submission to make. Listed, because it is the destination that costs the
//                      most approval and leaving it out would hide that; not tickable, because
//                      ticking it could not do anything.
//
// The three pre-flight checks are two real scans and one honest blank:
//
//   Credentials  - the working diff is scanned here, in the browser, for tokens, keys and
//                  kubeconfig credentials. Real reading, real result, and it names the file and
//                  line without ever echoing what it matched.
//   Unstable API - the added lines are scanned for alpha and beta Kubernetes group-versions,
//                  which is the specific dependency risk the frame's example is about
//                  (metrics.k8s.io/v1beta1). A warning, never a block: nothing in the frame is
//                  drawn disabled, including Publish sitting beside a failing check.
//   Build        - cannot be had. Nothing compiles this extension before a publish; the build IS
//                  the publish, `build-pkg` in a shared pod for several minutes. So the row says
//                  that, and reports the last publish failure if there was one, rather than
//                  showing a tick and a compile time nobody measured.
//
// The version is genuinely settable. It is parsed out of the pod's package.json by
// `packageIdentity()` and stamps the bundle name, the UIPlugin and the commit message, so
// changing it here rewrites that file in the pod before the publish starts. The release summary
// is written to CHANGELOG.md in the package, which is inside the tree `git add -A` commits, so
// it travels with the push instead of living in this component until the dialog closes.
import {
  SModal, SButton, SIcon, SLabel, SChip, SField
} from './ui';
import DiffView from './DiffView.vue';
import {
  changedFiles, publishedVersion, workingDiff, changeProvenance,
  readExtensionFile, writeExtensionFile
} from '../extensions';
import { readReview, gateFrom } from '../review';
import { readFailure } from '../publish-failure';
import { REVIEW_CHANGE_ROUTE, VERIFICATION_ROUTE, BUILD_FAILED_ROUTE } from '../editor-product';

/**
 * The four destinations the frame draws, in its order.
 *
 * `available: false` is not a disabled checkbox with no explanation. Each unavailable row states
 * what would have to exist for it to work, which is the difference between a control that is off
 * and a control that lies.
 */
const TARGETS = [
  {
    id:        'local',
    label:     'Load into this Rancher',
    tag:       '',
    requires:  'No sign-off',
    requiresIcon: '',
    available: true,
    note:      'Builds the package in the pod and points this Rancher at the result. Everybody signed in here gets it on their next page load.',
    undo:      'Reversible: "Remove local install" takes it back off.',
  },
  {
    id:        'oci',
    label:     'Push to an OCI repository',
    tag:       'The gate',
    requires:  'Code review required',
    requiresIcon: 'code',
    available: false,
    note:      'The one hard gate in the design: the point an extension becomes installable by people who did not build it, and the only step that asks anybody for permission.',
    why:       'Not built. Nothing in this Studio produces an OCI artefact or pushes one, and no registry is configured for it to push to. The sign-offs below are read and shown anyway, because they are what this row would be waiting for.',
  },
  {
    id:        'github',
    label:     'Push the source to GitHub',
    tag:       '',
    requires:  'No sign-off',
    requiresIcon: '',
    available: true,
    note:      'Commits the package and pushes it to the connected repository. The next dialog asks which one, and for a token if there is not one yet.',
    // The design promises a pull request here. The code does not open one, and saying "PR" over
    // a push to main would be a materially different promise from the one being kept.
    undo:      'Not reversible from here, and not a pull request: it pushes to the repository\'s default branch (main) directly.',
  },
  {
    id:        'catalog',
    label:     'List in the SUSE catalog',
    tag:       'Requires approval',
    requires:  'Both + extensions team',
    requiresIcon: 'lock',
    available: false,
    note:      'The public listing: a signed release, both sign-offs, and the extensions team on top of them.',
    why:       'There is no SUSE catalog reachable from this environment and no submission for this Studio to make, so there is nothing behind this box. It is listed because it is the destination that costs the most approval, not because it can be ticked.',
  },
];

// --- pure scan helpers (tested by scripts/feature-audit scratch harness) ---

/**
 * Every added line of a unified patch, with the file it lands in and its new line number.
 *
 * `+++ b/path` and `--- a/path` are checked before the `+`/`-` branches, because both start with
 * the character that means "a line was added" and neither is one.
 */
function addedLines(patch) {
  const out = [];
  let path = '';
  let no = 0;

  for (const line of (patch || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/ b\/(.+)$/);

      path = match ? match[1] : '';
      no = 0;
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

      no = match ? Number(match[1]) : 0;
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('+')) {
      out.push({ path, line: no, text: line.slice(1) });
      no++;
      continue;
    }

    if (line.startsWith(' ')) {
      no++;
    }
  }

  return out;
}

/** How many files the patch touches, which is what the check row is entitled to claim it read. */
function patchFiles(patch) {
  return (patch || '').split('\n').filter((line) => line.startsWith('diff --git')).length;
}

/**
 * What a credential looks like when somebody pastes one into a file by accident.
 *
 * Prefix-shaped patterns first, because those are the ones with no false positives: a literal
 * `ghp_` followed by forty characters is a GitHub token and nothing else. The generic
 * `secret: "..."` pattern is last and is the one that needs the placeholder guard below.
 */
const CREDENTIALS = [
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub fine-grained token'],
  [/\bgh[opsu]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(?:client-key-data|client-certificate-data):\s*[A-Za-z0-9+/=]{40,}/, 'kubeconfig client credentials'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a JSON web token'],
  [/\bAuthorization:\s*(?:Bearer|Basic|basic)\s+[A-Za-z0-9+/=._~-]{16,}/, 'an Authorization header with a value in it'],
  [/(?:password|passwd|secret|token|api[-_]?key)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i, 'a hard-coded credential'],
];

/**
 * Values that match the generic pattern and are not credentials.
 *
 * A scan that cries wolf on `token: "${GITHUB_TOKEN}"` is a scan people learn to click past, and
 * the row would then be worse than no row at all. The last rule is the one that earns its keep:
 * `SETTINGS_SECRET = 'barn-settings'` is a constant naming an object, and swept over this
 * package's own source it was the only thing the generic pattern got wrong.
 *
 * Only the generic rule consults this. The prefix-shaped patterns capture nothing, so they land
 * here as `undefined` and are never excused - a literal `ghp_` followed by thirty-six characters
 * has no innocent reading.
 */
function isPlaceholder(value) {
  if (!value) {
    return false;
  }

  // An interpolation or a template hole: whatever is secret is somewhere else.
  if (/[$<>{}]/.test(value)) {
    return true;
  }

  if (/^(?:x+|\*+|\.+|changeme|password|redacted|your[-_.]?\w*|example\w*|placeholder|todo)$/i.test(value)) {
    return true;
  }

  // A url, which is a location and not a credential.
  if (/^[a-z]+:\/\//i.test(value)) {
    return true;
  }

  // A slug, a path or a dotted name - `barn-settings`, `owner/name`, `catalog.cattle.io`. The
  // separator is required, so a run of lowercase hex with nothing in it still counts as a find.
  return /^[a-z][a-z0-9]*(?:[-_./][a-z0-9]+)+$/.test(value);
}

/**
 * Tokens, keys and kubeconfig credentials in the added lines of a patch.
 *
 * The finding never carries the matched text. This result is rendered into a dialog and would be
 * shoulder-read, screenshotted into a PR and pasted into a chat, which is the same reasoning
 * that makes `publishExtensionToGithub` scrub its own log before returning it.
 */
function scanCredentials(patch) {
  const found = [];

  for (const { path, line, text } of addedLines(patch)) {
    for (const [pattern, what] of CREDENTIALS) {
      const match = pattern.exec(text);

      if (!match || isPlaceholder(match[1])) {
        continue;
      }

      found.push({ path, line, what });
      break;
    }
  }

  return found;
}

/**
 * Alpha and beta Kubernetes group-versions in the added lines.
 *
 * The frame's example is `metrics.k8s.io/v1beta1 may change between Kubernetes minors`, and that
 * is exactly the class this finds: an API whose group-version says out loud that it is not
 * settled. It is not a general dependency audit and the row does not claim to be one.
 *
 * The group half is any dotted name rather than a list of known suffixes, because the list gets
 * this wrong: `cluster.x-k8s.io/v1alpha4` is a cluster-api group and does not end in `.k8s.io`,
 * so a suffix list quietly misses the APIs most likely to move.
 */
const UNSTABLE = /\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)\/(v\d+(?:alpha|beta)\d*)\b/g;

function scanUnstableApis(patch) {
  const found = [];
  const seen = new Set();

  for (const { path, line, text } of addedLines(patch)) {
    UNSTABLE.lastIndex = 0;

    let match = UNSTABLE.exec(text);

    while (match) {
      const api = `${ match[1] }/${ match[2] }`;

      if (!seen.has(api)) {
        seen.add(api);
        found.push({ api, path, line });
      }

      match = UNSTABLE.exec(text);
    }
  }

  return found;
}

/**
 * A changelog as a preamble and a list of `## <version>` sections, in file order.
 *
 * Split by hand rather than by regex because the alternative is a pattern that has to match "up
 * to the next heading or the end of the file", and JavaScript has no end-of-input anchor that
 * behaves under the `m` flag. Splitting on lines is the same job with nothing to get wrong.
 */
function splitChangelog(text) {
  const preamble = [];
  const sections = [];
  let current = null;

  for (const line of (text || '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);

    if (heading) {
      current = { version: heading[1], body: [] };
      sections.push(current);
      continue;
    }

    (current ? current.body : preamble).push(line);
  }

  return { preamble, sections };
}

function renderChangelog({ preamble, sections }) {
  const head = preamble.join('\n').trim() || '# Changelog';
  const body = sections
    .map((section) => `## ${ section.version }\n\n${ section.body.join('\n').trim() }\n`)
    .join('\n');

  return `${ head }\n\n${ body }`;
}

// --- end pure scan helpers ---

/** `2 hours ago`, from an ISO timestamp. '' for anything that is not one. */
function ago(iso) {
  const then = Date.parse(iso || '');

  if (!Number.isFinite(then)) {
    return '';
  }

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  const scales = [[60, 'minute'], [60, 'hour'], [24, 'day'], [7, 'week'], [4.35, 'month'], [12, 'year']];

  let value = seconds;
  let unit = 'second';

  for (const [size, next] of scales) {
    if (value < size) {
      break;
    }

    value = Math.floor(value / size);
    unit = next;
  }

  if (unit === 'second' && value < 45) {
    return 'just now';
  }

  return `${ value } ${ unit }${ value === 1 ? '' : 's' } ago`;
}

/** What a version has to look like to be one. Prerelease and build metadata allowed. */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export default {
  name: 'PublishModal',

  components: {
    SModal, SButton, SIcon, SLabel, SChip, SField, DiffView
  },

  props: {
    extension: {
      type:     String,
      required: true,
    },
  },

  emits: ['close', 'publish'],

  data() {
    return {
      // Nothing is ticked. The screen's caption is that it replaces a split button with a
      // default, so a destination chosen for you would be the thing it was drawn to remove.
      chosen:  [],
      files:   [],
      // Until the tree has been read, "no changes" would be a claim about a number nobody has
      // asked for - and this dialog exists to say what is in the publish.
      read:    false,
      patch:   '',
      scanned: false,
      showDiff: false,

      installed: '',
      version:      '',
      versionFrom:  '',
      summary:      '',
      summaryFrom:  '',
      changelog:    '',

      provenance: { edited: '', commit: { sha: '', subject: '' } },
      review:     { signoffs: {} },
      failure:    null,

      saving: false,
      error:  '',
    };
  },

  computed: {
    targets() {
      return TARGETS;
    },

    added() {
      return this.files.reduce((n, f) => n + f.added, 0);
    },

    removed() {
      return this.files.reduce((n, f) => n + f.removed, 0);
    },

    /** The design's "3 files - +128 -4", from the working tree rather than from a caption. */
    summaryLine() {
      if (!this.read) {
        return 'Reading the working tree';
      }

      if (!this.files.length) {
        return this.installed
          ? `Nothing has changed since v${ this.installed }`
          : 'Nothing has changed since the last commit';
      }

      const n = this.files.length;

      return `${ n } file${ n === 1 ? '' : 's' } · +${ this.added } −${ this.removed }`;
    },

    /**
     * The design's "reviewed by you 2 minutes ago", which now has a source.
     *
     * The code sign-off in the review record carries a principal, a name and a time, so when
     * somebody has reviewed this it can say who and when. When nobody has, it says that instead
     * of leaving the sentence half-finished.
     */
    reviewNote() {
      const gate = this.gate;
      const signoff = gate.code;

      if (!signoff) {
        return 'Nobody has reviewed this yet, so what is below is the working tree as it stands.';
      }

      const who = signoff.name || signoff.principal;

      if (signoff.verdict === 'changes-requested') {
        return `${ who } asked for changes ${ ago(signoff.at) }.`;
      }

      if (gate.codeStale) {
        return `Reviewed by ${ who } ${ ago(signoff.at) }, against an earlier commit than this one.`;
      }

      return `Reviewed by ${ who } ${ ago(signoff.at) }.`;
    },

    editedNote() {
      const when = ago(this.provenance.edited);

      return when ? `Last edited ${ when }.` : '';
    },

    gate() {
      return gateFrom(this.review, this.provenance.commit.sha);
    },

    /** The two sign-off rows, in the order the design puts them (42:1209, 42:1219). */
    signoffs() {
      const say = (signoff, stale) => {
        if (!signoff) {
          return { tone: 'waiting', icon: 'clock', text: 'Not signed off yet.' };
        }

        const who = signoff.name || signoff.principal || 'somebody Rancher would not name';
        const when = ago(signoff.at);

        if (signoff.verdict === 'changes-requested') {
          return { tone: 'refused', icon: 'alert', text: `${ who } asked for changes ${ when }.` };
        }

        if (stale) {
          return {
            tone: 'stale',
            icon: 'alert',
            text: `${ who } approved ${ when }, at ${ signoff.sha || 'an earlier commit' }. The branch has moved past it.`,
          };
        }

        return { tone: 'done', icon: 'check', text: `${ who } · approved ${ when }` };
      };

      return [
        {
          id: 'code', label: 'Code review', question: 'Is it safe?', ...say(this.gate.code, this.gate.codeStale),
        },
        {
          id: 'outcome', label: 'Outcome sign-off', question: 'Does it do the job?', ...say(this.gate.outcome, this.gate.outcomeStale),
        },
      ];
    },

    /**
     * Why the sign-offs are here at all (42:1229).
     *
     * The note in the frame ties them to the destination rather than to publishing: loading into
     * a Rancher to try it needs nobody. That is INTENT rule 2, and it stays true here even though
     * the destination that demands them cannot be ticked.
     */
    signoffNote() {
      return 'Two people answer two questions, and only the OCI push asks for them. Loading this into a Rancher to try it, or pushing the source to GitHub to ask for a review, needs nobody.';
    },

    /** The three pre-flight rows (16:844, 16:850, 16:862). */
    checks() {
      return [this.buildCheck, this.credentialCheck, this.unstableCheck];
    },

    /**
     * "Build succeeds", which is the one row of the three that cannot be filled in.
     *
     * Nothing compiles this extension ahead of a publish. The build is the publish: `build-pkg`
     * inside the pod, minutes long, and the pod is shared with whoever else is working. So the
     * only real thing this row has is the last publish that failed, and the honest answer to the
     * rest is that nobody checked.
     */
    buildCheck() {
      if (this.failure) {
        return {
          id:    'build',
          tone:  'fail',
          icon:  'error',
          label: 'The last publish failed',
          // `stage` is optional on the record, so it is read as one and not depended on.
          note:  `${ this.failure.stage ? `${ this.failure.stage }: ` : '' }${ this.failure.message } (${ ago(new Date(this.failure.at).toISOString()) }). Nothing has compiled this extension since.`,
          action: { label: 'See what failed', to: { name: BUILD_FAILED_ROUTE, params: { extension: this.extension } } },
        };
      }

      return {
        id:    'build',
        tone:  'unknown',
        icon:  'info',
        label: 'Build: not checked',
        note:  'Nothing compiles this extension before a publish. The build is the publish - build-pkg runs in the pod and takes minutes - so there is no compile result to tick here, and this dialog will not invent one.',
      };
    },

    /** "No credentials in the diff" (16:850). A real scan of the real diff. */
    credentialCheck() {
      if (!this.scanned) {
        return {
          id: 'credentials', tone: 'unknown', icon: 'info', label: 'Scanning the diff for credentials', note: 'Reading the working tree.',
        };
      }

      const n = patchFiles(this.patch);
      const scope = `Scanned ${ n } file${ n === 1 ? '' : 's' } for tokens, keys and kubeconfigs.`;

      if (!this.credentials.length) {
        return {
          id: 'credentials', tone: 'pass', icon: 'check', label: 'No credentials in the diff', note: scope,
        };
      }

      return {
        id:    'credentials',
        tone:  'fail',
        icon:  'error',
        label: `${ this.credentials.length } possible credential${ this.credentials.length === 1 ? '' : 's' } in the diff`,
        note:  `${ scope } ${ this.credentials.map((f) => `${ f.path }:${ f.line } looks like ${ f.what }`).join('; ') }.`,
      };
    },

    /** "Uses an unstable API" (16:862). A warning, and it does not stop the publish. */
    unstableCheck() {
      if (!this.scanned) {
        return {
          id: 'unstable', tone: 'unknown', icon: 'info', label: 'Scanning the diff for unstable APIs', note: 'Reading the working tree.',
        };
      }

      if (!this.unstable.length) {
        return {
          id:    'unstable',
          tone:  'pass',
          icon:  'check',
          label: 'No unstable Kubernetes APIs added',
          note:  'The added lines name no alpha or beta group-version. This looks at API group-versions only, not at the rest of the dependency tree.',
        };
      }

      const apis = this.unstable.map((f) => `${ f.api } (${ f.path }:${ f.line })`).join(', ');

      return {
        id:    'unstable',
        tone:  'warn',
        icon:  'alert',
        label: 'Uses an unstable API',
        note:  `${ apis }. An alpha or beta group-version can change or disappear between Kubernetes minors, so whatever reads it needs an empty state. This is a warning: it does not stop the publish.`,
      };
    },

    credentials() {
      return scanCredentials(this.patch);
    },

    unstable() {
      return scanUnstableApis(this.patch);
    },

    versionError() {
      if (!this.versionFrom) {
        return '';
      }

      return SEMVER.test(this.version.trim()) ? '' : 'A version has to be major.minor.patch, for example 0.2.0.';
    },

    versionHint() {
      if (!this.versionFrom) {
        return 'Reading package.json in the pod.';
      }

      const where = 'Read from package.json in the pod, and stamped on the bundle, the UIPlugin and the commit message.';

      if (this.version.trim() !== this.versionFrom) {
        return `${ where } Publishing rewrites that file to ${ this.version.trim() }.`;
      }

      if (this.installed && this.installed === this.versionFrom) {
        return `${ where } This Rancher already loads ${ this.installed }, so publishing again replaces it in place.`;
      }

      return where;
    },

    summaryHint() {
      return `Written to CHANGELOG.md in the package under ${ this.version.trim() || 'the version above' }, so it is in the tree the GitHub push commits.`;
    },

    /** The footer's "what can be undone" line (16:871), tracking the ticks. */
    rollbackNote() {
      if (!this.chosen.length) {
        return 'Nothing is ticked, so nothing will be published.';
      }

      const parts = [];

      if (this.chosen.includes('local')) {
        parts.push('the load into this Rancher can be taken back off with "Remove local install"');
      }

      if (this.chosen.includes('github')) {
        parts.push('the push to GitHub cannot be undone from here, because it lands on the default branch');
      }

      return `${ parts.join(', and ') }.`;
    },

    publishLabel() {
      const n = this.chosen.length;

      if (!n) {
        return 'Pick a destination';
      }

      return n === 1 ? 'Publish to 1 place' : `Publish to ${ n } places`;
    },
  },

  watch: {
    /** Offer back whatever this version already says in the changelog, once both have arrived. */
    changelog() {
      this.prefillSummary();
    },

    versionFrom() {
      this.prefillSummary();
    },
  },

  mounted() {
    // Fired separately rather than through one Promise.all: these are five execs into the same
    // pod and the dialog is more use filling in as they land than blank until the slowest one
    // does. Each failure is its own, and none of them takes the dialog down.
    changedFiles(this.extension).then((files) => {
      this.files = files;
      this.read = true;
    }).catch(() => {
      this.read = true;
    });

    workingDiff(this.extension).then((patch) => {
      this.patch = patch;
      this.scanned = true;
    }).catch(() => {
      this.scanned = true;
    });

    changeProvenance(this.extension).then((provenance) => {
      this.provenance = provenance;
    }).catch(() => null);

    readExtensionFile(this.extension, 'package.json').then((raw) => {
      const version = (JSON.parse(raw).version || '').trim();

      this.version = version;
      this.versionFrom = version;
    }).catch(() => null);

    // Absent is the normal state and reads as the empty string: `readExtensionFile` is `cat`
    // with stderr discarded, so a package with no changelog yet gives the field nothing to
    // offer back rather than an error to render.
    readExtensionFile(this.extension, 'CHANGELOG.md').then((raw) => {
      this.changelog = raw;
    }).catch(() => null);

    publishedVersion(this.extension).then((version) => {
      this.installed = version;
    }).catch(() => null);

    readReview(this.extension).then((review) => {
      this.review = review;
    }).catch(() => null);

    this.failure = readFailure(this.extension);
  },

  methods: {
    isChosen(id) {
      return this.chosen.includes(id);
    },

    toggle(id) {
      this.chosen = this.isChosen(id)
        ? this.chosen.filter((each) => each !== id)
        : [...this.chosen, id];
    },

    open(to) {
      this.$router.push(to);
    },

    viewSignoff(id) {
      // The two sign-offs are two screens: 12 reviews the code, 13 walks the criteria.
      this.open(id === 'code'
        ? { name: REVIEW_CHANGE_ROUTE, params: { extension: this.extension, change: 'working' } }
        : { name: VERIFICATION_ROUTE, params: { extension: this.extension } });
    },

    /** The section of CHANGELOG.md for one version, or '' when there is none. */
    changelogEntry(version) {
      const section = splitChangelog(this.changelog).sections.find((each) => each.version === version);

      return section ? section.body.join('\n').trim() : '';
    },

    prefillSummary() {
      // `this.summary` guards the case where the changelog arrives after somebody has started
      // typing, which is a real race: the field is editable from the first frame and the read is
      // an exec into a pod.
      if (this.summaryFrom || this.summary || !this.versionFrom) {
        return;
      }

      const entry = this.changelogEntry(this.versionFrom);

      if (entry) {
        this.summary = entry;
        this.summaryFrom = entry;
      }
    },

    /**
     * Put a version into package.json without reformatting the rest of it.
     *
     * A targeted replacement rather than parse-and-stringify, because stringify would reindent
     * the whole file and turn a one-word change into a diff nobody can read. The parse afterwards
     * is the check that the replacement did what it said; if it did not, the file is left alone
     * and the publish stops rather than proceeding with a version nobody set.
     */
    async writeVersion(version) {
      const raw = await readExtensionFile(this.extension, 'package.json');
      const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${ version }$2`);

      if (JSON.parse(next).version !== version) {
        throw new Error('the version could not be written into package.json');
      }

      await writeExtensionFile(this.extension, 'package.json', next);
    },

    /** Put the summary under its version heading in CHANGELOG.md, newest first. */
    async writeSummary(version, summary) {
      const doc = splitChangelog(this.changelog);
      const existing = doc.sections.find((each) => each.version === version);

      if (existing) {
        existing.body = summary.trim().split('\n');
      } else {
        doc.sections.unshift({ version, body: summary.trim().split('\n') });
      }

      const next = renderChangelog(doc);

      await writeExtensionFile(this.extension, 'CHANGELOG.md', next);
      this.changelog = next;
    },

    /**
     * Write what the dialog changed, then hand the destinations to the page.
     *
     * The writes happen first and on purpose: the version is what the build stamps, so setting it
     * after the build had started would stamp the old one, and a summary that only lived in this
     * component would be gone the moment the dialog closed.
     */
    async confirm() {
      if (!this.chosen.length || this.saving || this.versionError) {
        return;
      }

      this.saving = true;
      this.error = '';

      const version = this.version.trim();
      const summary = this.summary.trim();

      try {
        if (this.versionFrom && version !== this.versionFrom) {
          await this.writeVersion(version);
          this.versionFrom = version;
        }

        if (summary && summary !== this.summaryFrom) {
          // "Unreleased" is the changelog convention for a summary written before there is a
          // version to hang it on, which happens only when package.json could not be read.
          await this.writeSummary(version || this.versionFrom || 'Unreleased', summary);
          this.summaryFrom = summary;
        }
      } catch (e) {
        this.error = e?.message || String(e);
        this.saving = false;

        return;
      }

      this.saving = false;

      // In the order they are drawn, so a publish to both lands in this Rancher before it is
      // handed to the modal that asks about the repository.
      this.$emit('publish', TARGETS.filter((t) => t.available && this.isChosen(t.id)).map((t) => t.id));
    },
  },
};
</script>

<template>
  <SModal
    icon="rocket"
    :width="680"
    :busy="saving"
    @close="$emit('close')"
  >
    <template #header>
      <span data-testid="barn-publish-title">Publish {{ extension }}</span>
    </template>

    <p
      class="publish-modal__say"
      data-testid="barn-publish-subtitle"
    >
      Every destination below is a separate choice and none of them is ticked for you. Each row
      says what approval it costs and whether it can be taken back.
    </p>

    <!-- the changeset (16:770): what is actually in this publish -->
    <div class="publish-modal__changeset">
      <SIcon name="compare" :size="16" />
      <div class="publish-modal__changeset-text">
        <span
          class="publish-modal__changeset-title"
          data-testid="barn-publish-changeset"
        >{{ summaryLine }}</span>
        <span class="publish-modal__changeset-note">
          {{ reviewNote }} {{ editedNote }}
        </span>
        <span v-if="files.length" class="publish-modal__files">
          {{ files.map((f) => f.path).join(', ') }}
        </span>
      </div>
      <SButton
        v-if="files.length"
        variant="ghost"
        size="sm"
        data-testid="barn-publish-view-diff"
        @click="showDiff = !showDiff"
      >
        {{ showDiff ? 'Hide diff' : 'View diff' }}
      </SButton>
    </div>

    <div
      v-if="showDiff"
      class="publish-modal__diff"
      data-testid="barn-publish-diff"
    >
      <DiffView :patch="patch" />
    </div>

    <!-- version and release summary (16:783, 16:786) -->
    <div class="publish-modal__release">
      <div class="publish-modal__version">
        <SField
          v-model="version"
          label="Version"
          placeholder="0.1.0"
          :disabled="!versionFrom || saving"
          :error="versionError"
          :hint="versionHint"
          input-testid="barn-publish-version"
        />
      </div>
      <SField
        v-model="summary"
        label="Summary of this release"
        placeholder="What changed, in one line."
        multiline
        :rows="2"
        :disabled="saving"
        :hint="summaryHint"
        input-testid="barn-publish-summary"
      />
    </div>

    <SLabel text="Destinations" />

    <div class="publish-modal__targets">
      <component
        :is="target.available ? 'label' : 'div'"
        v-for="target in targets"
        :key="target.id"
        class="publish-modal__target"
        :class="{
          'publish-modal__target--on': isChosen(target.id),
          'publish-modal__target--off': !target.available,
        }"
        :data-testid="`barn-publish-row-${ target.id }`"
      >
        <input
          v-if="target.available"
          type="checkbox"
          class="publish-modal__box"
          :checked="isChosen(target.id)"
          :disabled="saving"
          :data-testid="`barn-publish-target-${ target.id }`"
          @change="toggle(target.id)"
        >
        <SIcon v-else name="lock" :size="14" class="publish-modal__locked" />

        <span class="publish-modal__target-text">
          <span class="publish-modal__target-head">
            <span class="publish-modal__target-label">{{ target.label }}</span>
            <SChip
              v-if="target.tag"
              :label="target.tag"
              :tone="target.id === 'oci' ? 'warning' : 'default'"
            />
          </span>
          <span class="publish-modal__target-note">{{ target.note }}</span>
          <span v-if="target.available" class="publish-modal__target-undo">{{ target.undo }}</span>
          <span
            v-else
            class="publish-modal__target-why"
            :data-testid="`barn-publish-unavailable-${ target.id }`"
          >{{ target.why }}</span>
        </span>

        <SChip
          class="publish-modal__requires"
          :icon="target.requiresIcon"
          :label="target.requires"
          :tone="target.requires === 'No sign-off' ? 'subtle' : 'warning'"
          :data-testid="`barn-publish-requirement-${ target.id }`"
        />
      </component>
    </div>

    <!-- the sign-offs (42:1209, 42:1219) -->
    <SLabel text="Sign-offs" />

    <div class="publish-modal__signoffs">
      <div
        v-for="signoff in signoffs"
        :key="signoff.id"
        class="publish-modal__signoff"
        :class="`publish-modal__signoff--${ signoff.tone }`"
        :data-testid="`barn-publish-signoff-${ signoff.id }`"
      >
        <SIcon :name="signoff.icon" :size="14" />
        <span class="publish-modal__signoff-text">
          <span class="publish-modal__signoff-label">
            {{ signoff.label }}
            <span class="publish-modal__signoff-question">{{ signoff.question }}</span>
          </span>
          <span class="publish-modal__signoff-note">{{ signoff.text }}</span>
        </span>
        <SButton
          variant="ghost"
          size="sm"
          :data-testid="`barn-publish-signoff-${ signoff.id }-view`"
          @click="viewSignoff(signoff.id)"
        >
          View
        </SButton>
      </div>

      <p
        class="publish-modal__signoff-why"
        data-testid="barn-publish-signoff-note"
      >
        {{ signoffNote }}
      </p>
    </div>

    <!-- the pre-flight checks (16:844, 16:850, 16:862) -->
    <SLabel text="Pre-flight checks" />

    <div class="publish-modal__checks">
      <div
        v-for="check in checks"
        :key="check.id"
        class="publish-modal__check"
        :class="`publish-modal__check--${ check.tone }`"
        :data-testid="`barn-publish-check-${ check.id }`"
      >
        <SIcon :name="check.icon" :size="14" />
        <span class="publish-modal__check-text">
          <span class="publish-modal__check-label">{{ check.label }}</span>
          <span class="publish-modal__check-note">{{ check.note }}</span>
        </span>
        <SButton
          v-if="check.action"
          variant="ghost"
          size="sm"
          @click="open(check.action.to)"
        >
          {{ check.action.label }}
        </SButton>
      </div>
    </div>

    <p v-if="error" class="publish-modal__error">
      {{ error }}
    </p>

    <template #footer>
      <span
        class="publish-modal__rollback"
        data-testid="barn-publish-rollback"
      >{{ rollbackNote }}</span>
      <SButton
        variant="neutral"
        :disabled="saving"
        data-testid="barn-publish-cancel"
        @click="$emit('close')"
      >
        Cancel
      </SButton>
      <SButton
        variant="primary"
        icon="rocket"
        :loading="saving"
        :disabled="!chosen.length || !!versionError"
        data-testid="barn-publish-confirm"
        @click="confirm"
      >
        {{ publishLabel }}
      </SButton>
    </template>
  </SModal>
</template>

<style lang="scss" scoped>
.publish-modal {
  &__say {
    margin: 0 0 var(--studio-space-16);
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
  }

  &__changeset {
    display:       flex;
    align-items:   flex-start;
    gap:           10px;
    padding:       10px var(--studio-space-12);
    margin-bottom: var(--studio-space-16);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    color:         var(--studio-text-secondary);
  }

  &__changeset-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-4);
    min-width:      0;
    flex:           1 1 auto;
  }

  &__changeset-title {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__changeset-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__files {
    font:       var(--studio-mono-12);
    color:      var(--studio-text-secondary);
    word-break: break-word;
  }

  &__diff {
    max-height:    260px;
    overflow:      auto;
    margin-bottom: var(--studio-space-16);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
  }

  &__release {
    display:        flex;
    gap:            var(--studio-space-12);
    align-items:    flex-start;
    margin-bottom:  var(--studio-space-16);

    > * { flex: 1 1 auto; min-width: 0; }
  }

  &__version {
    flex: 0 0 180px;
  }

  &__targets {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    margin:         var(--studio-space-8) 0 var(--studio-space-16);
  }

  &__target {
    display:       flex;
    align-items:   flex-start;
    gap:           10px;
    padding:       10px var(--studio-space-12);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius);
    cursor:        pointer;

    &:hover { border-color: var(--studio-border-strong); }

    &--on {
      border-color: var(--studio-border-focus);
      background:   var(--studio-info-bg);
    }

    &--off {
      cursor:     default;
      background: var(--studio-surface-subtle);

      &:hover { border-color: var(--studio-border); }
    }
  }

  &__box {
    margin-top: 3px;
    flex:       0 0 auto;
  }

  &__locked {
    margin-top: 2px;
    color:      var(--studio-text-tertiary);
  }

  &__target-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    min-width:      0;
    flex:           1 1 auto;
  }

  &__target-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    flex-wrap:   wrap;
  }

  &__target-label {
    font:  var(--studio-heading-14);
    color: var(--studio-text);
  }

  &__target-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__target-undo,
  &__target-why {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__requires {
    flex:       0 0 auto;
    margin-top: 2px;
  }

  &__signoffs {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    margin:         var(--studio-space-8) 0 var(--studio-space-16);
  }

  &__signoff,
  &__check {
    display:       flex;
    align-items:   flex-start;
    gap:           10px;
    padding:       8px var(--studio-space-12);
    border:        1px solid var(--studio-border-subtle);
    border-radius: var(--studio-radius);
    background:    var(--studio-surface-subtle);
  }

  &__signoff--done,
  &__check--pass {
    color:      var(--studio-success);
    background: var(--studio-success-bg);
  }

  &__signoff--stale,
  &__signoff--refused,
  &__check--warn {
    color:      var(--studio-warning);
    background: var(--studio-warning-bg);
  }

  &__check--fail {
    color:      var(--studio-error);
    background: var(--studio-error-bg);
  }

  &__signoff-text,
  &__check-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    min-width:      0;
    flex:           1 1 auto;
  }

  &__signoff-label,
  &__check-label {
    display:     flex;
    align-items: baseline;
    gap:         var(--studio-space-8);
    font:        var(--studio-heading-14);
    color:       var(--studio-text);
  }

  &__signoff-question {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__signoff-note,
  &__check-note {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__signoff-why {
    margin: 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
  }

  &__checks {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
    margin-top:     var(--studio-space-8);
  }

  &__error {
    margin: var(--studio-space-12) 0 0;
    font:   var(--studio-caption-12);
    color:  var(--studio-error);
  }

  &__rollback {
    flex:         1 1 auto;
    margin-right: auto;
    font:         var(--studio-caption-12);
    color:        var(--studio-text-tertiary);
  }
}
</style>
