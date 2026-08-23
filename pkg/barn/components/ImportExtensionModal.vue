<script>
// Bring an extension in from a repository.
//
// The sibling of NewExtensionModal, and deliberately the same shape: a name, a question about
// where the contents come from, and a button that hands the work back to the page. What it
// asks for instead of a seed is a repository, and what it produces is the same thing - a
// `source` string that `ensureExtension` knows how to satisfy (`github:owner/repo#branch`).
//
// So the two modals do not share a creation path so much as they share the only one there is:
// the page's onCreate takes whichever of them emitted, and neither knows what the other did.
//
// The GitHub credential is asked for here rather than behind a link to the settings dialog.
// The link was the honest thing when there was nowhere else to put a token, but taking it
// unmounted this modal and threw away everything typed into it, so somebody who discovered
// mid-form that they needed a token paid for it with the form. A token is three lines of state
// and the field that takes it is the same field either way.
//
// The design (Figma 15:358, and 15:630 for the first run) draws that as a three-step wizard:
// connect, choose a repository, then branch and name with a check on what you chose. The three
// steps are the order the work actually happens in, and the markers are the only thing that
// says a first-time user is at the start of something rather than looking at a form with a
// warning on it.
//
// The account row and the repository list are both read from the pod rather than from this
// page, and that is the whole reason they exist. The token is written into a Secret that
// `readSettings` never hands back, so nothing in the browser can ask GitHub anything - but a
// pod in this cluster has the Secret in its environment, and `githubIdentity` and
// `listGithubRepos` in `extensions.ts` ask from there. So step 1 can name the account, its
// scopes and its expiry, and step 2 can be the list the design draws.
//
// What that does NOT do is make the token a prerequisite for importing. A public repository
// clones with no credential at all, so the field that takes `owner/name` or any of the nine
// URL shapes `parseGithubRepoInput` accepts stays underneath the list and keeps working with
// no token, no pod and no listing. The list is the fast path, not the only path.
//
// One thing the design draws is still not here, and the gap is deliberate:
//
//   "Authorise with GitHub". OAuth needs an OAuth app, and this product has no server of its
//   own and no client id to authorise against. A button that opened nothing would be worse
//   than the token field being the whole of it, so the token field is the whole of it and step
//   1 says why.
import {
  SModal, SButton, SField, SBanner, SIcon
} from './ui';
import ImportStep from './ImportStep.vue';
import {
  normalizeExtensionName, listExtensions, readSettings, saveSettings, parseGithubRepoInput,
  githubIdentity, listGithubRepos
} from '../extensions';
import { inspectRepository, rancherVersion, versionSkew } from '../import-check';

/** Long enough that typing `owner/name` does not clone three times on the way through. */
const CHECK_DELAY = 600;

/**
 * How many repositories to ask for.
 *
 * `listGithubRepos` caps at 100, which is GitHub's own page size, so this is the whole of one
 * page of the most recently updated. Anything older than that is named or pasted into the
 * field below the list, and the note under the list says so when the page comes back full.
 */
const REPO_LIMIT = 100;

/** Month names for "Updated in April", which is how the design words anything last year. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * The design's three last-updated wordings, from an ISO timestamp.
 *
 * "Updated 3 days ago" close up, "Updated last month" just past that, and "Updated in April"
 * for anything older, because at that distance the month is what somebody is actually
 * comparing rows on and a day count stops meaning anything.
 */
function updatedAgo(iso) {
  const then = Date.parse(iso || '');

  if (!Number.isFinite(then)) {
    return '';
  }

  const when = new Date(then);
  const now = new Date();
  const days = Math.floor((now.getTime() - then) / 86400000);

  if (days <= 0) {
    return 'Updated today';
  }

  if (days === 1) {
    return 'Updated yesterday';
  }

  if (days < 30) {
    return `Updated ${ days } days ago`;
  }

  if (days < 60) {
    return 'Updated last month';
  }

  const month = MONTHS[when.getMonth()];

  return when.getFullYear() === now.getFullYear()
    ? `Updated in ${ month }`
    : `Updated in ${ month } ${ when.getFullYear() }`;
}

/**
 * "expires in 58 days", from whatever GitHub put in its expiry header.
 *
 * That header is not ISO - it reads `2026-10-14 09:12:33 UTC` - so anything unparseable is
 * reported as nothing rather than as a wrong date. Empty means the row says the token does
 * not expire, which is a different sentence and belongs to the caller.
 */
function expiresIn(text) {
  const at = Date.parse((text || '').trim().replace(' UTC', ' GMT'));

  if (!Number.isFinite(at)) {
    return '';
  }

  const days = Math.round((at - Date.now()) / 86400000);

  if (days < 0) {
    return 'expired';
  }

  if (days === 0) {
    return 'expires today';
  }

  return `expires in ${ days } day${ days === 1 ? '' : 's' }`;
}

/** `a, b and c`. The check panel's two lists are read as prose, not as a bulleted set. */
function sentence(items) {
  return items.length < 2 ? items.join('') : `${ items.slice(0, -1).join(', ') } and ${ items[items.length - 1] }`;
}

