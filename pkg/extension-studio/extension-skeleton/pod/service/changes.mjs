// The reads the review screens poll: what has been approved, what changed, who did it, and
// which turns produced it.
//
// These are four questions the browser used to answer by composing a paragraph of shell,
// sending it into a pod, and hunting for a marker in the transcript that came back. Several
// screens asked each of them, on a timer, each with its own copy of the shell and its own
// parser. What is left in the browser now is the name of the extension.
//
// The shell is reproduced here rather than shared, for the reason in names.mjs: a browser
// bundle cannot import this file. What has to agree between the two copies is the ref names and
// the baseline rule, and scripts/gen-extension-seed.mjs compares all five constants below
// against their counterparts in extensions.ts.
//
// That check is not housekeeping. `refs/barn/approved` is written only by the browser, in
// approveUpTo, and read only here - so renaming it on one side would leave approvals being
// written to a ref nothing reads, and every change set would sit pending for ever with nothing
// anywhere reporting a fault.

/** How far a person has reviewed. Unset reads as "everything is pending", which is the safe way. */
const APPROVED_REF = 'refs/barn/approved';

/** The last version published to a registry, and the last one this Rancher loads. */
const BASELINE_OCI_REF = 'refs/barn/published/oci';
const BASELINE_LOCAL_REF = 'refs/barn/published/local';

/**
 * Resolve `$BARN_BASE`: the point every "what has changed" screen measures from.
 *
 * Published, then approved, then the root commit. HEAD is deliberately not in that list until
 * the very end: every turn ends in a commit, so HEAD is the working tree the moment the
 * assistant stops, and a diff against it is empty by construction.
 */
const BASELINE_SH = [
  `BARN_BASE=$(git rev-parse --verify -q ${ BASELINE_OCI_REF }`,
  `|| git rev-parse --verify -q ${ BASELINE_LOCAL_REF }`,
  `|| git rev-parse --verify -q ${ APPROVED_REF }`,
  '|| git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1',
  '|| git rev-parse --verify -q HEAD)',
].join(' ');

/** Tell git the untracked files are coming, which is the only way they appear in a diff. */
const INTENT_SH = 'git add -A -N >/dev/null 2>&1';

/** A sha this product will put into a shell. Nothing else goes near one. */
function requireCommitish(sha) {
  const trimmed = String(sha || '').trim();

  if (!/^[0-9a-f]{4,40}$/.test(trimmed)) {
    throw new Error(`"${ trimmed }" is not a commit`);
  }

  return trimmed;
}

/**
 * What has been reviewed and what has not.
 *
 * `rev-list APPROVED..HEAD` is the whole question. Each fallback is its own statement rather
 * than one `base=$(a || b || c)` spread over several lines: the pod's shell is dash, which
 * reads a line starting with `||` inside a command substitution as a syntax error, and the
 * failure then arrives as output with no marker in it - which every screen drew as "reviewed".
 */
export function approvalScript() {
  return [
    'test -d .git || { echo BARN-NOGIT ; exit 0 ; }',
    `approved=$(git rev-parse --verify -q ${ APPROVED_REF } 2>/dev/null || true)`,
    'echo "APPROVED=$approved"',
    'base="$approved"',
    `[ -n "$base" ] || base=$(git rev-parse --verify -q ${ BASELINE_OCI_REF } 2>/dev/null || true)`,
    `[ -n "$base" ] || base=$(git rev-parse --verify -q ${ BASELINE_LOCAL_REF } 2>/dev/null || true)`,
    '[ -n "$base" ] || base=$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)',
    'echo PENDING',
    'if [ -n "$base" ] ; then git rev-list "$base"..HEAD 2>/dev/null ; else git rev-list HEAD 2>/dev/null ; fi',
  ].join('\n');
}

/**
 * Read that back.
 *
 * The two failure shapes are different answers and only one of them may open the publish gate.
 * A tree with no history has nothing to review, which is the one honest `clear: true`. Anything
 * else that did not answer is unknown, and unknown is not clear: this used to fall back to
 * `{ pending: [], clear: true }`, so an exec that failed for any reason marked every change set
 * as looked at, which is exactly what the gate exists to stop.
 */
export function parseApproval(out) {
  if (out.includes('BARN-NOGIT')) {
    return {
      sha: '', pending: [], clear: true, read: true,
    };
  }

  if (out.includes('BARN-APPROVAL-FAILED') || !out.includes('PENDING')) {
    return {
      sha: '', pending: [], clear: false, read: false,
    };
  }

  const sha = (/APPROVED=(\S*)/.exec(out)?.[1] || '').trim();
  const at = out.indexOf('PENDING');
  const pending = at === -1 ? [] : out.slice(at + 'PENDING'.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{7,40}$/i.test(line));

  return {
    sha, pending, clear: !pending.length, read: true,
  };
}

