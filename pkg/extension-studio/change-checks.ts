/**
 * The machine checks a reviewer should not have to run by hand (Figma 38:1215).
 *
 * The design draws five rows, all of them green: build passes, no credentials in the diff,
 * contrast and focus order pass, all strings translatable, no private Rancher APIs used. Two of
 * those are a real reading of the patch, one is a real reading of the patch against the
 * extension's own translation file, and two cannot be had here at all. This module is where the
 * difference is decided, so the screen renders a row per check rather than deciding per row what
 * it is allowed to claim.
 *
 * The rule every row obeys: a check that could not run says so and is never drawn as a pass. A
 * green tick nobody earned is worse than an empty list, because it is the one thing on the screen
 * a reviewer is invited to trust without reading.
 *
 * The credential and unstable-API scanners are the ones the publish dialog already runs before a
 * hand-over (`components/PublishModal.vue`, "pure scan helpers"). They were written there and
 * they are copied here verbatim rather than imported, because they are private to that
 * component; they belong in this module and PublishModal should import them from here once
 * nobody else is editing it. Two copies of a regex list is a real cost and it is recorded so it
 * gets paid rather than forgotten.
 */

/** One thing a scan found, always with where it is and never with what it matched. */
export interface Finding {
  path: string;
  line: number;
  what: string;
}

export type CheckState = 'pass' | 'warn' | 'unknown';

export interface Check {
  id:    string;
  /** What is actually measured, which is not always what the design's row is called. */
  label: string;
  state: CheckState;
  /** The one line under the label. */
  note:  string;
  /** The hover text: what was read, how, and what the reading cannot cover. */
  title: string;
  findings: Finding[];
}

/**
 * Every added line of a unified patch, with the file it lands in and its new line number.
 *
 * `+++ b/path` and `--- a/path` are checked before the `+`/`-` branches, because both start with
 * the character that means "a line was added" and neither is one.
 */
