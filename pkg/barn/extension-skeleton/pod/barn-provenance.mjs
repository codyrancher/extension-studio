// What produced each line of a change, recorded while it is being made.
//
// Step 3 and step 4 of scripts/feature-audit/REVIEW-SYSTEM.md. Cross-screen rule 8 asks that
// every hunk carry the prompt that produced it. Nothing in the pod knew that, because the only
// channel the product had into the assistant was `tmux send-keys`, which is write-only: it can
// record what it sent and nothing about what happened next. The pane's output is a character
// stream, and turning one into a sequence of typed events is a parser nobody has written.
//
// The honest boundary is claude's own hook interface, which is already load bearing in this pod
// (claude-defaults.mjs registers a Stop hook that shares a refreshed credential). Three hooks:
//
//   UserPromptSubmit  mints a turn id and records the prompt, with the origin stamp the
//                     product left if the prompt came from a screen rather than from the pane.
//   PostToolUse       records which files the turn's file-editing tools touched.
//   Stop              commits whatever the turn left dirty, with the turn id in a trailer, and
//                     clears the marker.
//
// The commit per turn is what converts a coarse signal into a precise one. Because every turn
// ends in a commit carrying its own id, `git blame` at review time gives every line in a hunk a
// commit, every commit gives a turn and every turn gives a prompt. That is exact, it is
// checkable by hand with git, and it degrades honestly.
//
// WHAT THIS DOES NOT CLAIM, and must not be "improved" into claiming:
//
//   - One prompt per hunk. What is recorded is per turn, resolved to per line by blame, so a
//     hunk answers with the set of turns that produced its lines. A `Write` rewrites a whole
//     file; the assistant frequently edits through `Bash`, where no file hook fires at all; a
//     person typing in the Terminal tab is seen by nothing.
//   - A line nobody watched. A line whose commit carries no `Barn-Turn:` trailer, or which
//     predates these hooks, reports as "changed in the pod, no prompt recorded". It is never
//     attributed to the nearest turn.
//   - A person for a prompt typed into the pane. The pod has one shared conversation and no
//     idea which Rancher user is looking at it. Only prompts the product itself sent, which
//     leave an origin stamp, carry a principal.
//   - Anything read out of claude's own transcript JSONL. It is richer than the hooks and it is
//     undocumented, and a provenance record that silently empties on a claude update is worse
//     than a coarser one that does not.
//
// Run as: node /seed/barn-provenance.mjs <prompt|touch|stop|report|turns> [arg]
// The three hook forms read claude's payload on stdin and print nothing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

// Outside the repository on purpose. It must never appear in `git status`, or the record of a
// change would be part of the change.
const BARN = '/app/.barn';
const LOG = path.join(BARN, 'provenance.jsonl');
const TURNS = path.join(BARN, 'turn');
const ORIGIN = path.join(BARN, 'origin');

/** The refs a diff is measured from, in the order extensions.ts resolves them. */
const BASELINE_REFS = ['refs/barn/published/oci', 'refs/barn/published/local'];

/** How much of a prompt is kept. Enough to recognise it; not so much that a paste fills the log. */
const PROMPT_LIMIT = 4000;

/**
 * Attributes worth turning into a selector.
 *
 * An allowlist rather than "anything with a value": `style`, `:class` and every Vue binding
 * are attributes too, and none of them find an element in the rendered document.
 *
 * The same list as SELECTABLE_ATTR in pkg/barn/extensions.ts, and the two `marksFor` /
 * `selectorsInDiff` readings around them are the same reading. Written twice because this file
 * runs in a pod with nothing but node and its own text, and because it opens with node:fs and
 * node:child_process, which no browser bundle can hold - neither side can import the other.
 * scripts/gen-extension-seed.mjs compares the two and refuses to build a seed once they differ,
 * so the duplication is checked rather than remembered.
 */
const SELECTABLE = /^(class|id|data-[\w-]+|name|role|aria-label|href|src|alt|title|type|placeholder|for)$/;