/** Git's own words, and the pod's, arrive lowercase and unpunctuated. This panel is prose. */
function asSentence(text) {
  return text ? `${ text[0].toUpperCase() }${ text.slice(1) }`.replace(/\.?$/, '.') : '';
}

export default {
  name: 'ImportExtensionModal',

  components: {
    SModal, SButton, SField, SBanner, SIcon, ImportStep
  },

  emits: ['close', 'create'],

  data() {
    return {
      name:   '',
      repo:   '',
      branch: '',
      taken:  [],
      error:  '',
      // Whether there is a token. Unlike publishing, this does not stop an import: a public
      // repository clones without one. It only decides what step 1 says.
      hasToken: false,
      // Whether that has been asked yet. The wizard waits for it rather than guessing, because
      // both guesses are a claim: one locks steps 2 and 3 on a Rancher that is connected, and
      // the other opens them for a second and then takes them away.
      loaded:    false,
      importing: false,
      // The token disclosure: closed until somebody asks for it, because most imports are of
      // a public repository and do not need one.
      tokenOpen:   false,
      token:       '',
      savingToken: false,
      // Step 1 reopened by the Change button on the connected row. Separate from `tokenOpen`
      // because it also re-locks steps 2 and 3, which is the promise the button makes.
      changing: false,
      // Whose token it is, read from a pod by githubIdentity. Null until it has been asked, or
      // when there is no token to ask about. A failure here is reported rather than swallowed:
      // "a token is stored and Studio could not ask GitHub whose it is" is a fact worth having,
      // and it is not the same fact as "no token".
      identity:        null,
      identityLoading: false,
      identityError:   '',
      // The repository list the design draws, also from a pod. Loaded once per connection and
      // filtered here, because the whole list arrives in one call and a search that went back
      // to GitHub per keystroke would be a pod exec per keystroke.
      repos:        [],
      reposLoading: false,
      reposError:   '',
      reposLoaded:  false,
      repoSearch:   '',
      // Step 1 stepped over rather than completed. The design locks 2 and 3 until GitHub is
      // connected, and for a private repository that is exactly right - but a public one
      // genuinely clones with no credential at all, and locking that behind a token nobody
      // needs would be a wall this product does not have. So the lock is the default and this
      // is the way past it, said out loud.
      skipped: false,
      // Whether these two have been taken over by hand. Until they are, the repository fills
      // them, which is what makes the name a suggestion rather than a third thing to type.
      nameDirty:   false,
      branchDirty: false,
      // The branch listing and the pre-import check are the same look at the repository, so
      // they arrive together. See runCheck.
      branches:      [],
      defaultBranch: '',
      branchOther:   false,
      check:         null,
      checking:      false,
      checkError:    '',
      /** `repo#branch` of the look that produced `check`, so nothing is looked at twice. */
      checkedKey: '',
      checkSeq:   0,
      checkTimer: null,
      rancher:    '',
    };
  },

  computed: {
    /** Step 1 is satisfied: a token is stored and nobody is in the middle of replacing it. */
    connected() {
      return this.hasToken && !this.changing;
    },

    /** Whether steps 2 and 3 are open for input. */
    unlocked() {
      return this.connected || this.skipped;
    },

    /** Steps 2 and 3 open and close together: connecting is what gates both of them. */
    openState() {
      return this.unlocked ? 'active' : 'locked';
    },

    // What the field means, which is more than what it says: the natural paste is the URL out
    // of the browser bar, and that is a repository too. See parseGithubRepoInput.
    parsed() {
      return parseGithubRepoInput(this.repo);
    },

    repoPath() {
      return this.parsed?.repo || '';
    },

    parsedBranch() {
      return this.parsed?.branch || '';
    },

    repoInvalid() {
      return !!this.repo.trim() && !this.parsed;
    },

    /**
     * What the field made of what is in it, and before anything is, why it is still a field.
     *
     * The list above is the fast path. This is the one for a repository that is not on it -
     * somebody else's public repository, or anything past the hundred most recent - and for a
     * Rancher with no token stored at all, where there is no list to pick from.
     */
    repoHint() {
      if (!this.repo.trim()) {
        return this.repos.length
          ? 'Or name one that is not on the list, or paste its URL.'
          : 'Name the one you want, or paste its URL.';
      }

      return this.repoPath && this.repoPath !== this.repo.trim() ? `Reads as ${ this.repoPath }.` : '';
    },

    /** The handle in the connected row, once a pod has been asked whose token this is. */
    accountName() {
      return this.identity?.login || '';
    },

    /**
     * `repo · read:org · expires in 58 days`, and honest about each of the three separately.
     *
     * A fine-grained token lists no scopes at all - GitHub sends the header empty - so the row
     * says that rather than showing a blank where the permissions go. Same for the expiry: no
     * header means the token does not expire, which is a fact and not a gap.
     */
    accountMeta() {
      if (!this.identity) {
        return '';
      }

      const parts = this.identity.scopes.length
        ? [...this.identity.scopes]
        : ['no scopes listed, so a fine-grained token'];
      const expiry = expiresIn(this.identity.expiresAt);

      parts.push(expiry || (this.identity.expiresAt ? 'expiry unreadable' : 'does not expire'));

      return parts.join(' · ');
    },

    /** Whether step 2 can have a list at all: the pod needs a token to ask GitHub with. */
    canList() {
      return this.hasToken;
    },

    /** The listing's row for whatever is chosen, when the chosen thing is on the listing. */
    listedRepo() {
      return this.repos.find((each) => each.fullName === this.repoPath) || null;
    },

    /** The list, narrowed by the search box. Matched on owner/name, which is what is drawn. */
    visibleRepos() {
      const needle = this.repoSearch.trim().toLowerCase();

      return needle ? this.repos.filter((each) => each.fullName.toLowerCase().includes(needle)) : this.repos;
    },

    /**
     * The line under the list, which says something different in each of the four states it
     * has: no token to list with, still asking, the ask failed, and a full page that is
     * therefore probably not all of them.
     */
    listNote() {
      if (!this.canList) {
        return 'Studio can only list your repositories when a token is stored, because the ' +
          'listing is fetched by the pod that holds it. Without one, name the repository below ' +
          'or paste its URL - a public one clones with no token at all.';
      }

      if (this.reposError) {
        return `${ asSentence(this.reposError) } Name the repository below or paste its URL instead.`;
      }

      if (this.reposLoading || !this.reposLoaded) {
        return '';
      }

      if (!this.repos.length) {
        return 'This token can see no repositories. Name the one you want below or paste its URL.';
      }

      // Nothing matching at all is said where the rows would be, so it is not said twice.
      if (this.visibleRepos.length && this.visibleRepos.length !== this.repos.length) {
        return `${ this.visibleRepos.length } of ${ this.repos.length } match.`;
      }

      if (!this.visibleRepos.length) {
        return '';
      }

      return this.repos.length >= REPO_LIMIT
        ? `The ${ REPO_LIMIT } most recently updated. Anything older is named below or pasted as a URL.`
        : '';
    },

    // What the name will actually be. Applied rather than rejected, the same way the header's
    // box does it: somebody typing "My Thing" means an extension, not a validation error.
    normalized() {
      return normalizeExtensionName(this.name);
    },

    nameTaken() {
      return !!this.normalized && this.taken.includes(this.normalized);
    },

    nameHint() {
      if (!this.normalized) {
        return '';
      }

      if (this.normalized !== this.name) {
        return `It will be called ${ this.normalized }.`;
      }

      return this.nameDirty ? '' : 'Taken from the repository. Change it to call it something else here.';
    },

    /** The branch control is a list when the check found one, and a field the rest of the time. */
    branchListed() {
      return this.branches.length > 0 && !this.branchOther;
    },

    /**
     * The list, plus whatever is in the control if it is not on it.
     *
     * A branch typed before the listing arrived, and which turns out not to exist, has to stay
     * visible in the control: dropping it would show a select with a different branch selected
     * than the one the check panel is complaining about.
     */
    branchOptions() {
      const current = this.branch.trim();

      return current && !this.branches.includes(current) ? [current, ...this.branches] : this.branches;
    },

    branchHint() {
      if (this.branchListed) {
        return this.branch && this.branch === this.defaultBranch ? "The repository's default." : '';
      }

      return this.branches.length
        ? 'Typed rather than chosen. It has to be a branch that exists.'
        : "Leave blank for the repository's default.";
    },

    /**
     * A branch name git will accept, checked here rather than discovered in the clone.
     *
     * Whether the branch *exists* is a separate question and a better one, and the check below
     * answers it - but only for a repository GitHub will show us. The shapes git refuses
     * outright are knowable without asking anybody, so they are still worth catching first.
     */
    branchInvalid() {
      const branch = this.branch.trim();

      if (!branch) {
        return false;
      }

      return !/^[\w./-]+$/.test(branch) || /^[./-]|[./]$|\.\.|\.lock$|\/\//.test(branch);
    },

    /** How this Rancher compares with the one the repository says it was built against. */
    skew() {
      if (!this.check || !this.check.reachable || !this.check.packagePath) {
        return null;
      }

      return versionSkew(this.check.declaredRancher, this.rancher);
    },

    /** Which of the four things the check panel is saying. */
    checkTone() {
      if (this.checking) {
        return 'checking';
      }

      if (this.checkError) {
        return 'unknown';
      }

      if (!this.check) {
        return '';
      }

      if (!this.check.reachable || this.check.error) {
        return 'unknown';
      }

      return this.check.extension ? 'pass' : 'warn';
    },

    checkHead() {
      if (this.checking) {
        return `Looking at ${ this.repoPath }...`;
      }

      if (this.checkError) {
        return 'Studio could not run the check.';
      }

      if (!this.check) {
        return '';
      }

      if (!this.check.reachable) {
        return `Studio could not see ${ this.check.repo } on GitHub.`;
      }

      if (this.branchMissing) {
        return `${ this.check.repo } has no branch called ${ this.branch.trim() }.`;
      }

      if (this.check.error) {
        return `Studio could not read ${ this.check.repo }.`;
      }

      return this.check.extension ? 'This looks like a Rancher extension.' : 'This does not look like a Rancher extension.';
    },

    /** The one line under the verdict. Empty while the check is still running. */
    checkBody() {
      if (this.checking) {
        return 'Cloning it into a pod without its file contents, which takes a couple of seconds.';
      }

      if (this.checkError) {
        return `${ asSentence(this.checkError) } Import can still go ahead, and this panel is claiming nothing about the repository.`;
      }

      if (!this.check) {
        return '';
      }

      if (!this.check.reachable) {
        // The listing says outright whether a repository is private, so where the chosen one
        // came off the list this stops being a guess about why the check went blind.
        if (this.listedRepo?.private) {
          return 'It is private, and this check runs without the stored token, so it cannot read it. The import itself does use the token.';
        }

        return this.hasToken
          ? 'This check runs without the stored token, so a private repository always lands here. The import itself uses the token and may well work.'
          : 'It may be private, in which case connect GitHub in step 1 and the import will still work even though this check cannot see it. Otherwise the name is wrong.';
      }

      if (this.branchMissing) {
        return `Choose one of its ${ this.check.branches.length } branches instead. Import is off until you do, because the clone would fail on it.`;
      }

      if (this.check.error) {
        return asSentence(this.check.error);
      }

      if (!this.check.extension) {
        const missing = this.check.missing.length ? `Did not find ${ sentence(this.check.missing) }. ` : '';

        return `${ missing }You can import it anyway, and the assistant will have to make an extension of it.`;
      }

      const found = this.check.found.length ? `Found ${ sentence(this.check.found) }.` : '';

      return `${ found } ${ this.skew?.text || '' }`.trim();
    },

    /**
     * A branch the repository provably does not have.
     *
     * The one thing the check learns that is worth stopping an import for. Everything else it
     * can say - that the repository does not look like an extension, that it could not be read
     * at all - is a caveat rather than a certainty, and the design draws Import enabled beside
     * the panel. This is not a caveat: `git clone --branch` will fail on it every time.
     */
    branchMissing() {
      const branch = this.branch.trim();

      return !!branch && !!this.check && this.check.reachable &&
        this.check.branches.length > 0 && !this.check.branches.includes(branch);
    },

    canImport() {
      return this.unlocked && !!this.normalized && !!this.repoPath && !this.nameTaken &&
        !this.branchInvalid && !this.branchMissing && !this.checking;
    },
  },

  watch: {
    /** The design's "taken from the repository": the name is a suggestion, not a prerequisite. */
    repoPath(value) {
      if (!this.nameDirty) {
        this.name = value ? value.split('/')[1] : '';
      }

      // A branch belongs to a repository. Carrying `main` over to a repository that calls it
      // `master` would run the check against a branch nobody chose and report that it is
      // missing, so the whole branch answer is dropped and asked again.
      this.branches = [];
      this.defaultBranch = '';
      this.branchOther = false;
      this.branchDirty = false;
      this.branch = this.parsedBranch;
      this.scheduleCheck();
    },

    /** A pasted `/tree/<branch>` URL brought its branch with it. */
    parsedBranch(value) {
      if (!this.branchDirty) {
        this.branch = value;
      }
    },

    branch() {
      this.scheduleCheck();
    },

    unlocked(value) {
      if (value) {
        this.scheduleCheck();
      }
    },
  },

  async mounted() {
    // In parallel: the wizard cannot draw until it knows whether GitHub is connected, and
    // making that wait behind a list of extensions is a locked dialog for no reason.
    const [taken, settings, version] = await Promise.all([
      listExtensions().catch(() => []),
      // Any extension will do - the token is not one of theirs. See repoKey.
      readSettings('').catch(() => ({ hasToken: false })),
      rancherVersion().catch(() => ''),
    ]);

    this.taken = taken.map((each) => each.name);
    this.hasToken = settings.hasToken;
    this.rancher = version;
    this.loaded = true;

    // Both of these are a pod exec, so they are started after the wizard has drawn rather than
    // before it: the dialog opening must not wait on GitHub answering.
    this.loadAccount();
  },

  beforeUnmount() {
    clearTimeout(this.checkTimer);
    this.checkSeq += 1;
  },

  methods: {
    /**
     * Ask a pod who the stored token belongs to, and what it can see.
     *
     * One entry point for both halves because they are one question with two answers, and they
     * become stale at the same moment: a token being replaced changes the account AND the
     * repositories, so `connect` calls this rather than either of them.
     */
    loadAccount() {
      this.identity = null;
      this.identityError = '';
      this.repos = [];
      this.reposError = '';
      this.reposLoaded = false;
      this.repoSearch = '';

      if (!this.hasToken) {
        return;
      }

      this.identityLoading = true;
      githubIdentity()
        .then((identity) => {
          this.identity = identity;
        })
        .catch((e) => {
          this.identityError = e?.message || String(e);
        })
        .finally(() => {
          this.identityLoading = false;
        });

      this.reposLoading = true;
      listGithubRepos(REPO_LIMIT)
        .then((repos) => {
          this.repos = repos;
          this.reposLoaded = true;
        })
        .catch((e) => {
          this.reposError = e?.message || String(e);
        })
        .finally(() => {
          this.reposLoading = false;
        });
    },

    /**
     * Choose a row.
     *
     * Straight into the same `repo` the field holds, rather than into a selection of its own,
     * so there is one answer to "which repository" and the highlight is derived from it. That
     * is also what makes typing `suse/cost-explorer-ext` into the field light its row up, and
     * what stops the two controls being able to disagree.
     */
    pickRepo(row) {
      if (this.importing) {
        return;
      }

      this.repo = row.fullName;
    },

    /** The design's lock and book: what the row says about who can see the repository. */
    repoIcon(row) {
      return row.private ? 'lock' : 'book';
    },

    updatedAgo,

    onNameInput(value) {
      this.name = value;
      this.nameDirty = true;
    },

    onBranchInput(value) {
      this.branch = value;
      this.branchDirty = true;
    },

    /**
     * Store the token and stay here.
     *
     * Straight into the same Secret the settings dialog writes, so which surface it was pasted
     * into makes no difference to what is stored or to what spends it.
     */
    async connect() {
      const token = this.token.trim();

      if (!token || this.savingToken) {
        return;
      }

      this.savingToken = true;
      this.error = '';

      try {
        await saveSettings('', { token });
        this.hasToken = true;
        this.tokenOpen = false;
        this.changing = false;
        this.token = '';
        // A different token is a different account and a different list of repositories.
        this.loadAccount();
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.savingToken = false;
      }
    },

    /** Step 1 back to its unconnected state, with steps 2 and 3 re-locked behind it. */
    change() {
      this.changing = true;
      this.skipped = false;
      this.tokenOpen = true;
    },

    keep() {
      this.changing = false;
      this.tokenOpen = false;
      this.token = '';
    },

    /**
     * Look at the repository, once the typing has stopped.
     *
     * Keyed on repository and branch together, because that pair is what gets cloned: a
     * keystroke that does not change either of them (a URL being tidied into `owner/name`, the
     * branch being filled in with the default the look just reported) must not start a second
     * one.
     */
    scheduleCheck() {
      const key = `${ this.repoPath }#${ this.branch.trim() }`;

      if (key === this.checkedKey) {
        return;
      }

      clearTimeout(this.checkTimer);
      this.checkSeq += 1;
      this.check = null;
      this.checkError = '';

      if (!this.unlocked || !this.repoPath || this.branchInvalid) {
        this.checking = false;

        return;
      }

      this.checking = true;
      this.checkTimer = setTimeout(() => this.runCheck(key), CHECK_DELAY);
    },

    async runCheck(key) {
      const seq = this.checkSeq;
      const repo = this.repoPath;
      const branch = this.branch.trim();

      try {
        const result = await inspectRepository(repo, branch);

        if (seq !== this.checkSeq) {
          return;
        }

        this.check = result;
        this.branches = result.branches || [];
        this.defaultBranch = result.defaultBranch || '';

        // Fill the control in with what was actually cloned, so the branch on screen is the
        // branch that will be imported. Claiming the key first keeps the watcher this sets off
        // from asking for the same look again.
        if (!branch && result.defaultBranch) {
          this.checkedKey = `${ repo }#${ result.defaultBranch }`;
          this.branch = result.defaultBranch;
        } else {
          this.checkedKey = key;
        }
      } catch (e) {
        if (seq !== this.checkSeq) {
          return;
        }

        this.checkError = e?.message || String(e);
        this.checkedKey = key;
      } finally {
        if (seq === this.checkSeq) {
          this.checking = false;
        }
      }
    },

    create() {
      if (!this.canImport || this.importing) {
        return;
      }

      this.importing = true;

      // The branch rides on the source rather than as a second argument, because everything
      // downstream of here passes one string around and a second one would have to be threaded
      // through all of it to be read in one place.
      const branch = this.branch.trim();
      const source = `github:${ this.repoPath }${ branch ? `#${ branch }` : '' }`;

      this.$emit('create', {
        name: this.normalized,
        source,
        done: () => {
          this.importing = false;
        },
      });
    },
  },
};
</script>