export function addedLines(patch: string): { path: string; line: number; text: string }[] {
  const out: { path: string; line: number; text: string }[] = [];
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

/** How many files the patch touches, which is what a check row is entitled to claim it read. */
export function patchFiles(patch: string): number {
  return (patch || '').split('\n').filter((line) => line.startsWith('diff --git')).length;
}

/**
 * What a credential looks like when somebody pastes one into a file by accident.
 *
 * Prefix-shaped patterns first, because those are the ones with no false positives: a literal
 * `ghp_` followed by forty characters is a GitHub token and nothing else. The generic
 * `secret: "..."` pattern is last and is the one that needs the placeholder guard below.
 */
const CREDENTIALS: [RegExp, string][] = [
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
 * the row would then be worse than no row at all.
 */
function isPlaceholder(value: string | undefined): boolean {
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

  // A slug, a path or a dotted name - `settings`, `owner/name`, `catalog.cattle.io`.
  return /^[a-z][a-z0-9]*(?:[-_./][a-z0-9]+)+$/.test(value);
}

/**
 * Tokens, keys and kubeconfig credentials in the added lines of a patch.
 *
 * The finding never carries the matched text. This result is rendered onto a review screen and
 * would be shoulder-read, screenshotted into a PR and pasted into a chat.
 */
export function scanCredentials(patch: string): Finding[] {
  const found: Finding[] = [];

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
 * The group half is any dotted name rather than a list of known suffixes, because the list gets
 * this wrong: `cluster.x-k8s.io/v1alpha4` is a cluster-api group and does not end in `.k8s.io`,
 * so a suffix list quietly misses the APIs most likely to move.
 */
const UNSTABLE = /\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)\/(v\d+(?:alpha|beta)\d*)\b/g;

export function scanUnstableApis(patch: string): Finding[] {
  const found: Finding[] = [];
  const seen = new Set<string>();

  for (const { path, line, text } of addedLines(patch)) {
    UNSTABLE.lastIndex = 0;

    let match = UNSTABLE.exec(text);

    while (match) {
      const api = `${ match[1] }/${ match[2] }`;

      if (!seen.has(api)) {
        seen.add(api);
        found.push({ path, line, what: api });
      }

      match = UNSTABLE.exec(text);
    }
  }

  return found;
}

/**
 * Translation keys used by the added lines that the extension's own `l10n/en-us.yaml` has not got.
 *
 * The design's row is "all strings translatable", which is the opposite question - is there any
 * bare English in the template - and that one cannot be asked honestly from a patch: a string
 * literal in a `.vue` file is a label, a class name, a route or a comparison, and no rule
 * separates them without reading the code. Guessing would produce a red row on `class="rc__title"`
 * and a reviewer would learn to ignore the whole section within a day.
 *
 * What can be asked exactly is the other half of the same discipline: every key this change
 * *does* look up has to exist. A `t('base.title')` with no `base.title` in the file renders the
 * key itself into the page, which is the specific bug an i18n check is worth having for, and it
 * is a fact rather than a heuristic.
 *
 * The yaml is read as an indented tree rather than parsed, because these files are two or three
 * levels of plain mapping and pulling a yaml parser into the bundle to read them would be the
 * larger mistake. A line with a value is a leaf; a line with none opens a level.
 */
const T_CALL = /\bt\(\s*['"]([\w.-]+)['"]/g;

export function l10nKeys(yaml: string): Set<string> {
  const keys = new Set<string>();
  const stack: { indent: number; key: string }[] = [];

  for (const raw of (yaml || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const match = /^(\s*)([\w.-]+):\s*(.*)$/.exec(line);

    if (!match || line.trim().startsWith('#')) {
      continue;
    }

    const indent = match[1].length;

    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const path = [...stack.map((s) => s.key), match[2]].join('.');

    if (match[3].trim()) {
      keys.add(path);
    } else {
      stack.push({ indent, key: match[2] });
      // A mapping key is also a legal lookup target for anything reading a subtree.
      keys.add(path);
    }
  }

  return keys;
}

export function scanMissingStrings(patch: string, yaml: string): Finding[] {
  const known = l10nKeys(yaml);
  const found: Finding[] = [];
  const seen = new Set<string>();

  for (const { path, line, text } of addedLines(patch)) {
    T_CALL.lastIndex = 0;

    let match = T_CALL.exec(text);

    while (match) {
      const key = match[1];

      // A dotted key is a translation lookup; a bare word is far more likely to be some other
      // one-argument `t(` in the same line, and calling that a missing string would be a guess.
      if (key.includes('.') && !known.has(key) && !seen.has(key)) {
        seen.add(key);
        found.push({ path, line, what: key });
      }

      match = T_CALL.exec(text);
    }
  }

  return found;
}

/** What the whole section says in one line, so the header can summarise without counting twice. */
export function checksSummary(checks: Check[]): string {
  const warned = checks.filter((c) => c.state === 'warn').length;
  const unknown = checks.filter((c) => c.state === 'unknown').length;
  const passed = checks.filter((c) => c.state === 'pass').length;

  if (warned) {
    return `${ warned } of ${ checks.length } found something`;
  }

  return unknown ? `${ passed } ran clean, ${ unknown } could not run` : 'all green';
}

/** What the build row can say, which is never "it compiled". */
export interface BuildFacts {
  /** The version installed in this Rancher, if any. */
  installed: string;
  /** The last recorded publish failure's message and clock time, if there was one. */
  failure:   { message: string; at: string } | null;
}

/**
 * The five rows, in the order the design draws them.
 *
 * `patch` is the whole change collapsed against the baseline, not the file on screen: a check
 * that only read the file a reviewer happened to have open would be a check that misses whatever
 * they have not clicked on yet, which is the reason to have machine checks at all.
 */
export function changeChecks(
  { patch, l10n, build }: { patch: string; l10n: string; build: BuildFacts }
): Check[] {
  const files = patchFiles(patch);
  const read = `${ files } file${ files === 1 ? '' : 's' } of the change`;

  const credentials = scanCredentials(patch);
  const apis = scanUnstableApis(patch);
  const strings = scanMissingStrings(patch, l10n);

  const buildNote = build.failure
    ? `The last publish failed at ${ build.failure.at }: ${ build.failure.message }`
    : (build.installed
      ? `Nothing has compiled this change. v${ build.installed } is what last built and installed.`
      : 'Nothing has compiled this change, and no version of this extension has ever been installed here.');

  return [
    {
      id:    'build',
      label: 'Build',
      state: 'unknown',
      note:  buildNote,
      title: 'There is no build to report. Nothing compiles an extension before a review: the build IS the publish, several minutes of build-pkg in a shared pod, and it has not been run for this change. What is reported instead is the last one that did run.',
      findings: [],
    },
    {
      id:    'credentials',
      label: 'Credentials in the diff',
      state: credentials.length ? 'warn' : 'pass',
      note:  credentials.length
        ? `${ credentials.length } added line${ credentials.length === 1 ? '' : 's' } look${ credentials.length === 1 ? 's' : '' } like a credential`
        : `No token, key or kubeconfig credential in the added lines of ${ read }`,
      title: 'The added lines are scanned for GitHub, AWS and Slack token shapes, private keys, JSON web tokens, Authorization headers, kubeconfig client data and hard-coded password/secret assignments. Removed and unchanged lines are not scanned: they are already in the history. What matched is never quoted back, only where it is.',
      findings: credentials,
    },
    {
      id:    'contrast',
      label: 'Contrast and focus order',
      state: 'unknown',
      note:  'Nothing here measures either. Neither is a property of a patch.',
      title: 'Contrast is a property of two rendered colours and focus order of a rendered document, so both need the running page rather than the diff. The preview beside this frames a whole dashboard, so anything measured in it would be Rancher\'s own contrast and Rancher\'s own tab order, attributed to this change. That would be worse than saying nothing.',
      findings: [],
    },
    {
      id:    'strings',
      label: 'Translation keys resolve',
      state: strings.length ? 'warn' : 'pass',
      note:  strings.length
        ? `${ strings.length } key${ strings.length === 1 ? '' : 's' } looked up by this change ${ strings.length === 1 ? 'is' : 'are' } not in l10n/en-us.yaml`
        : (l10n.trim()
          ? 'Every translation key this change looks up is in l10n/en-us.yaml'
          : 'This extension has no l10n/en-us.yaml, and this change looks nothing up'),
      title: 'The design asks whether every string is translatable, which is the opposite question and cannot be answered from a patch: no rule separates a label from a class name or a route inside a string literal, and a check that guessed would flag class="title" on every row. What is checked exactly is that every key this change does look up exists in the extension\'s own translation file, because a key that is missing renders as itself on the page.',
      findings: strings,
    },
    {
      id:    'apis',
      label: 'Unstable Kubernetes APIs',
      state: apis.length ? 'warn' : 'pass',
      note:  apis.length
        ? `${ apis.length } alpha or beta group-version${ apis.length === 1 ? '' : 's' } added`
        : `No alpha or beta group-version added in ${ read }`,
      title: 'The design\'s row is "no private Rancher APIs used", and Rancher publishes no list of which of its own APIs are private, so there is no boundary to test a line against. The neighbouring risk can be tested exactly: a Kubernetes group-version whose name says out loud that it is not settled, like metrics.k8s.io/v1beta1, which may change between minors. A warning either way, never a block.',
      findings: apis,
    },
  ];
}