/**
 * The change, file by file. Two readings in one exec, because a name-status cannot say how big
 * a change is and a second shell into the pod is a second the reviewer waits.
 *
 * `since` narrows it to what has landed after one commit, which is screen 12's "since your last
 * look". It refuses rather than falls back when that commit is not in the pod, because
 * answering with the whole change is answering a different question from the one that was asked.
 */
export function changedFilesScript(since) {
  const head = since
    ? [
      `BARN_SINCE=$(git rev-parse --verify -q ${ requireCommitish(since) }^{commit}) || { echo BARN-NO-COMMIT ; exit 0 ; }`,
      INTENT_SH,
    ]
    : [BASELINE_SH, INTENT_SH];
  const against = since ? '"$BARN_SINCE"' : '"$BARN_BASE"';

  return [
    ...head,
    `git diff --name-status --no-renames ${ against } 2>/dev/null`,
    'echo "--numstat--"',
    `git diff --numstat --no-renames ${ against } 2>/dev/null`,
  ].join(' ; ');
}

/**
 * The two halves of that reading, turned into rows.
 *
 * Rename detection is off, because the review screen lists paths and a rename shown as
 * `old -> new` is a path that matches nothing. Untracked files are reported as additions, which
 * is what they are to somebody reading the screen.
 */
export function parseChangedFiles(out) {
  const [statusOut, numstatOut = ''] = String(out || '').split('--numstat--');
  const stats = {};
  // git quotes a path with anything awkward in it, and every caller keys on the plain one.
  const unquote = (path) => path.trim().replace(/^"|"$/g, '');

  for (const line of numstatOut.split('\n')) {
    const [added, removed, ...rest] = line.trimEnd().split(/\t/);

    if (rest.length) {
      // A binary file is reported as `-\t-\t<path>`, which parses to zero on both counts, and
      // that is true: it has no lines.
      stats[unquote(rest.join('\t'))] = { added: parseInt(added, 10) || 0, removed: parseInt(removed, 10) || 0 };
    }
  }

  return statusOut.split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split(/\t/);
      const path = unquote(rest.join('\t'));
      const { added = 0, removed = 0 } = stats[path] || {};
      let status = 'modified';

      if (code.startsWith('A')) {
        status = 'added';
      } else if (code.startsWith('D')) {
        status = 'deleted';
      }

      return {
        path, status, added, removed,
      };
    })
    .filter((file) => !!file.path);
}

/**
 * Where the change came from: the last commit, and when the tree was last edited.
 *
 * The commit half is a fact git holds. The uncommitted half is not - git records no author for
 * a working tree - so the only thing that can be said is when a file in it was last written.
 * `stat` gives that and busybox has it.
 */
export function provenanceScript() {
  return [
    `git log -1 --format='SHA:%h%nAUTHOR:%an%nWHEN:%cI%nSUBJECT:%s' 2>/dev/null`,
    'echo "--edited--"',
    // `cut -c4-` drops porcelain's two status characters and the space after them.
    'git status --porcelain --no-renames 2>/dev/null | cut -c4- | tr -d \'"\' | while read -r p ; do [ -f "$p" ] && stat -c %Y "$p" 2>/dev/null ; done | sort -n | tail -1',
  ].join(' ; ');
}

export function parseProvenance(out) {
  const [logOut = '', editedOut = ''] = String(out || '').split('--edited--');
  const field = (key) => (new RegExp(`^${ key }:(.*)$`, 'm').exec(logOut)?.[1] || '').trim();
  const epoch = parseInt(editedOut.trim(), 10);

  return {
    edited: Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : '',
    commit: {
      sha: field('SHA'), author: field('AUTHOR'), when: field('WHEN'), subject: field('SUBJECT'),
    },
  };
}

/** The turns the pod recorded, newest first. See pod/barn-provenance.mjs for what it records. */
export function turnsScript(limit) {
  return `node /seed/barn-provenance.mjs turns ${ Math.max(1, Math.min(200, Math.floor(limit) || 25)) } 2>/dev/null`;
}

const TURNS_MARKER = /BARN-PROV:(.*)/;

export function parseTurns(out) {
  const found = TURNS_MARKER.exec(String(out || ''));

  if (!found) {
    return [];
  }

  try {
    const parsed = JSON.parse(found[1]);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