<template>
  <SModal
    title="Import an extension from GitHub"
    icon="github"
    :width="680"
    :busy="importing"
    @close="$emit('close')"
  >
    <div class="import-extension">
      <SBanner v-if="error" type="error" :message="error" />

      <p class="import-extension__lede">
        The repository is cloned into your workspace. Nothing is pushed back until you publish.
      </p>

      <p v-if="!loaded" class="import-extension__note">
        Checking whether GitHub is connected...
      </p>

      <ImportStep
        v-if="loaded"
        :index="1"
        :state="connected ? 'done' : 'active'"
        :title="connected ? 'GitHub connected' : 'Connect GitHub'"
      >
        <div
          v-if="connected"
          class="import-extension__account"
          data-testid="barn-import-account"
        >
          <SIcon name="github" :size="16" />

          <p v-if="accountName" class="import-extension__account-name" data-testid="barn-import-account-login">
            {{ accountName }}
          </p>

          <p
            v-if="accountName"
            class="import-extension__account-meta"
            data-testid="barn-import-account-meta"
          >
            {{ accountMeta }}
          </p>

          <p v-else-if="identityLoading" class="import-extension__account-meta">
            Asking GitHub whose token this is...
          </p>

          <p v-else class="import-extension__account-meta">
            A token is stored, so a private repository clones too.
            {{ identityError ? `Studio could not read the account from it: ${ identityError }` : 'GitHub did not name an account for it.' }}
          </p>

          <span class="import-extension__grow" />

          <SButton
            variant="ghost"
            size="sm"
            data-testid="barn-import-change-connection"
            @click="change"
          >
            Change
          </SButton>
        </div>

        <template v-else>
          <p class="import-extension__connect-copy">
            Studio clones the repository from a pod in this cluster, which takes a few seconds
            and happens without leaving this dialog. A public repository needs nothing at all.
            A private one needs a token, and you can paste it here without losing what you have
            typed. There is no "Authorise with GitHub" because Studio has no OAuth app of its
            own to send you to.

            <a
              v-if="!tokenOpen"
              href="#"
              data-testid="barn-import-token-toggle"
              @click.prevent="tokenOpen = true"
            >Paste a personal access token</a>
          </p>

          <div v-if="tokenOpen" class="import-extension__token">
            <SField
              v-model="token"
              class="import-extension__token-field"
              input-testid="barn-import-token-field"
              label="Personal access token"
              type="password"
              placeholder="ghp_..."
              :disabled="savingToken"
              @enter="connect"
            />

            <p class="import-extension__token-help">
              Needs the <code>repo</code> scope only.
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&amp;description=Rancher%20Extension%20Studio"
                target="_blank"
                rel="noopener noreferrer"
              >Create one on GitHub with the scope pre-selected</a>. It is stored in a Secret in
              this Rancher, not in your browser, because the thing that spends it is a pod -
              which also means it is shared with everyone using this Rancher's Studio, not held
              per user.
            </p>

            <div class="import-extension__token-actions">
              <SButton
                variant="secondary"
                data-testid="barn-import-token-save"
                :loading="savingToken"
                :disabled="!token.trim()"
                @click="connect"
              >
                Connect
              </SButton>

              <SButton
                v-if="changing"
                variant="ghost"
                data-testid="barn-import-keep-connection"
                :disabled="savingToken"
                @click="keep"
              >
                Keep the one that is stored
              </SButton>
            </div>
          </div>
        </template>
      </ImportStep>

      <ImportStep v-if="loaded" :index="2" :state="openState" title="Choose a repository">
        <template #locked>
          <p class="import-extension__locked">
            Locked until GitHub is connected. A public repository needs no token, so
            <a
              href="#"
              data-testid="barn-import-skip-connect"
              @click.prevent="skipped = true"
            >carry on without connecting</a> if the one you want is public.
          </p>
        </template>

        <template v-if="canList">
          <!-- Only once there is a list. A search box over a listing that failed, or over an
               account with no repositories, is a control with nothing behind it. -->
          <div v-if="repos.length" class="import-extension__search">
            <SIcon name="search" :size="15" />
            <input
              v-model="repoSearch"
              class="import-extension__search-input"
              data-testid="barn-import-repo-search"
              placeholder="Search your repositories"
              aria-label="Search your repositories"
              :disabled="importing"
            >
          </div>

          <p v-if="reposLoading" class="import-extension__note">
            Asking GitHub for your repositories from a pod in this cluster...
          </p>

          <div
            v-else-if="visibleRepos.length"
            class="import-extension__repos"
            data-testid="barn-import-repo-list"
            role="listbox"
            aria-label="Your repositories"
          >
            <button
              v-for="each in visibleRepos"
              :key="each.fullName"
              type="button"
              class="import-extension__repo"
              :class="{ 'import-extension__repo--on': each.fullName === repoPath }"
              data-testid="barn-import-repo-row"
              :data-repo="each.fullName"
              :data-selected="each.fullName === repoPath ? 'true' : 'false'"
              role="option"
              :aria-selected="each.fullName === repoPath"
              :disabled="importing"
              :title="each.description || each.fullName"
              @click="pickRepo(each)"
            >
              <SIcon :name="repoIcon(each)" :size="14" />

              <span class="import-extension__repo-name">{{ each.fullName }}</span>
              <span class="import-extension__repo-meta">{{ each.private ? 'private' : 'public' }}</span>

              <span class="import-extension__grow" />

              <span class="import-extension__repo-meta">{{ updatedAgo(each.updatedAt) }}</span>

              <SIcon v-if="each.fullName === repoPath" name="check" :size="15" />
            </button>
          </div>

          <p v-else-if="reposLoaded && repos.length" class="import-extension__note">
            None of your {{ repos.length }} repositories match "{{ repoSearch.trim() }}".
          </p>
        </template>

        <p v-if="listNote" class="import-extension__note">
          {{ listNote }}
        </p>

        <SField
          v-model="repo"
          input-testid="barn-import-repo"
          label="GitHub repository"
          placeholder="owner/name, or paste the repository URL"
          :disabled="importing"
          :error="repoInvalid ? 'That has to be owner/name, or a github.com repository URL.' : ''"
          :hint="repoHint"
        />
      </ImportStep>

      <ImportStep v-if="loaded" :index="3" :state="openState" title="Branch and name">
        <div v-if="branchListed" class="import-extension__select">
          <label class="import-extension__select-label" for="barn-import-branch-select">Branch</label>

          <select
            id="barn-import-branch-select"
            v-model="branch"
            class="import-extension__select-input"
            data-testid="barn-import-branch-select"
            :disabled="importing"
            @change="branchDirty = true"
          >
            <option v-for="each in branchOptions" :key="each" :value="each">
              {{ each }}{{ each === defaultBranch ? ' (default)' : '' }}
            </option>
          </select>

          <SIcon name="chevronDown" :size="16" class="import-extension__select-chevron" />
        </div>

        <p v-if="branchListed && branchHint" class="import-extension__hint">
          {{ branchHint }}
        </p>

        <p v-if="branches.length" class="import-extension__hint">
          <a
            href="#"
            data-testid="barn-import-branch-other"
            @click.prevent="branchOther = !branchOther"
          >{{ branchOther ? 'Choose from the list instead' : 'Type a branch name instead' }}</a>
        </p>

        <SField
          v-if="!branchListed"
          input-testid="barn-import-branch"
          label="Branch"
          placeholder="the repository's default"
          :model-value="branch"
          :disabled="importing"
          :error="branchInvalid ? 'That is not a branch name git will accept.' : ''"
          :hint="branchHint"
          @update:model-value="onBranchInput"
        />

        <SField
          input-testid="barn-import-name"
          label="Name in Studio"
          placeholder="my-extension"
          :model-value="name"
          :disabled="importing"
          :error="nameTaken ? `${ normalized } already exists here.` : ''"
          :hint="nameHint"
          @update:model-value="onNameInput"
          @enter="create"
        />

        <div
          v-if="checkTone"
          class="import-extension__check"
          :class="`import-extension__check--${ checkTone }`"
          data-testid="barn-import-check"
          :data-tone="checkTone"
          role="status"
          aria-live="polite"
        >
          <SIcon
            :name="checkTone === 'pass' ? 'check' : (checkTone === 'checking' ? 'spinner' : 'alert')"
            :size="16"
            :class="{ 'import-extension__check-spin': checkTone === 'checking' }"
          />

          <div>
            <p class="import-extension__check-head">
              {{ checkHead }}
            </p>
            <p v-if="checkBody" class="import-extension__check-body">
              {{ checkBody }}
            </p>
          </div>
        </div>
      </ImportStep>
    </div>

    <template #footer>
      <SButton variant="ghost" :disabled="importing" @click="$emit('close')">
        Cancel
      </SButton>
      <SButton
        class="import-extension__submit"
        variant="primary"
        icon="download"
        data-testid="barn-import-submit"
        :loading="importing"
        :disabled="!canImport"
        @click="create"
      >
        Import
      </SButton>
    </template>
  </SModal>