/**
 * The tree these hooks are about.
 *
 * Found rather than named, the same rule PACKAGE_DIR uses on the other side of this: a pod
 * serves whatever it was seeded, cloned or imported as, and the directory is called whatever
 * that package is called.
 */
function packageDir() {
  // The extension's own directory, by name, before any guessing.
  //
  // This used to take the first directory under /app/pkg, on the assumption that a pod holds
  // exactly one package. Pods created before extensions were renamed off their seed hold two:
  // `demo`'s pod has both /app/pkg/base and /app/pkg/demo, and readdir returns them
  // alphabetically. So this recorder committed demo's turns into base's repository and blamed
  // demo's hunks against base's history, which is why per-hunk provenance could never resolve a
  // line to a prompt even once the assistant was signed in and really working.
  //
  // `extensions.ts` was fixed to resolve by name and these pod-side scripts were not, so the two
  // halves of the product disagreed about which tree they were working in. EXTENSION_NAME is set
  // on the pod by the deployment that created it.
  const named = process.env.EXTENSION_NAME && path.join('/app/pkg', process.env.EXTENSION_NAME);

  if (named && fs.existsSync(path.join(named, '.git'))) {
    return named;
  }

  try {
    const dirs = fs.readdirSync('/app/pkg', { withFileTypes: true }).filter((e) => e.isDirectory());

    // Only when there is no ambiguity to get wrong. An imported repository keeps its upstream
    // package name, which need not match the extension, so one directory is still a fair guess -
    // picking alphabetically among several is not.
    if (dirs.length === 1) {
      return path.join('/app/pkg', dirs[0].name);
    }

    if (dirs.length > 1 && named) {
      return named;
    }

    if (dirs.length) {
      return path.join('/app/pkg', dirs[0].name);
    }
  } catch { /* no tree yet */ }

  return '';
}

const PKG = packageDir();

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: PKG || '/app', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options,
  });
}

/** Every git call here is on a best-effort path: a pod with no repository still records prompts. */
function tryGit(args, options = {}) {
  try {
    return git(args, options).trim();
  } catch {
    return '';
  }
}