</template>

<style lang="scss" scoped>
.import-extension {
  display:        flex;
  flex-direction: column;
  gap:            var(--studio-space-16);

  a { color: var(--studio-text-link); }

  &__lede {
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  // The connected row (15:546): mark, handle, scopes and expiry, then Change pushed right by
  // the spacer. It wraps rather than clipping, because the meta line is as long as the token's
  // scope list and a token with six scopes must not push the Change button off the dialog.
  &__account {
    display:     flex;
    align-items: center;
    flex-wrap:   wrap;
    gap:         var(--studio-space-8);
    color:       var(--studio-text-secondary);
  }

  &__grow { flex: 1 1 auto; }

  &__account-name {
    font:   var(--studio-body-13-semi);
    color:  var(--studio-text);
    margin: 0;
  }

  &__account-meta {
    font:      var(--studio-caption-12);
    color:     var(--studio-text-secondary);
    margin:    0;
    min-width: 0;
  }

  // The step 2 search box (15:559), the same shape the home screen's search uses so the two
  // read as one control rather than two different takes on a magnifier and a field.
  &__search {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    padding:       var(--studio-space-8) 10px;
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);
    color:         var(--studio-text-tertiary);

    // The design draws this focused, with a 2px blue border. Inset rather than grown, for the
    // reason SField gives: a border that thickens on focus moves the layout by a pixel.
    &:focus-within {
      border-color: var(--studio-border-focus);
      box-shadow:   inset 0 0 0 1px var(--studio-border-focus);
    }
  }

  &__search-input {
    flex:       1 1 auto;
    min-width:  0;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    font:       var(--studio-body-14);
    color:      var(--studio-text);

    &::placeholder { color: var(--studio-text-tertiary); }
  }

  // The repository list (15:564): a bordered card of rows divided by a hairline, capped in
  // height because a hundred rows would be taller than the dialog and the search box above it
  // is what narrows them down.
  &__repos {
    display:        flex;
    flex-direction: column;
    max-height:     220px;
    overflow-y:     auto;
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius-control);
  }

  &__repo {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-8);
    width:         100%;
    padding:       9px var(--studio-space-12);
    text-align:    left;
    background:    transparent;
    border:        none;
    border-bottom: 1px solid var(--studio-border-subtle);
    color:         var(--studio-text-secondary);
    cursor:        pointer;

    &:last-child { border-bottom: none; }

    &:hover:not(:disabled) { background: var(--studio-surface-subtle); }

    &:focus-visible {
      outline:        2px solid var(--studio-border-focus);
      outline-offset: -2px;
    }

    &:disabled { cursor: default; }

    // The chosen row (15:565), filled #EAF4FB with a check at its right edge.
    &--on,
    &--on:hover:not(:disabled) { background: var(--studio-blue-050); }
  }

  &__repo-name {
    font:          var(--studio-body-13-semi);
    color:         var(--studio-text);
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__repo-meta {
    font:      var(--studio-caption-12);
    color:     var(--studio-text-secondary);
    flex:      0 0 auto;
    // The updated time is the one thing on the row worth losing before the name is.
    min-width: 0;
  }

  &__connect-copy,
  &__locked,
  &__note,
  &__hint {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__note,
  &__hint { color: var(--studio-text-tertiary); }

  &__token {
    display:        flex;
    flex-direction: column;
    align-items:    flex-start;
    gap:            var(--studio-space-8);
    padding:        var(--studio-space-12);
    background:     var(--studio-surface-subtle);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius-control);
  }

  &__token-actions {
    display: flex;
    gap:     var(--studio-space-8);
  }

  // The design sets a pasted token in a monospace face, which is the right one for a string
  // nobody reads as words and everybody scans for a prefix.
  &__token-field :deep(.s-field__input) {
    font: var(--studio-mono-12);
  }

  &__token-help {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;

    code { font: var(--studio-mono-11); }
  }

  // The branch list, drawn as the same label-over-value box SField draws so the three controls
  // in step 3 read as one set. A native select rather than a popup: it is one choice from a
  // list that can be five hundred long, and the platform's own is the only one that stays
  // usable and keyboard-navigable at that size.
  &__select {
    position:       relative;
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    padding:        var(--studio-space-8) var(--studio-space-12);
    background:     var(--studio-surface);
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius-control);

    &:focus-within {
      border-color: var(--studio-border-focus);
      box-shadow:   inset 0 0 0 1px var(--studio-border-focus);
    }
  }

  &__select-label {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__select-input {
    appearance: none;
    border:     none;
    outline:    none;
    background: transparent;
    padding:    0;
    // Room for the chevron, which is drawn over the right edge rather than by the control.
    padding-right: var(--studio-space-20);
    font:       var(--studio-body-14);
    color:      var(--studio-text);
    width:      100%;
    cursor:     pointer;
  }

  &__select-chevron {
    position:       absolute;
    right:          var(--studio-space-12);
    bottom:         var(--studio-space-8);
    color:          var(--studio-text-secondary);
    pointer-events: none;
  }

  // The pre-import check (15:614). Only the passing state is drawn, so the other three take
  // the same shape in the status colour that matches what they are saying.
  &__check {
    display:               grid;
    grid-template-columns: 16px 1fr;
    gap:                   var(--studio-space-8);
    align-items:           start;
    padding:               var(--studio-space-12);
    border-radius:         var(--studio-radius-control);
    background:            var(--studio-neutral-bg);
    color:                 var(--studio-text-secondary);

    &--pass {
      background: var(--studio-success-bg);
      color:      var(--studio-success);
    }

    &--warn,
    &--unknown {
      background: var(--studio-warning-bg);
      color:      var(--studio-warning);
    }
  }

  &__check-head {
    font:   var(--studio-body-13-semi);
    margin: 0;
  }

  &__check-body {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: var(--studio-space-4) 0 0;
  }

  &__check-spin { animation: import-extension-spin 1s linear infinite; }

  // 0.4 rather than the primitive's 0.5, which is what the design draws for the gated Import
  // on the first-run frame (15:672).
  &__submit:disabled { opacity: 0.4; }
}

@keyframes import-extension-spin {
  to { transform: rotate(360deg); }
}
</style>