function append(record) {
  try {
    fs.mkdirSync(BARN, { recursive: true });
    fs.appendFileSync(LOG, `${ JSON.stringify(record) }\n`);
  } catch { /* a hook that cannot write must still not fail the turn */ }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function payload() {
  try {
    return JSON.parse(readStdin() || '{}');
  } catch {
    return {};
  }
}

function turnFile(session) {
  // A session id is claude's own uuid, but the file name is sanitised anyway: this is a path
  // built from something another program chose.
  return path.join(TURNS, String(session || 'unknown').replace(/[^\w.-]/g, '_'));
}

function readTurn(session) {
  try {
    return fs.readFileSync(turnFile(session), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Where a prompt came from, consumed once.
 *
 * Written by `askAssistant()` immediately before it types, and deleted here, so it can only
 * ever describe the prompt it was written for. A prompt typed straight into the pane finds no
 * stamp and is recorded with no principal, which is the truth about it.
 */
function takeOrigin() {
  try {
    const raw = fs.readFileSync(ORIGIN, 'utf8');

    fs.rmSync(ORIGIN, { force: true });

    return JSON.parse(raw);
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Before and after
// ---------------------------------------------------------------------------

/** Where a turn's pictures go. Beside the pod's other durable state, on the hostPath. */
const SHOTS = '/app/.shots';

/**
 * How a skill's path is flattened into a ConfigMap key.
 *
 * A ConfigMap key cannot hold a slash, so `skills/barn-screenshot/screenshot.mjs` arrives
 * under /seed with this between its segments. The same constant shell.sh un-flattens with.
 */
const SKILL_SEP = '__PATH_SEPARATOR__';

/**
 * A Rancher session for the shared browser, written into the pod by the workspace.
 *
 * The browser that takes these pictures starts with an empty profile, so the cluster proxy
 * answers it "not authorized" without one. The pod is never told a password; this is a
 * short-lived token the page mints and refreshes while somebody has the workspace open, and an
 * expired one simply means the next picture is not taken.
 */
function captureToken() {
  try {
    return fs.readFileSync('/app/.home/.capture-token', 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Photograph the extension's own page, in the background.
 *
 * Detached and never waited for, because this runs inside a hook: a turn must not sit for the
 * twenty seconds a page load takes, and a picture that fails is a picture nobody gets rather
 * than a turn that broke. Everything it needs is already on this pod - the skill, the browser's
 * Service name, and the route - so the hook's only job is to say when.
 *
 * "When" is the whole point. A Before cannot be reconstructed after the edit: the dev server
 * serves the working tree and there is no second copy of the old rendering anywhere. So the
 * before shot is taken as the prompt arrives, while the page is still the old one.
 */
function shoot(label, marks = [], against = '') {
  const token = captureToken();
  const route = process.env.BARN_CAPTURE_ROUTE || '/';

  if (!token || !process.env.BARN_BROWSER_SERVICE) {
    return;
  }

  const skill = '/app/.home/.claude/skills/barn-screenshot/screenshot.mjs';

  // Refresh it from the mount first.
  //
  // `shell.sh` copies the skills out of /seed when a tab opens, which is the right moment for
  // a person's terminal and the wrong one for this: the assistant's tmux session outlives any
  // number of extension reloads, so a corrected capture script sat in /seed while every shot
  // went on being taken by the copy made when the session started - days old, in a pod nobody
  // had restarted. Copying here costs a stat and makes the picture always the current script's.
  const seeded = `/seed/skills${ SKILL_SEP }barn-screenshot${ SKILL_SEP }screenshot.mjs`;

  try {
    if (fs.existsSync(seeded)) {
      fs.mkdirSync(path.dirname(skill), { recursive: true });
      fs.copyFileSync(seeded, skill);
    }
  } catch { /* the copy in place is still worth running */ }

  if (!fs.existsSync(skill)) {
    return;
  }

  try {
    fs.mkdirSync(SHOTS, { recursive: true });

    const args = [skill, '--path', route, '--token', token, '--output', `${ SHOTS }/${ label }.png`];

    for (const mark of marks) {
      args.push('--note', `${ mark }=changed here`);
    }

    // The other half of "outline what changed". The selectors above only exist when the patch
    // named something; when it did not - a computed property, a stylesheet, a deleted line -
    // the capture compares the elements of this rendering against the ones recorded beside
    // the picture taken before the prompt, and outlines the ones that differ. Passed always:
    // it costs nothing when the marks above already matched, because the capture only falls
    // back when they found nothing.
    if (against && fs.existsSync(against)) {
      args.push('--diff-against', against);
    }

    const child = spawn('node', args, { detached: true, stdio: 'ignore' });

    child.unref();
  } catch { /* a picture is evidence, not a step of the turn */ }
}


/**
 * What this commit named, for the after shot to outline.
 *
 * A changed template line carrying `class="..."`, `data-testid="..."` or `id="..."` names
 * something that is in the rendered document by that exact string, so an outline on it is a
 * match rather than a guess.
 *
 * Added lines only, and only the after shot gets them: the thing they name does not exist in
 * the before rendering, which is the entire point of there being two pictures.
 */
function marksFor(sha) {
  const patch = tryGit(['show', '--unified=0', '--no-color', sha]);
  const found = new Set();

  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }

    // Any attribute that is also a way to find the element in the rendered document. It was
    // three of them; a change that adds `role="alert"` or `aria-label="Close"` names its
    // element just as exactly as one that adds a class.
    // The leading whitespace is load bearing: without it `:class="x"` matches as the plain
    // attribute `class`, and a Vue binding's expression became a class selector - `.x` - that
    // is in no rendered document anywhere.
    for (const m of line.matchAll(/\s([a-zA-Z][a-zA-Z0-9-]*)="([^"]+)"/g)) {
      const [, attr, value] = m;

      if (value.includes('{') || !SELECTABLE.test(attr)) {
        continue;
      }

      if (attr === 'class') {
        const first = value.trim().split(/\s+/)[0];

        if (first) {
          found.add(`.${ first }`);
        }
      } else if (attr === 'id') {
        found.add(`#${ value }`);
      } else {
        found.add(`[${ attr }="${ value }"]`);
      }
    }

    // A changed style rule names its own subject. `.trend-source-note { color: red }` is a
    // CSS selector and a DOM selector at once, so a stylesheet-only change - which has no
    // template diff at all - can still say what it was about.
    const rule = /^\+\s*([.#][\w-][\w-]*(?:[\s>+~][^{]*)?)\s*\{/.exec(line);

    if (rule) {
      const first = rule[1].trim().split(/[\s>+~,]/)[0];

      if (first && first.length > 1) {
        found.add(first);
      }
    }
  }

  // Nothing named, but something still changed.
  //
  // The attributes above only exist on a line that introduced or renamed an element. A change
  // that edits what an element *says* - the commonest kind, and the one somebody is most
  // likely to want circled - touches no attribute at all, so the after shot came back with no
  // outline on it and the pane had nothing to make clickable. Retitling the page from "Node
  // condition trends" to "Trends" produced exactly that: two pictures, an obvious difference
  // between them, and no mark on either.
  //
  // So: fall back to the text the change added. It is located in the rendered document by
  // matching the string itself (see the `text:` branch in the capture's annotation script),
  // which is exact rather than a guess - that string is in the page because this change put
  // it there.
  if (!found.size) {
    for (const text of textMarks(patch)) {
      found.add(`text:${ text }`);
    }
  }

  return [...found].slice(0, 6);
}

/**
 * The visible strings an added template line introduced.
 *
 * Deliberately narrow, because a false match outlines the wrong part of the page and that is
 * worse than outlining nothing:
 *
 *   - Only `>text<` on an added line, so it is template content rather than script or style.
 *   - Nothing holding `{{ }}` or `${`, which renders as something other than what is written.
 *   - Nothing shorter than 3 characters, which matches half the page by accident.
 *   - Nothing longer than 120, which is a paragraph the capture would circle whole.
 */
function textMarks(patch) {
  const out = new Set();

  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }

    for (const m of line.matchAll(/>([^<>{}]+)</g)) {
      const text = m[1].trim();

      if (text.length >= 3 && text.length <= 120 && !text.includes('$')) {
        out.add(text);
      }
    }
  }

  return [...out].slice(0, 3);
}

/** The before shot's name while the turn is running, before there is a commit to file it under. */
function pendingShot(turn) {
  return `${ SHOTS }/pending-${ turn }.png`;
}

// ---------------------------------------------------------------------------
// The three hooks
// ---------------------------------------------------------------------------

function hookPrompt() {
  const input = payload();
  const session = input.session_id || '';
  const turn = `t${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 7) }`;
  const origin = takeOrigin();

  try {
    fs.mkdirSync(TURNS, { recursive: true });
    fs.writeFileSync(turnFile(session), turn);
  } catch { /* the record below is still worth having without it */ }

  // Before the assistant has touched anything. This is the only moment the old rendering
  // exists, so it is the only moment it can be photographed.
  shoot(`pending-${ turn }`);

  append({
    kind:      'prompt',
    turn,
    session,
    at:        new Date().toISOString(),
    prompt:    String(input.prompt || '').slice(0, PROMPT_LIMIT),
    // Only ever what the product itself stamped. Never inferred.
    screen:    origin?.screen || '',
    principal: origin?.principal || '',
    who:       origin?.name || '',
    head:      tryGit(['rev-parse', 'HEAD']),
  });
}

function hookTouch() {
  const input = payload();
  const session = input.session_id || '';
  const turn = readTurn(session);
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path || '';

  if (!file) {
    return;
  }

  append({
    kind: 'touch',
    turn,
    session,
    at:   new Date().toISOString(),
    tool: input.tool_name || '',
    // Relative to the package, which is how every path in a diff is spelled.
    path: PKG && file.startsWith(`${ PKG }/`) ? file.slice(PKG.length + 1) : file,
  });
}

/**
 * End of turn: commit what it left behind, under its own id.
 *
 * Everything dirty, not only what a tool hook saw. The assistant edits through `Bash` as often
 * as through `Edit`, and a person may have typed in the pane; those files are part of what the
 * turn left and belong in the same commit. What separates them at review time is the `touch`
 * records above: a file in the commit that no tool touched is reported as swept into the turn
 * rather than caused by it.
 */
function hookStop() {
  const input = payload();
  const session = input.session_id || '';
  const turn = readTurn(session);

  try {
    fs.rmSync(turnFile(session), { force: true });
  } catch { /* nothing to clear */ }

  if (!turn || !PKG || !fs.existsSync(path.join(PKG, '.git'))) {
    return;
  }

  // The prompt this turn started with, for the commit's subject line. A commit called
  // "assistant turn" tells a reader nothing, and the prompt is already recorded.
  const prompt = lastPromptFor(turn);
  const subject = (prompt?.prompt || 'Assistant turn').split('\n')[0].trim().slice(0, 72) || 'Assistant turn';

  tryGit(['add', '-A']);

  // Nothing staged is the common case: a turn that answered a question changed no files.
  try {
    git(['diff', '--cached', '--quiet']);

    append({
      kind: 'turn', turn, session, at: new Date().toISOString(), commit: '', files: [],
    });

    return;
  } catch { /* there is something to commit */ }

  // The blank line is load bearing and is built separately from the trailers for that reason:
  // filtering the absent ones out of one flat list also filtered out the separator, and a
  // message with no blank line is one paragraph, so git reads the trailers as part of the
  // subject and every screen shows a commit titled "Make it bold Barn-Turn: t123 ...".
  const trailers = [
    `Barn-Turn: ${ turn }`,
    `Barn-Session: ${ session }`,
    prompt?.screen ? `Barn-Origin: ${ prompt.screen }` : '',
    prompt?.principal ? `Barn-Principal: ${ prompt.principal }` : '',
  ].filter(Boolean);
  const message = `${ subject }\n\n${ trailers.join('\n') }\n`;

  // The committer is the product, not the person: the pod has one shared identity and naming a
  // Rancher user as the git author of a turn they may only have started would be a claim this
  // cannot back. Who asked is in the trailer, where it is qualified by having been recorded
  // only when the product sent the prompt.
  let sha = '';

  try {
    git(['-c', 'user.email=barn@rancher.local', '-c', 'user.name=barn', 'commit', '-q', '-m', message]);
    sha = tryGit(['rev-parse', 'HEAD']);
  } catch {
    // A commit that would not go in (a hook, a lock, a tree that is not a repository after
    // all) leaves the turn recorded with no commit, which reads downstream as lines nobody
    // can attribute rather than as lines attributed to the wrong turn.
    sha = '';
  }

  const files = sha ? tryGit(['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean) : [];

  // The pair, filed under the commit they belong to.
  //
  // The before shot was taken as the prompt arrived and named after the turn, because there was
  // no commit yet to name it after; now there is. Renamed rather than re-taken - the rendering
  // it holds no longer exists anywhere - and the after shot is taken now, against the tree this
  // commit just captured.
  //
  // Its sidecars move with it. The snapshot beside a picture is the record of what the page
  // *was* - every element, where it sat and what it said - and it is what the after shot
  // compares itself against to find the elements that changed. Left behind under the turn's
  // name it would be a file nothing ever looks at, and the comparison would have nothing to
  // compare.
  //
  // Only when there is a commit. A turn that answered a question changed nothing, so the two
  // pictures would be the same picture, and a Before that equals its After is worse than none.
  if (sha) {
    for (const suffix of ['', '.json', '.snapshot.json']) {
      try {
        if (fs.existsSync(pendingShot(turn) + suffix)) {
          fs.renameSync(pendingShot(turn) + suffix, `${ SHOTS }/${ sha }-before.png${ suffix }`);
        }
      } catch { /* the after shot is still worth taking */ }
    }

    shoot(`${ sha }-after`, marksFor(sha), `${ SHOTS }/${ sha }-before.png`);
  } else {
    for (const suffix of ['', '.json', '.snapshot.json']) {
      try {
        fs.rmSync(pendingShot(turn) + suffix, { force: true });
      } catch { /* nothing to clear */ }
    }
  }

  append({
    kind: 'turn', turn, session, at: new Date().toISOString(), commit: sha, files,
  });
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

function readLog() {
  let raw = '';

  try {
    raw = fs.readFileSync(LOG, 'utf8');
  } catch {
    return [];
  }

  return raw.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      // A line half-written by a hook that was killed. One record lost is better than the
      // whole log being unreadable.
      return null;
    }
  }).filter(Boolean);
}

function lastPromptFor(turn) {
  const prompts = readLog().filter((r) => r.kind === 'prompt' && r.turn === turn);

  return prompts.length ? prompts[prompts.length - 1] : null;
}

function baseline() {
  for (const ref of BASELINE_REFS) {
    const sha = tryGit(['rev-parse', '--verify', '-q', ref]);

    if (sha) {
      return { ref, sha };
    }
  }

  return { ref: 'HEAD', sha: tryGit(['rev-parse', '--verify', '-q', 'HEAD']) };
}

/**
 * The hunks of the collapsed diff, with the turns that produced their lines.
 *
 * `-U0` because the question is which lines changed, and context lines were produced by
 * whatever produced them before this change - blaming them would attribute somebody else's
 * work to this turn.
 */
function report() {
  const base = baseline();

  if (!base.sha) {
    return {
      available: false, reason: 'this extension has no git history yet', base: '', baseRef: '', files: [],
    };
  }

  tryGit(['add', '-A', '-N']);

  const diff = tryGit(['diff', '-U0', '--no-renames', base.sha]);
  const files = [];
  let current = null;

  diff.split('\n').forEach((line) => {
    const header = /^\+\+\+ b\/(.*)$/.exec(line);

    if (header) {
      current = { path: header[1], hunks: [] };
      files.push(current);

      return;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (hunk && current) {
      const from = parseInt(hunk[1], 10);
      const count = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);

      current.hunks.push({
        from, to: count ? from + count - 1 : from, added: count,
      });
    }
  });

  // Every commit blame names, resolved once. A file with fifty hunks would otherwise ask git
  // about the same three commits fifty times.
  const commits = new Map();
  const resolve = (sha) => {
    if (commits.has(sha)) {
      return commits.get(sha);
    }

    // %x1f between the fields, because a commit body contains newlines and a trailer parsed
    // out of `--format` comes back with one of its own.
    const raw = tryGit(['show', '-s', '--format=%an%x1f%aI%x1f%s%x1f%B', sha]);
    const [author = '', at = '', subject = '', body = ''] = raw.split('\x1f');
    const trailer = (key) => (new RegExp(`^${ key }:\\s*(.+)$`, 'm').exec(body)?.[1] || '').trim();
    const entry = {
      sha,
      author,
      at,
      subject,
      turn:      trailer('Barn-Turn'),
      session:   trailer('Barn-Session'),
      screen:    trailer('Barn-Origin'),
      principal: trailer('Barn-Principal'),
    };

    commits.set(sha, entry);

    return entry;
  };

  const log = readLog();
  const promptFor = new Map();
  const touchedIn = new Map();

  log.forEach((record) => {
    if (record.kind === 'prompt' && record.turn) {
      promptFor.set(record.turn, record);
    }

    if (record.kind === 'touch' && record.turn && record.path) {
      if (!touchedIn.has(record.turn)) {
        touchedIn.set(record.turn, new Set());
      }

      touchedIn.get(record.turn).add(record.path);
    }
  });

  files.forEach((file) => {
    file.hunks.forEach((hunk) => {
      const byTurn = new Map();
      let unrecorded = 0;

      if (!hunk.added) {
        // A pure deletion has no line in the new file to blame. The lines it removed belong to
        // whatever wrote them, which is not what this change did.
        hunk.turns = [];
        hunk.unrecorded = 0;
        hunk.deletion = true;

        return;
      }

      const blame = tryGit(['blame', '--porcelain', '-L', `${ hunk.from },${ hunk.to }`, '--', file.path]);

      blame.split('\n').forEach((line) => {
        const m = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);

        if (!m) {
          return;
        }

        const sha = m[1];

        // git's zero sha is "not committed yet": the line is in the working tree and in no
        // commit, so there is no trailer to read and nothing to attribute it to.
        if (/^0+$/.test(sha)) {
          unrecorded += 1;

          return;
        }

        const commit = resolve(sha);

        if (!commit.turn) {
          unrecorded += 1;

          return;
        }

        const existing = byTurn.get(commit.turn) || {
          turn:      commit.turn,
          prompt:    promptFor.get(commit.turn)?.prompt || '',
          at:        promptFor.get(commit.turn)?.at || commit.at,
          screen:    commit.screen || promptFor.get(commit.turn)?.screen || '',
          principal: commit.principal || promptFor.get(commit.turn)?.principal || '',
          who:       promptFor.get(commit.turn)?.who || '',
          subject:   commit.subject,
          lines:     0,
          // A file the turn's commit contains but which no tool record names was swept into
          // the turn rather than caused by it: a `Bash` edit, or somebody typing in the pane.
          swept:     !(touchedIn.get(commit.turn) || new Set()).has(file.path),
        };

        existing.lines += 1;
        byTurn.set(commit.turn, existing);
      });

      hunk.turns = [...byTurn.values()].sort((a, b) => b.lines - a.lines);
      hunk.unrecorded = unrecorded;
    });
  });

  return {
    available: true,
    reason:    '',
    base:      base.sha,
    baseRef:   base.ref,
    files:     files.filter((f) => f.hunks.length),
  };
}

/**
 * The turns themselves, newest first: what the workspace's activity stream shows.
 *
 * Read out of the log rather than parsed out of the pane, which is why it can be shown at all.
 */
function turns(limit) {
  const log = readLog();
  const byTurn = new Map();

  log.forEach((record) => {
    if (!record.turn) {
      return;
    }

    const entry = byTurn.get(record.turn) || {
      turn: record.turn, prompt: '', at: '', endedAt: '', screen: '', principal: '', who: '', files: [], commit: '',
    };

    if (record.kind === 'prompt') {
      entry.prompt = record.prompt;
      entry.at = record.at;
      entry.screen = record.screen;
      entry.principal = record.principal;
      entry.who = record.who;
    }

    if (record.kind === 'touch' && record.path && !entry.files.includes(record.path)) {
      entry.files.push(record.path);
    }

    if (record.kind === 'turn') {
      entry.endedAt = record.at;
      entry.commit = record.commit;

      (record.files || []).forEach((f) => {
        if (!entry.files.includes(f)) {
          entry.files.push(f);
        }
      });
    }

    byTurn.set(record.turn, entry);
  });

  return [...byTurn.values()]
    .filter((t) => t.at || t.endedAt)
    .sort((a, b) => String(b.at || b.endedAt).localeCompare(String(a.at || a.endedAt)))
    .slice(0, limit);
}

// A marker line, because the exec that reads this also carries whatever git wrote to stdout on
// the way past. The caller looks for the marker rather than trying to parse the whole stream.
function emit(value) {
  process.stdout.write(`BARN-PROV:${ JSON.stringify(value) }\n`);
}

const [command, argument] = process.argv.slice(2);

switch (command) {
case 'prompt':
  hookPrompt();
  break;
case 'touch':
  hookTouch();
  break;
case 'stop':
  hookStop();
  break;
case 'report':
  emit(report());
  break;
case 'turns':
  emit(turns(parseInt(argument, 10) || 25));
  break;
default:
  process.stderr.write('usage: barn-provenance.mjs <prompt|touch|stop|report|turns>\n');
  process.exit(2);
}
