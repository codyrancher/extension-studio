<script>
// Studio settings (Figma frame 21:739): connection, sign-off policy, the assistant's permission
// level, where previews run, who can get in, and what leaves this Rancher for the model.
//
// The design's own caption is "in one place", which is a requirement rather than a description:
// the dialog that used to be the Studio's settings is now a credential prompt and nothing else
// (components/EditorSettingsModal.vue), so nothing but this page edits a setting.
//
// Two rules this page is written to, and both of them cost features:
//
//   1. There is no Save button anywhere. Everything that can be changed is written when it is
//      changed, which is only honest if the write is real - so a control that cannot be backed
//      is drawn disabled with the reason next to it rather than drawn live and dropped on the
//      floor.
//
//   2. Where the product does not do what the design promises, the page says what the product
//      does. The model card in particular reads worse than the design draws it, deliberately:
//      the design promises redaction that nothing implements, and a settings page that
//      reassures you about a control nobody wrote is worse than no page at all.
//
// What is persisted, and where:
//
//   - the GitHub credential: Secret `barn-settings` (extensions.ts owns it, write-only, never
//     read back into a page). A pod can read it, and `githubIdentity()` uses that to spend it
//     against GitHub and hand back the answer - the login, the scopes and the expiry - so this
//     page can state them without the token itself ever coming back into the browser.
//   - everything else this page can set: ConfigMap `barn-studio-settings` in namespace `barn`,
//     one JSON key, the same shape review.ts uses for its own record.
//
// Neither of those is read or written here. Both go through `studio-settings.ts`, which is the
// one code path for them, so the dialog that asks for a credential mid-flow and this page
// cannot end up writing the same objects two different ways.
import {
  SButton, SBanner, SCard, SChip, SIcon, SField
} from '../components/ui';
import { rancherFetch } from '../api';
import {
  EXT_NS, extensionObject, listExtensions, githubIdentity, SETTINGS_SECRET
} from '../extensions';
import {
  LEVELS, DEFAULT_POLICY, SETTINGS_OBJECT, STUDIO_NEEDS, TokenRejected, asSentence, githubErrorText,
  readStudioSettings, writeStudioSettings, connectGithub, disconnectGithub, githubConnected, detectPermission,
  connectionSummary, tokenRejected, readRole
} from '../studio-settings';
import { STUDIO_ROUTE } from '../editor-product';
import { toastError, toastSuccess } from '../toast';

// The same cluster every other object in this product lives in. Written out rather than
// imported because `extensions.ts` does not export it, and review.ts already does the same.
const EXT_BASE = '/k8s/clusters/local';

/**
 * The four destinations the design draws, mapped onto the ones this product actually has.
 *
 * Two of them are real: the pod's dev server, and the two things `PublishModal` offers. Two are
 * not, and are drawn with their controls dead and the reason stated - an OCI push and a catalog
 * listing are not things Studio can do, so a control that configured them would be configuring
 * nothing.
 *
 * Three shapes of cell, and which one a column gets is a statement about what happens rather
 * than a style:
 *
 *   `locked`  the whole row is a fixed reading, both columns (dev preview, catalog).
 *   `cells`   one column is fixed and the other is not. The repository row's code review is
 *             the only one: `distributionGate()` refuses the distribution until a code
 *             sign-off is on the packet whatever this page holds, so a weaker value there
 *             could only ever be recorded and ignored.
 *   neither   settable, written on the click.
 *
 * A row may also `omit` a level, which is narrower than locking a cell and is here for one
 * case: the developer load is ungated by design, so "Required" on that row is a value nothing
 * can obey. It used to be offered and admitted, in the publish dialog, that it was being
 * ignored - which is a control that lies with a footnote. The two levels left are both real:
 * "Off" shows nothing and "Notified" puts the sign-offs on the row in the publish dialog.
 */
const DESTINATIONS = [
  {
    id:     'dev-preview',
    label:  'Your dev preview',
    icon:   'monitor',
    tag:    'always',
    note:   'Hot reload while you work. Nobody else can load it.',
    tone:   'muted',
    locked: { code: 'off', outcome: 'off' },
    reason: 'The preview is the extension pod\'s own dev server: a save is on the page before anything could ask a question about it. There is nothing here to gate, so this is not a setting.',
  },
  {
    id:       'dev-load',
    label:    'Developer load into this Rancher',
    icon:     'server',
    note:     'Studio\'s "This Rancher" publish: it builds in the pod and points this Rancher at the result. Reversible with "Remove local install".',
    editable: true,
    omit:     ['required'],
    reason:   'Off and Notified, and no Required, because a developer load reaches only this Rancher and is ungated by design - it is the half of the flow the review system deliberately never interrupts, so nothing can be made to hold it up and a third segment here would be a setting with no effect. The two that are here do something: Notified puts the sign-offs and an advisory chip on this destination in the publish dialog, and Off leaves it bare.',
  },
  {
    id:    'repo',
    label: 'Push to a repository',
    icon:  'github',
    tag:   'The gate',
    note:  'The moment it becomes installable by anyone who adds the repository. Studio pushes to GitHub; it cannot push an OCI artifact, so the design\'s OCI row is this one.',
    gate:  true,
    // Code review is the one cell on this page fixed at Required because Required is what
    // happens, rather than because there is nothing behind it. It used to be settable, and
    // that was a control with no effect: "Off" went into the ConfigMap and
    // `distributionGate()` carried on demanding a code sign-off anyway.
    cells: {
      code: {
        value:  'required',
        reason: 'Code review is fixed at Required here, and it is the one thing on this page that is fixed because it is enforced: distributionGate() refuses the distribution until a code sign-off covering the current packet is on record, whatever this page says. Outcome sign-off is left settable the way the design draws it - the gate takes that one as required too, and the publish dialog names any stored value it is not obeying.',
      },
    },
    editable: true,
  },
  {
    id:     'catalog',
    label:  'List in the SUSE catalog',
    icon:   'lock',
    tag:    'Org policy',
    note:   'Anyone at any customer can find and install it.',
    tone:   'muted',
    locked: { code: 'required', outcome: 'required' },
    reason: 'Studio has no catalog destination, so there is nothing this Rancher could set. Left here because the design lists it and because its absence is worth seeing.',
  },
];

/**
 * The three permission levels, in the design's order.
 *
 * Which of them is true is not decided here: `detectPermission` reads the pod's own start-up
 * script and says which one that script produces. None of them can be chosen (see the card).
 */
const PERMISSION_LEVELS = [
  {
    id:    'ask-every-edit',
    label: 'Ask before every file edit',
    note:  'Slowest, safest. You approve each write. Best while you are learning what Studio does.',
  },
  {
    id:    'edit-freely',
    label: 'Edit files freely, ask before running commands',
    note:  'The assistant writes and rewrites extension files on its own, but stops before anything that touches the cluster.',
  },
  {
    id:    'never-ask',
    label: 'Do not ask at all',
    admin: true,
    note:  'The assistant edits files and runs build commands without stopping.',
  },
];

/** "4h 12m", from an ISO timestamp. Empty for anything that is not a time. */
function uptimeSince(iso) {
  const started = Date.parse(iso || '');

  if (!started) {
    return '';
  }

  const mins = Math.max(0, Math.floor((Date.now() - started) / 60000));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days) {
    return `${ days }d ${ hours % 24 }h`;
  }

  return hours ? `${ hours }h ${ mins % 60 }m` : `${ mins }m`;
}

export default {
  name: 'BarnSettings',

  components: {
    SButton, SBanner, SCard, SChip, SIcon, SField
  },

  data() {
    return {
      loading: true,
      error:   '',

      // What needs sign-off. Copied a level deep, so the first click before the read lands
      // cannot write through into the module's own default.
      policy:  { 'dev-load': { ...DEFAULT_POLICY['dev-load'] }, repo: { ...DEFAULT_POLICY.repo } },
      writing: '',

      // GitHub connection.
      hasToken:      false,
      connection:    null,
      // What GitHub says about the stored token right now, asked from a pod because a browser
      // is not allowed to read the header the expiry is in. Null until it answers; the error
      // is kept rather than swallowed, because "GitHub would not say" and "GitHub says this
      // token is no good" are different facts and the row has to be able to tell them apart.
      identity:        null,
      identityError:   '',
      identityLoading: false,
      token:         '',
      showToken:     false,
      storing:       false,
      tokenError:    '',
      disconnecting: false,

      // What the assistant may do without asking.
      permission: { level: '', detail: '' },

      // Where previews run.
      cluster:    { name: 'local', version: '' },
      devServers: [],
      restarting: '',

      // Who can use Studio. `templates` and `bindings` are the two lists every row is read
      // from, kept so the fourth row can answer about a role without fetching them again.
      access:        [],
      accessNote:    '',
      templates:     [],
      bindings:      null,
      roleChoices:   [],
      customRole:    '',
      customReading: null,
      customLoading: false,
    };
  },

  computed: {
    destinations() {
      return DESTINATIONS;
    },

    permissionLevels() {
      return PERMISSION_LEVELS;
    },

    /**
     * The three calls Studio is made of, said once.
     *
     * Read off `STUDIO_NEEDS` rather than typed out, so the sentence in the banner and the rule
     * the ticks are computed from cannot come apart. A role that could do two of these still
     * cannot use Studio, which is why the list is the sentence rather than a summary of it.
     */
    needsSentence() {
      const labels = STUDIO_NEEDS.map((need) => need.label);

      return `${ labels.slice(0, -1).join(', ') } and ${ labels[labels.length - 1] }`;
    },

    settingsSecret() {
      return SETTINGS_SECRET;
    },

    ns() {
      return EXT_NS;
    },

    settingsObject() {
      return SETTINGS_OBJECT;
    },

    /**
     * Who the stored token belongs to.
     *
     * What GitHub said a moment ago comes first, and what was recorded when the token was
     * pasted is the fallback: the recorded copy only exists for tokens that went in through
     * this page, and `githubIdentity` answers for any of them.
     */
    accountLogin() {
      return this.identity?.login || this.connection?.login || '';
    },

    /**
     * The line under "Connected", or '' when there is nothing to put there.
     *
     * `connectionSummary` rather than a local build of the same sentence, because the dialog in
     * `EditorSettingsModal` shows the same three facts about the same credential and the two
     * used to disagree about what could be known at all.
     */
    connectionDetail() {
      return this.hasToken ? connectionSummary(this.identity, this.connection) : '';
    },

    /** Whether GitHub answered about the token and the answer was no. */
    rejected() {
      return tokenRejected(this.identityError);
    },

    /**
     * The same refusal, as a sentence.
     *
     * What the pod throws is the status followed by GitHub's body, truncated at 200 characters
     * and flattened onto one line, and putting that in front of a reader is putting the API's
     * JSON in front of a reader. `githubErrorText` is shared with the import dialog so the two
     * surfaces word a rejected token the same way.
     *
     * The raw text is what stays in `identityError`, because `rejected` reads the status code
     * out of it and the chip's three states turn on that.
     */
    identitySaid() {
      return asSentence(githubErrorText(this.identityError));
    },

    /**
     * The chip beside the account.
     *
     * "Active" is a claim about the credential, so it is only made once GitHub has answered
     * for it. A token GitHub rejects, or one nothing could ask about, gets a chip that says
     * which of those happened rather than a green pill over a credential that does not work.
     */
    connectionChip() {
      if (!this.hasToken) {
        return null;
      }

      if (this.identityError) {
        return { tone: 'warning', label: this.rejected ? 'Rejected by GitHub' : 'Unverified' };
      }

      return { tone: 'success', label: 'Active' };
    },
  },

  async mounted() {
    await this.load();
  },

  methods: {
    async load() {
      this.loading = true;

      // Every read is independent and every one of them is allowed to fail on its own: a
      // Rancher that will not answer for its own role bindings must not take the GitHub card
      // down with it.
      const [stored, settings, permission, cluster] = await Promise.all([
        readStudioSettings().catch((e) => {
          this.error = e?.message || String(e);

          return null;
        }),
        githubConnected().catch(() => false),
        detectPermission(),
        this.readCluster(),
      ]);

      if (stored) {
        this.policy = stored.policy;
        this.connection = stored.github;
        this.customRole = stored.customRole;
      }

      this.hasToken = settings;
      this.permission = permission;
      this.cluster = cluster;
      this.loading = false;

      // The slower ones, after the page is on the screen. Each is a read of something outside
      // this browser - the pods, Rancher's role bindings, and GitHub by way of a pod - and none
      // of them is worth making the card wait.
      await Promise.all([this.readDevServers(), this.readAccess(), this.readIdentity(), this.reconcileFixedCells()]);
    },

    /**
     * Put the stored record back in step with what this page will now let anybody set.
     *
     * Two ways it can drift, and both are the same failure. The repository row's code review
     * used to be settable and is now fixed at Required, because Required is what
     * `distributionGate()` does. The developer load's two cells used to offer Required and now
     * do not, because nothing obeys it there. Either way a value stored while it was on offer
     * would sit in the ConfigMap disagreeing with what this page draws, and the publish dialog
     * reads the ConfigMap rather than the page - so the two surfaces would say different things
     * about the same cell, which is the exact failure the "one place" rule exists to stop.
     *
     * A dropped level falls back to the strongest one still offered, so "Required" becomes
     * "Notified" rather than "Off": what somebody meant by it was closer to being told than to
     * not caring. Writes only when they actually differ, and never for a row the policy does
     * not hold at all.
     */
    async reconcileFixedCells() {
      const wrong = [];

      DESTINATIONS.forEach((destination) => {
        if (destination.locked || !this.policy[destination.id]) {
          return;
        }

        Object.entries(destination.cells || {}).forEach(([column, cell]) => {
          if (this.policy[destination.id][column] !== cell.value) {
            wrong.push([destination.id, column, cell.value]);
          }
        });

        ['code', 'outcome'].forEach((column) => {
          if (destination.cells?.[column]) {
            return;
          }

          const offered = this.levelsFor(destination, column);

          if (!offered.some((level) => level.value === this.policy[destination.id][column])) {
            wrong.push([destination.id, column, offered[offered.length - 1].value]);
          }
        });
      });

      if (!wrong.length) {
        return;
      }

      wrong.forEach(([id, column, value]) => {
        this.policy[id][column] = value;
      });

      // Housekeeping rather than something the reader did, so a failure is not worth a growl:
      // the page still draws the fixed value, which is still what the gate enforces.
      await writeStudioSettings((current) => {
        const policy = { ...current.policy };

        wrong.forEach(([id, column, value]) => {
          policy[id] = { ...policy[id], [column]: value };
        });

        return { ...current, policy };
      }).catch(() => null);
    },

    /**
     * What GitHub says the stored token is, asked from a pod.
     *
     * The browser cannot ask this itself. GitHub's CORS policy does not expose the
     * `github-authentication-token-expiration` header to a page, and Studio never reads the
     * credential back into the browser anyway - so the question is put from a pod, which can
     * read the Secret, and only the answer comes back. That is also why this covers tokens
     * this page never saw: the recorded `connection` only exists for one pasted here.
     */
    async readIdentity() {
      this.identity = null;
      this.identityError = '';

      if (!this.hasToken) {
        return;
      }

      this.identityLoading = true;

      try {
        this.identity = await githubIdentity();
      } catch (e) {
        // Kept and shown. A token GitHub rejects and a pod that cannot reach GitHub both end
        // up here, and the row says which by repeating what came back. Flattened and capped:
        // GitHub's 401 body arrives as pretty-printed JSON and this is one line of a row.
        this.identityError = String(e?.message || e).replace(/\s+/g, ' ').trim().slice(0, 160);
      } finally {
        this.identityLoading = false;
      }
    },

    // ---------------------------------------------------------------- sign-off

    /**
     * The value a cell is fixed at, or `undefined` when it is the user's to set.
     *
     * Two ways a cell can be fixed and they mean the same thing to the control: the whole row
     * is a reading (`locked`), or this one column is (`cells`).
     */
    fixedAt(destination, column) {
      if (destination.locked) {
        return destination.locked[column];
      }

      return destination.cells?.[column]?.value;
    },

    valueFor(destination, column) {
      const fixed = this.fixedAt(destination, column);

      return fixed === undefined ? this.policy[destination.id]?.[column] : fixed;
    },

    /**
     * The segments one cell offers.
     *
     * All three for a cell that is a reading, because a reading has to be able to draw whatever
     * it is reading - the catalog row is fixed at Required and hiding Required would leave it
     * showing nothing. For a settable cell, only the levels the row can actually honour.
     */
    levelsFor(destination, column) {
      if (this.fixedAt(destination, column) !== undefined || !destination.omit) {
        return LEVELS;
      }

      return LEVELS.filter((level) => !destination.omit.includes(level.value));
    },

    /**
     * The small print under a row: why the row is a reading, plus why any one cell in it is.
     *
     * Joined rather than rendered per cell because the cells sit in the grid's two right-hand
     * columns, which are 220px of segmented control with nowhere to put a sentence.
     */
    rowReason(destination) {
      const cells = Object.values(destination.cells || {}).map((cell) => cell.reason);

      return [destination.reason, ...cells].filter(Boolean).join(' ');
    },

    /**
     * Write one cell, now.
     *
     * No Save button anywhere on this page means the click is the write, so a failure has to be
     * visible: the value goes back to what the cluster still holds and the growl says why.
     */
    async setLevel(destination, column, value) {
      if (this.fixedAt(destination, column) !== undefined || this.valueFor(destination, column) === value) {
        return;
      }

      const previous = this.policy[destination.id][column];

      this.policy[destination.id][column] = value;
      this.writing = `${ destination.id }.${ column }`;

      try {
        await writeStudioSettings((current) => ({
          ...current,
          policy: {
            ...current.policy,
            [destination.id]: { ...current.policy[destination.id], [column]: value },
          },
        }));
      } catch (e) {
        this.policy[destination.id][column] = previous;
        toastError(this.$store, `That setting was not written: ${ e?.message || e }`);
      } finally {
        this.writing = '';
      }
    },

    // ------------------------------------------------------------------ github

    /**
     * Store a pasted token.
     *
     * Everything about how that works - what is spent where, what is recorded, and what happens
     * when GitHub rejects it or cannot be reached - is `connectGithub`, so this and the dialog
     * that asks for one mid-flow behave the same way.
     */
    async storeToken() {
      const token = this.token.trim();

      if (!token || this.storing) {
        return;
      }

      this.storing = true;
      this.tokenError = '';

      try {
        const { connection, unchecked } = await connectGithub(token);

        this.hasToken = true;
        this.connection = connection;
        this.token = '';
        this.showToken = false;

        toastSuccess(this.$store, unchecked ?
          'Token stored. GitHub could not be reached to say whose it is, so nothing was recorded against it.' :
          `Token stored${ connection?.login ? ` for ${ connection.login }` : '' }.`);

        // The row states what GitHub says about the token that is stored now, not the one that
        // was stored a moment ago.
        await this.readIdentity();
      } catch (e) {
        this.tokenError = e instanceof TokenRejected ? e.message : (e?.message || String(e));
      } finally {
        this.storing = false;
      }
    },

    /** Remove the credential, now, on one click, with nothing to press afterwards. */
    async disconnect() {
      if (this.disconnecting || !this.hasToken) {
        return;
      }

      this.disconnecting = true;

      try {
        await disconnectGithub();

        this.hasToken = false;
        this.connection = null;
        this.identity = null;
        this.identityError = '';
        this.token = '';
        toastSuccess(this.$store, 'The stored GitHub token was removed.');
      } catch (e) {
        toastError(this.$store, e?.message || String(e));
      } finally {
        this.disconnecting = false;
      }
    },

    /**
     * Clicking away from a pasted token stores it too, because a page with no Save button that
     * quietly drops what you typed is the worst of both.
     *
     * Length-guarded, and only on blur: a half-typed token stored while GitHub happens to be
     * unreachable would be recorded as the credential with nothing to say it is wrong. Enter is
     * explicit and is not guarded.
     */
    storeOnBlur() {
      if (this.token.trim().length >= 20) {
        this.storeToken();
      }
    },

    reconnect() {
      this.showToken = true;
      this.tokenError = '';
      this.$nextTick(() => this.$refs.tokenField?.$el?.querySelector('input')?.focus());
    },

    // ----------------------------------------------------------------- preview

    async readCluster() {
      const cluster = await rancherFetch('/v3/clusters/local').catch(() => null);
      const git = cluster?.version?.gitVersion || '';
      const provider = cluster?.provider || '';
      const semver = git.split('+')[0];
      const flavour = provider === 'k3s' ? 'K3s' : (provider === 'rke2' ? 'RKE2' : 'Kubernetes');

      return { name: 'local', version: semver ? `${ flavour } ${ semver }` : '' };
    },

    /**
     * Every extension's dev server, from the pods rather than from a list this page keeps.
     *
     * One row each, because "the dev server" is one per extension in this product and a single
     * row would have to pick one and be wrong about the others.
     */
    async readDevServers() {
      const [extensions, pods] = await Promise.all([
        listExtensions().catch(() => []),
        rancherFetch(`${ EXT_BASE }/v1/pods/${ EXT_NS }`).catch(() => null),
      ]);

      const running = (pods?.data || []).filter((pod) => !pod.metadata?.deletionTimestamp);

      this.devServers = extensions.map((extension) => {
        const object = extensionObject(extension.name);
        const pod = running.find((p) => p.metadata?.labels?.app === object);
        const container = (pod?.status?.containerStatuses || [])[0];
        const startedAt = container?.state?.running?.startedAt || pod?.status?.startTime || '';

        return {
          name:   extension.name,
          pod:    pod?.metadata?.name || '',
          ready:  extension.ready,
          phase:  pod?.status?.phase || '',
          uptime: uptimeSince(startedAt),
        };
      });
    },

    /**
     * Bounce one dev server by deleting its pod, which is what a Deployment makes a restart.
     *
     * The tree and node_modules are on the node rather than in the pod (see hostCachePath), so
     * this costs the compile rather than the install.
     */
    async restartDevServer(server) {
      if (!server.pod || this.restarting) {
        return;
      }

      this.restarting = server.name;

      try {
        await rancherFetch(`${ EXT_BASE }/v1/pods/${ EXT_NS }/${ server.pod }`, { method: 'DELETE' });
        toastSuccess(this.$store, `Restarting the dev server for ${ server.name }. It takes a minute or two to serve again.`);

        // Long enough for the apiserver to have replaced the pod, so the row shows the new one
        // starting rather than the old one still up.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await this.readDevServers();
      } catch (e) {
        toastError(this.$store, `That dev server was not restarted: ${ e?.message || e }`);
      } finally {
        this.restarting = '';
      }
    },

    // ------------------------------------------------------------------ access

    /**
     * Who can actually use Studio, read from Rancher's own RBAC rather than asserted here.
     *
     * The card used to say that everyone who can open the dashboard can use Studio, and tick
     * every row to prove it. Half of that is true and the half that matters is not. Studio's
     * pages are registered with no permission gate, so anybody signed in can open them - but
     * every read and every write those pages make goes through Rancher's cluster proxy carrying
     * the session of whoever is looking, so Kubernetes RBAC on namespace `barn` decides what
     * happens next. On this Rancher a Cluster Member cannot exec into a pod, which means the
     * terminal, which means everything: they would get a Studio that renders and then 403s.
     *
     * So each row is now a reading of one role's own rules against `STUDIO_NEEDS`, and the tick
     * means "somebody holding this role can use Studio" rather than "the page is reachable".
     * That is also why Cluster Members comes out unticked, which is how the design draws it.
     *
     * The counts are unchanged and come from Steve rather than from `/v3`.
     * `/v3/clusterRoleTemplateBindings` answers this Rancher with `{"pagination":{"total":0}}`
     * even for an admin, so the rows would read a confident "0 users" over two real bindings -
     * and a wrong number is worse here than no number, because the whole point of the count is
     * the blast radius of the row. The Steve collection is the CRD itself, so the fields are the
     * Kubernetes ones (clusterName, roleTemplateName, userName) rather than the v3 ones; both
     * spellings are matched so this still counts correctly if the v3 shape ever comes back.
     *
     * A read that genuinely fails still says so: a count is null for a list that is not there
     * and prints as "Rancher would not say" rather than as a zero, and a role whose rules could
     * not be read is left unticked with the row saying that is what happened.
     */
    async readAccess() {
      const [globals, bindings, users, templates] = await Promise.all([
        rancherFetch('/v3/globalRoleBindings').catch(() => null),
        rancherFetch('/v1/management.cattle.io.clusterroletemplatebindings').catch(() => null),
        rancherFetch('/v3/users').catch(() => null),
        rancherFetch('/v3/roleTemplates?limit=-1').catch(() => null),
      ]);

      this.bindings = bindings;
      this.templates = templates?.data || [];

      // Cluster context only: a project role cannot carry a rule about namespace `barn` in the
      // way this question needs, and the hidden ones are the Kubernetes originals Rancher keeps
      // out of its own pickers.
      this.roleChoices = this.templates
        .filter((template) => template.context === 'cluster' && !template.hidden)
        .map((template) => ({ id: template.id, label: template.name || template.id }))
        .sort((a, b) => a.label.localeCompare(b.label));

      const everyone = users ? (users.data || []).length : null;
      const admins = this.countPeople(globals, (b) => ['admin', 'restricted-admin'].includes(b.globalRoleId));
      const [owners, members] = await Promise.all([
        this.readRoleTemplate('cluster-owner'),
        this.readRoleTemplate('cluster-member'),
      ]);

      this.access = [
        {
          id:      'admins',
          label:   'Administrators',
          count:   this.sayPeople(admins),
          allowed: true,
          detail:  'Global role admin, which is cluster-admin on every cluster this Rancher has. Ticked because Rancher already says so; nothing here granted it and nothing here can take it away.',
        },
        {
          id:      'cluster-owners',
          label:   'Cluster Owners',
          count:   this.sayPeople(owners.count),
          allowed: owners.reading ? owners.reading.capable : false,
          detail:  `On the local cluster. ${ this.roleSentence(owners.reading) }`,
        },
        {
          id:      'cluster-members',
          label:   'Cluster Members',
          count:   this.sayPeople(members.count),
          allowed: members.reading ? members.reading.capable : false,
          detail:  `On the local cluster. ${ this.roleSentence(members.reading) }`,
        },
      ];

      this.accessNote = everyone === null ?
        'Rancher would not tell this page how many people can sign in.' :
        `${ everyone } ${ everyone === 1 ? 'person' : 'people' } can sign in to this Rancher and open Studio's pages. What each of them can do once it is open is the rows below.`;

      await this.applyCustomRole();
    },

    /** Distinct people in a binding list, or null when the list could not be read. */
    countPeople(list, match) {
      if (!list) {
        return null;
      }

      const people = new Set();

      (list.data || []).filter(match).forEach((binding) => {
        people.add(binding.userName || binding.userId || binding.userPrincipalName ||
          binding.userPrincipalId || binding.groupPrincipalName || binding.groupPrincipalId || binding.id);
      });

      return people.size;
    },

    sayPeople(n) {
      return n === null ? 'Rancher would not say' : `${ n } ${ n === 1 ? 'user' : 'users' }`;
    },

    /** One role on the local cluster, in either the Steve spelling or the v3 one. */
    onLocalRole(role) {
      return (b) => (b.clusterName || b.clusterId) === 'local' &&
        (b.roleTemplateName || b.roleTemplateId) === role;
    },

    /**
     * One role: how many people hold it here, and what Studio would let them do.
     *
     * A RoleTemplate marked `external` carries no rules of its own and defers to the cluster's
     * ClusterRole of the same name, so those are fetched rather than read as an empty list -
     * otherwise `cluster-admin`, of all things, would come back as able to do nothing.
     */
    async readRoleTemplate(id) {
      const template = this.templates.find((each) => each.id === id) || null;
      let rules = Array.isArray(template?.rules) ? template.rules : null;

      if (template && rules === null) {
        const role = await rancherFetch(`${ EXT_BASE }/apis/rbac.authorization.k8s.io/v1/clusterroles/${ id }`).catch(() => null);

        rules = Array.isArray(role?.rules) ? role.rules : null;
      }

      return {
        id,
        label:   template?.name || id,
        count:   this.countPeople(this.bindings, this.onLocalRole(id)),
        reading: rules === null ? null : readRole(rules),
      };
    },

    /**
     * A reading, as the sentence under the row.
     *
     * Three outcomes and they are three different facts: the role can do all of it, the role is
     * missing some of it (and which), or nobody could read the role's rules. The third must not
     * be worded like the second - an unticked row over an unread role is not a statement that
     * the role is short of anything.
     */
    roleSentence(reading) {
      if (!reading) {
        return 'Rancher would not say what this role may do, so this cannot answer for it.';
      }

      if (reading.capable) {
        return `Rancher's RBAC lets this role ${ this.needsSentence }, so somebody holding it can use Studio. Ticked because that is already true, not because anything here granted it.`;
      }

      const missing = reading.missing.length > 1 ?
        `${ reading.missing.slice(0, -1).join(', ') } or ${ reading.missing[reading.missing.length - 1] }` :
        reading.missing[0];

      return `Rancher's RBAC does not let this role ${ missing }. Studio's pages still open for them, because nothing gates those, and then every read and write inside them is refused by the apiserver.`;
    },

    /**
     * The fourth row: any role on this Rancher, asked the same question.
     *
     * A query and not a grant, which is the whole of what this page can honestly offer here -
     * see the card's banner. The choice is kept in the same ConfigMap as everything else on
     * this page so the answer is still on the screen after a reload.
     */
    async chooseRole(id) {
      this.customRole = id;
      this.customReading = null;

      await this.applyCustomRole();
      await writeStudioSettings((current) => ({ ...current, customRole: id })).catch((e) => {
        toastError(this.$store, `That choice was not remembered: ${ e?.message || e }`);
      });
    },

    async applyCustomRole() {
      if (!this.customRole || !this.templates.length) {
        this.customReading = null;

        return;
      }

      this.customLoading = true;

      try {
        this.customReading = await this.readRoleTemplate(this.customRole);
      } finally {
        this.customLoading = false;
      }
    },

    // -------------------------------------------------------------- navigation

    openStudio() {
      this.$router.push({ name: STUDIO_ROUTE });
    },

    /** Rancher's own extensions page, resolved the way the side menu resolves it. */
    openRancherExtensions() {
      const cluster = this.$store.getters['clusterId'] || this.$store.getters['defaultClusterId'] || '_';

      this.$router.push({ name: 'c-cluster-uiplugins', params: { cluster } });
    },
  },
};
</script>

<template>
  <div class="settings" data-testid="barn-settings">
    <!-- masthead (21:814 - 21:822) -->
    <div class="settings__masthead">
      <div class="settings__breadcrumb">
        <a
          class="settings__crumb"
          data-testid="settings-crumb-extensions"
          @click="openRancherExtensions"
        >Extensions</a>
        <SIcon name="chevronRight" :size="12" />
        <a
          class="settings__crumb"
          data-testid="settings-crumb-studio"
          @click="openStudio"
        >Studio</a>
        <SIcon name="chevronRight" :size="12" />
        <span class="settings__crumb-current" data-testid="settings-crumb-current">Settings</span>
      </div>

      <h1 class="settings__title">
        Studio settings
      </h1>
      <p class="settings__lede">
        Applies to everyone who uses Studio on this Rancher.
      </p>
      <p class="settings__no-save" data-testid="settings-no-save">
        There is no Save button on this page. Everything that can be changed is written to the
        cluster the moment you change it, and anything drawn dimmed is not settable yet - the
        reason is next to it.
      </p>
    </div>

    <div class="settings__body">
      <SBanner v-if="error" type="error" :message="error" />

      <!-- What needs sign-off (58:1056) -->
      <SCard title="What needs sign-off" data-testid="settings-signoff">
        <div class="settings__section">
          <p class="settings__note">
            Everything before the push to a repository is iteration, and Studio never interrupts
            it. The gate is the moment the extension becomes installable by somebody else.
          </p>

          <SBanner type="warning" data-testid="settings-signoff-enforcement">
            The publish dialog reads these values and shows each destination what it is being
            held to, but no value here decides whether a publish happens. Both boundaries are
            fixed in code: a developer load reaches only this Rancher and is ungated, and the
            push to a repository is refused until two different people have signed both
            questions against the change being pushed. So this matrix records what you mean by
            it, the two rows below say where that is all it does, and the publish dialog names
            any stored value it is not obeying. Written to ConfigMap
            <code>{{ settingsObject }}</code> in namespace <code>{{ ns }}</code>.
          </SBanner>

          <div class="settings__matrix">
            <div class="settings__matrix-head">
              <span class="settings__matrix-dest" />
              <span class="settings__matrix-col">
                <SIcon name="code" :size="12" />Code review
              </span>
              <span class="settings__matrix-col">
                <SIcon name="eye" :size="12" />Outcome sign-off
              </span>
            </div>

            <div
              v-for="destination in destinations"
              :key="destination.id"
              class="settings__dest"
              :class="[
                `settings__dest--${ destination.tone || 'plain' }`,
                { 'settings__dest--gate': destination.gate },
              ]"
              :data-testid="`settings-dest-${ destination.id }`"
            >
              <div class="settings__dest-text">
                <div class="settings__dest-title">
                  <SIcon :name="destination.locked ? 'lock' : destination.icon" :size="13" />
                  <span class="settings__dest-label">{{ destination.label }}</span>
                  <SChip
                    v-if="destination.tag"
                    :tone="destination.gate ? 'success' : 'default'"
                    :label="destination.tag"
                  />
                </div>
                <p class="settings__dest-note">
                  {{ destination.note }}
                </p>
                <p
                  v-if="rowReason(destination)"
                  class="settings__dest-reason"
                  :data-testid="`settings-dest-${ destination.id }-reason`"
                >
                  {{ rowReason(destination) }}
                </p>
              </div>

              <div
                v-for="column in ['code', 'outcome']"
                :key="column"
                class="settings__seg"
                role="radiogroup"
                :aria-label="`${ destination.label }: ${ column === 'code' ? 'code review' : 'outcome sign-off' }`"
              >
                <button
                  v-for="level in levelsFor(destination, column)"
                  :key="level.value"
                  type="button"
                  role="radio"
                  class="settings__seg-btn"
                  :class="{
                    'settings__seg-btn--on': valueFor(destination, column) === level.value,
                    'settings__seg-btn--locked': fixedAt(destination, column) !== undefined,
                  }"
                  :aria-checked="valueFor(destination, column) === level.value"
                  :disabled="fixedAt(destination, column) !== undefined || writing === `${ destination.id }.${ column }`"
                  :data-testid="`settings-signoff-${ destination.id }-${ column }-${ level.value }`"
                  @click="setLevel(destination, column, level.value)"
                >{{ level.label }}</button>
              </div>
            </div>
          </div>

          <div class="settings__aside" data-testid="settings-iteration-note">
            <p class="settings__aside-title">
              Nobody reviews the same extension forty times
            </p>
            <p class="settings__aside-body">
              While you build, changes accumulate against the last published version. There is no
              per-change approval, no notification, and nothing to click. At the push, the whole
              run is collapsed into one diff against that version - forty prompts become the three
              files that actually differ. "Notified" means the person who asked gets the criteria
              checked against the build; it never blocks the push.
            </p>
          </div>
        </div>
      </SCard>

      <!-- GitHub connection (21:825) -->
      <SCard title="GitHub connection" icon="github" data-testid="settings-github">
        <div class="settings__section">
          <p class="settings__note">
            Used to import repositories, to push when you publish, and to open the pull request
            that records the hand-off. Generated extensions are never handed this credential, but
            the pod they run in can read the Secret it lives in
            (<code>{{ settingsSecret }}</code> in namespace <code>{{ ns }}</code>, and that pod is
            bound to cluster-admin), so treat it as a credential Studio shares with anything it
            runs and scope it to the repositories you want it to touch.
          </p>

          <div v-if="!loading" class="settings__row" data-testid="settings-github-account">
            <span class="settings__dot" :class="hasToken ? 'settings__dot--on' : 'settings__dot--off'" />

            <div class="settings__row-text">
              <p class="settings__row-head">
                <template v-if="hasToken && accountLogin">
                  Connected as {{ accountLogin }}
                </template>
                <template v-else-if="hasToken">
                  A token is stored
                </template>
                <template v-else>
                  Not connected
                </template>
              </p>
              <p class="settings__row-note" data-testid="settings-github-detail">
                <template v-if="!hasToken">
                  Importing a public repository still works. A private one, and publishing to
                  GitHub, do not.
                </template>
                <template v-else>
                  <template v-if="connectionDetail">{{ connectionDetail }}.</template>
                  <template v-if="identityLoading">
                    Asking GitHub what this token is, from a pod.
                  </template>
                  <template v-else-if="identityError && rejected">
                    {{ identitySaid }} Reconnect with a replacement; the one stored now will
                    fail the next import or push.
                  </template>
                  <template v-else-if="identityError">
                    {{ identitySaid }} So nothing above was read from GitHub just now; it is
                    what was recorded when the token was stored.
                  </template>
                  <template v-else-if="identity">
                    Read from GitHub a moment ago. The question is put from an extension pod,
                    which is what can read the Secret; the credential itself never comes back
                    into this page.
                  </template>
                  <template v-else>
                    Stored, and nothing has been asked about it.
                  </template>
                </template>
              </p>
            </div>

            <SChip
              v-if="connectionChip"
              :tone="connectionChip.tone"
              :label="connectionChip.label"
            />

            <SButton
              variant="neutral"
              icon="refresh"
              data-testid="settings-github-reconnect"
              @click="reconnect"
            >
              {{ hasToken ? 'Reconnect' : 'Connect' }}
            </SButton>

            <SButton
              v-if="hasToken"
              variant="ghost"
              data-testid="settings-github-disconnect"
              :loading="disconnecting"
              @click="disconnect"
            >
              Disconnect
            </SButton>
          </div>

          <template v-if="showToken">
            <SField
              ref="tokenField"
              v-model="token"
              class="settings__token"
              label="GitHub token"
              type="password"
              placeholder="ghp_..."
              input-testid="settings-github-token"
              :disabled="storing"
              :error="tokenError"
              hint="Press Enter to store it. It is written to the Secret and never shown again."
              @enter="storeToken"
              @blur="storeOnBlur"
            />

            <p class="settings__hint" data-testid="settings-github-pat">
              A personal access token with the <code>repo</code> scope is enough.
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&amp;description=Rancher%20Extension%20Studio"
                target="_blank"
                rel="noopener noreferrer"
              >Create one on GitHub with the scope pre-selected</a>. The design says a pasted token
              is stored against your user account only; in this build it is not - there is one
              Secret for this Rancher's Studio and everybody using it uses the same credential.
            </p>
          </template>
        </div>
      </SCard>

      <!-- What the assistant may do without asking (21:847) -->
      <SCard title="What the assistant may do without asking" icon="sparkle" data-testid="settings-permission">
        <div class="settings__section">
          <SBanner type="warning" data-testid="settings-permission-fixed">
            Not settable, and not per user. {{ permission.detail }} The flag is one line of
            <code>claude-session.sh</code> in the extension's seed ConfigMap, and Studio rewrites
            that ConfigMap from the copy compiled into this bundle every time a page loads it, so
            a level chosen here would be undone within seconds and the pod would carry on at the
            level the bundle ships. It is per pod rather than per user as well: everybody with a
            terminal in that pod is at the same level, and a change would reach them when their
            session next started rather than on their next message. So these three are drawn as
            what they are - a reading of the level in force, not a choice.
          </SBanner>

          <div
            v-for="level in permissionLevels"
            :key="level.id"
            class="settings__option"
            :class="{ 'settings__option--on': permission.level === level.id }"
            :data-testid="`settings-permission-${ level.id }`"
          >
            <input
              type="radio"
              class="settings__radio"
              name="barn-assistant-permission"
              disabled
              :checked="permission.level === level.id"
              :aria-label="level.label"
            >

            <div class="settings__option-text">
              <p class="settings__option-head">
                {{ level.label }}
                <SChip v-if="level.admin" tone="warning" label="Admins only, not enforced" />
                <SChip v-if="permission.level === level.id" tone="success" label="In force" />
              </p>
              <p class="settings__option-note">
                {{ level.note }}
                <template v-if="level.id === 'never-ask'">
                  The design marks this one admins only and adds "still cannot publish". Neither
                  holds here: nothing restricts who may open a terminal, and the pod's
                  ServiceAccount is bound to cluster-admin.
                </template>
              </p>
            </div>
          </div>
        </div>
      </SCard>

      <!-- Where previews run (21:877) -->
      <SCard title="Where previews run" icon="monitor" data-testid="settings-preview">
        <div class="settings__section">
          <p class="settings__note">
            Unpublished extensions only ever load on this cluster. A preview is served by the
            extension's own pod in namespace <code>{{ ns }}</code>, reached through this cluster's
            API proxy, so nothing outside this Rancher can load it.
          </p>

          <div class="settings__control" data-testid="settings-preview-cluster">
            <div class="settings__control-text">
              <span class="settings__control-label">Preview cluster</span>
              <span class="settings__control-value">
                {{ cluster.name }}<template v-if="cluster.version"> - {{ cluster.version }}</template>
              </span>
            </div>
            <SIcon name="lock" :size="13" />
          </div>
          <p class="settings__hint" data-testid="settings-preview-cluster-hint">
            Not a choice, which is why it is a lock rather than the design's chevron: Studio
            creates every pod in the <code>local</code> cluster, named once in
            <code>extensions.ts</code> rather than read from a setting, so a picker here would
            have nothing to write to and choosing a different cluster would not move a preview.
          </p>

          <div v-if="devServers.length" class="settings__servers">
            <div
              v-for="server in devServers"
              :key="server.name"
              class="settings__row"
              :data-testid="`settings-devserver-${ server.name }`"
            >
              <span
                class="settings__dot"
                :class="server.ready ? 'settings__dot--on' : (server.pod ? 'settings__dot--warn' : 'settings__dot--off')"
              />

              <div class="settings__row-text">
                <p class="settings__row-head">
                  {{ server.name }}
                </p>
                <p class="settings__row-note">
                  <template v-if="server.ready">
                    Dev server running
                  </template>
                  <template v-else-if="server.pod">
                    Pod {{ server.phase.toLowerCase() }}, not serving yet
                  </template>
                  <template v-else>
                    No pod
                  </template>
                  <template v-if="server.uptime">
                    &middot; uptime {{ server.uptime }}
                  </template>
                </p>
              </div>

              <SButton
                variant="ghost"
                icon="refresh"
                :disabled="!server.pod"
                :loading="restarting === server.name"
                :data-testid="`settings-devserver-${ server.name }-restart`"
                @click="restartDevServer(server)"
              >
                Restart
              </SButton>
            </div>
          </div>
          <p v-else-if="!loading" class="settings__hint">
            No extension pods in namespace <code>{{ ns }}</code>.
          </p>

          <p v-if="devServers.length" class="settings__hint">
            Restart deletes the pod and lets the Deployment make a new one. The tree and
            node_modules are on the node, so it costs the compile rather than the install - but
            it does end any terminal session running in that pod.
          </p>
        </div>
      </SCard>

      <!-- Who can use Studio (21:897) -->
      <SCard title="Who can use Studio" icon="user" data-testid="settings-access">
        <div class="settings__section">
          <p class="settings__note" data-testid="settings-access-intro">
            Studio can write to this Rancher, so treat access like cluster admin.
          </p>

          <SBanner type="warning" data-testid="settings-access-ungated">
            Studio has no allow-list, and these ticks are a reading of Rancher's rather than a
            grant of Studio's. Opening the pages is ungated - they are registered with no
            permission gate, so anybody signed in can reach them - and everything after that is
            Kubernetes RBAC, because every read and write goes through the cluster proxy carrying
            the session of whoever is looking. So each row asks that role's own rules whether
            somebody holding it could {{ needsSentence }} - the third of those being the terminal,
            which is how every file in an extension gets written. A role that cannot gets a
            Studio that renders and then 403s.
            <template v-if="accessNote"> {{ accessNote }}</template>
          </SBanner>

          <SBanner type="info" data-testid="settings-access-no-grant">
            There is no tickable version of this. A grant would have to write the role's rules,
            and the third of the three is exec into a pod bound to cluster-admin - so ticking
            "Cluster Members" would quietly make every cluster member an administrator of this
            cluster. That belongs in Rancher's own role editor, with Rancher's own warnings on
            it, and not behind a checkbox on a settings page.
          </SBanner>

          <div
            v-for="row in access"
            :key="row.id"
            class="settings__row settings__row--tight"
            :data-testid="`settings-access-${ row.id }`"
          >
            <!--
              Disabled on purpose, and the title says why on the control itself rather than only
              in the banner above it. The testid is on the input rather than on the row, because
              the reading is what somebody checking this has to be able to address.
            -->
            <input
              type="checkbox"
              class="settings__checkbox"
              disabled
              :checked="row.allowed"
              :aria-label="row.label"
              :data-testid="`settings-access-${ row.id }-check`"
              title="A reading of Rancher's own RBAC, not a setting. Granting it would mean editing the role itself, and one of the three is exec into a cluster-admin pod."
            >

            <div class="settings__row-text">
              <p class="settings__row-head">
                {{ row.label }}
              </p>
              <p v-if="row.detail" class="settings__row-note">
                {{ row.detail }}
              </p>
            </div>

            <span v-if="row.count" class="settings__count" :data-testid="`settings-access-${ row.id }-count`">
              {{ row.count }}
            </span>
          </div>

          <!--
            Custom role... (21:919). The design opens a role picker here and shows a count once
            something is chosen, and that half is exactly what this does. What it does not do is
            grant, for the reason in the banner - so the picker asks the question rather than
            answering it, which is the only honest thing left for it to be.
          -->
          <div class="settings__row settings__row--tight" data-testid="settings-access-custom-role">
            <input
              type="checkbox"
              class="settings__checkbox"
              disabled
              :checked="!!customReading && !!customReading.reading && customReading.reading.capable"
              aria-label="Custom role"
              data-testid="settings-access-custom-role-check"
              title="A reading of the chosen role's own RBAC, not a setting."
            >

            <div class="settings__row-text">
              <p class="settings__row-head">
                Custom role...
              </p>
              <p class="settings__row-note" data-testid="settings-access-custom-role-detail">
                <template v-if="customLoading">
                  Reading what that role may do.
                </template>
                <template v-else-if="customReading">
                  {{ customReading.label }} on the local cluster. {{ roleSentence(customReading.reading) }}
                </template>
                <template v-else>
                  Any cluster role on this Rancher, asked the same question as the rows above.
                  Choosing one changes nothing about who can get in; it says who already can.
                </template>
              </p>
            </div>

            <select
              class="settings__select"
              aria-label="Custom role"
              data-testid="settings-access-custom-role-select"
              :value="customRole"
              :disabled="!roleChoices.length"
              @change="chooseRole($event.target.value)"
            >
              <option value="">
                {{ roleChoices.length ? 'Choose a role...' : 'No roles read' }}
              </option>
              <option
                v-for="choice in roleChoices"
                :key="choice.id"
                :value="choice.id"
              >{{ choice.label }}</option>
            </select>

            <span
              v-if="customReading"
              class="settings__count"
              data-testid="settings-access-custom-role-count"
            >{{ sayPeople(customReading.count) }}</span>
          </div>
        </div>
      </SCard>

      <!-- What is sent to the model (21:925) -->
      <SCard title="What is sent to the model" icon="sparkle" data-testid="settings-model">
        <div class="settings__section">
          <p class="settings__note">
            Shown here so you can answer this question without asking the platform team. These
            rows are what this build does, which is not what the design promises: the design has
            two of them redacted and Studio redacts nothing.
          </p>

          <div class="settings__row settings__row--tight" data-testid="settings-model-source">
            <SIcon name="check" :size="14" class="settings__model-icon settings__model-icon--sent" />
            <div class="settings__row-text">
              <p class="settings__row-head">
                Your message and the extension source files
              </p>
              <p class="settings__row-note">
                Everything under the extension folder in the pod, plus whatever the assistant opens
                while it works. claude runs in the pod, so the conversation goes to Anthropic's API.
              </p>
            </div>
          </div>

          <div class="settings__row settings__row--tight" data-testid="settings-model-shapes">
            <SIcon name="warning" :size="14" class="settings__model-icon settings__model-icon--warn" />
            <div class="settings__row-text">
              <p class="settings__row-head">
                The names, shapes and values of cluster resources
              </p>
              <p class="settings__row-note">
                The design promises kinds, fields and counts with the values redacted. Studio does
                not redact: the pod's ServiceAccount is bound to cluster-admin, so anything the
                assistant reads from this cluster - values included - can end up in a request.
              </p>
            </div>
          </div>

          <div class="settings__row settings__row--tight" data-testid="settings-model-secrets">
            <SIcon name="warning" :size="14" class="settings__model-icon settings__model-icon--warn" />
            <div class="settings__row-text">
              <p class="settings__row-head">
                Secrets, kubeconfigs and credentials
              </p>
              <p class="settings__row-note">
                The design promises two things: redaction on the way out, and a scan again before
                publish. The scan is real, the redaction is not. Nothing redacts - the GitHub token
                above sits in a Secret the pod's ServiceAccount can read, so a credential the
                assistant opens goes to the model as it is written. The publish dialog does scan:
                before a publish it reads the added lines of the diff for tokens, keys and
                kubeconfig client credentials and names the file and line it found one on. That is
                a warning at the end and not a block, and it reads the diff rather than anything
                already sent.
              </p>
            </div>
          </div>
        </div>
      </SCard>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.settings {
  display:        flex;
  flex-direction: column;
  height:         100%;
  overflow-y:     auto;
  background:     var(--studio-surface);

  code {
    font:          var(--studio-mono-11);
    background:    var(--studio-surface-subtle);
    border-radius: var(--studio-radius-control);
    padding:       0 3px;
  }

  &__masthead {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    padding:        var(--studio-space-20) var(--studio-space-24) var(--studio-space-16);
  }

  &__breadcrumb {
    display:     flex;
    align-items: center;
    gap:         6px;
    color:       var(--studio-text-tertiary);
  }

  &__crumb {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-link);
    cursor: pointer;

    &:hover { text-decoration: underline; }
  }

  &__crumb-current {
    font:  var(--studio-caption-12);
    color: var(--studio-text-secondary);
  }

  &__title {
    font:           var(--studio-heading-24);
    letter-spacing: var(--studio-tracking-heading);
    color:          var(--studio-text);
    margin:         0;
  }

  &__lede {
    font:   var(--studio-body-13);
    color:  var(--studio-text-secondary);
    margin: 0;
  }

  &__no-save {
    font:      var(--studio-caption-12);
    color:     var(--studio-text-tertiary);
    margin:    0;
    max-width: 780px;
  }

  &__body {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-16);
    padding:        0 var(--studio-space-24) var(--studio-space-32);
    max-width:      980px;
  }

  &__section {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-12);
  }

  &__note {
    font:      var(--studio-body-13);
    color:     var(--studio-text-secondary);
    margin:    0;
    max-width: 780px;
  }

  &__hint {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: 0;

    a { color: var(--studio-text-link); }
  }

  // ----------------------------------------------------------------- matrix

  &__matrix {
    display:        flex;
    flex-direction: column;
    border:         1px solid var(--studio-border);
    border-radius:  var(--studio-radius);
    overflow:       hidden;
  }

  &__matrix-head {
    display:               grid;
    grid-template-columns: minmax(0, 1fr) 220px 220px;
    gap:                   var(--studio-space-12);
    align-items:           center;
    padding:               var(--studio-space-8) var(--studio-space-12);
    background:            var(--studio-surface-nav);
    border-bottom:         1px solid var(--studio-border);
  }

  &__matrix-col {
    display:        inline-flex;
    align-items:    center;
    gap:            var(--studio-space-4);
    font:           var(--studio-caption-11-caps);
    letter-spacing: var(--studio-tracking-caps);
    text-transform: uppercase;
    color:          var(--studio-text-secondary);
  }

  &__dest {
    display:               grid;
    grid-template-columns: minmax(0, 1fr) 220px 220px;
    gap:                   var(--studio-space-12);
    align-items:           start;
    padding:               var(--studio-space-12);
    border-bottom:         1px solid var(--studio-border-subtle);

    &:last-child { border-bottom: none; }

    &--muted { background: var(--studio-surface-subtle); }

    &--gate {
      background:   var(--studio-green-050);
      box-shadow:   inset 3px 0 0 var(--studio-green-500);
    }
  }

  &__dest-title {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    color:       var(--studio-text);
  }

  &__dest-label { font: var(--studio-body-13-semi); }

  &__dest-note {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: var(--studio-space-4) 0 0;
  }

  &__dest-reason {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-tertiary);
    margin: var(--studio-space-4) 0 0;
  }

  &__seg {
    display:       inline-flex;
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);
    overflow:      hidden;
    background:    var(--studio-surface);
    align-self:    start;
  }

  &__seg-btn {
    flex:        1 1 0;
    padding:     5px var(--studio-space-10);
    font:        var(--studio-caption-12);
    color:       var(--studio-text-secondary);
    background:  none;
    border:      none;
    border-right: 1px solid var(--studio-border);
    cursor:      pointer;
    white-space: nowrap;

    &:last-child { border-right: none; }

    &:hover:not(:disabled) { background: var(--studio-surface-subtle); }

    &--on {
      background: var(--studio-green-500);
      color:      var(--studio-text-inverse);
      font:       var(--studio-caption-12-semi);
    }

    &--locked {
      cursor: default;

      &.settings__seg-btn--on {
        background: var(--studio-neutral);
        color:      var(--studio-text-inverse);
      }
    }

    &:disabled:not(.settings__seg-btn--on) { color: var(--studio-text-tertiary); }
  }

  &__aside {
    padding:       var(--studio-space-12);
    background:    var(--studio-surface-subtle);
    border-left:   3px solid var(--studio-border-strong);
    border-radius: var(--studio-radius-control);
  }

  &__aside-title {
    font:   var(--studio-body-13-semi);
    color:  var(--studio-text);
    margin: 0;
  }

  &__aside-body {
    font:      var(--studio-caption-12);
    color:     var(--studio-text-secondary);
    margin:    var(--studio-space-4) 0 0;
    max-width: 780px;
  }

  // -------------------------------------------------------------- list rows

  &__row {
    display:       flex;
    align-items:   center;
    gap:           var(--studio-space-12);
    padding:       var(--studio-space-12);
    background:    var(--studio-surface-subtle);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);

    &--tight {
      align-items: flex-start;
      background:  none;
      border:      none;
      padding:     var(--studio-space-8) 0;
      border-bottom: 1px solid var(--studio-border-subtle);
    }
  }

  &__row-text {
    flex:      1 1 auto;
    min-width: 0;
  }

  &__row-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    font:        var(--studio-body-13-semi);
    color:       var(--studio-text);
    margin:      0;
  }

  &__row-note {
    font:   var(--studio-caption-12);
    color:  var(--studio-text-secondary);
    margin: var(--studio-space-2) 0 0;
  }

  &__dot {
    width:         8px;
    height:        8px;
    border-radius: 50%;
    flex:          0 0 auto;

    &--on   { background: var(--studio-success); }
    &--warn { background: var(--studio-warning); }
    &--off  { background: var(--studio-neutral); }
  }

  &__count {
    font:       var(--studio-caption-12);
    color:      var(--studio-text-secondary);
    flex:       0 0 auto;
    text-align: right;
    min-width:  56px;
  }

  // The one real picker on this page. A native select rather than SMenu, because the list is
  // every cluster role this Rancher has and a native one is keyboard-navigable, filterable by
  // typing, and addressable as itself rather than as a wrapper.
  &__select {
    flex:          0 0 auto;
    max-width:     220px;
    font:          var(--studio-body-13);
    color:         var(--studio-text);
    background:    var(--studio-surface);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);
    padding:       4px 6px;
    cursor:        pointer;

    &:disabled {
      color:  var(--studio-text-tertiary);
      cursor: default;
    }
  }

  &__servers {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-8);
  }

  &__token :deep(.s-field__input) { font: var(--studio-mono-12); }

  // ---------------------------------------------------------------- controls

  &__control {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    gap:             var(--studio-space-12);
    padding:         var(--studio-space-8) var(--studio-space-12);
    border:          1px solid var(--studio-border);
    border-radius:   var(--studio-radius-control);
    background:      var(--studio-surface-subtle);
    color:           var(--studio-text-tertiary);
    max-width:       420px;
  }

  &__control-text {
    display:        flex;
    flex-direction: column;
    gap:            var(--studio-space-2);
    min-width:      0;
  }

  &__control-label {
    font:  var(--studio-caption-12);
    color: var(--studio-text-tertiary);
  }

  &__control-value {
    font:  var(--studio-body-13);
    color: var(--studio-text-secondary);
  }

  &__option {
    display:       flex;
    align-items:   flex-start;
    gap:           var(--studio-space-12);
    padding:       var(--studio-space-12);
    border:        1px solid var(--studio-border);
    border-radius: var(--studio-radius-control);

    &--on {
      background:   var(--studio-green-050);
      border-color: var(--studio-green-500);
    }
  }

  &__radio,
  &__checkbox {
    margin: 2px 0 0;
    flex:   0 0 auto;
  }

  &__option-text {
    flex:      1 1 auto;
    min-width: 0;
  }

  &__option-head {
    display:     flex;
    align-items: center;
    gap:         var(--studio-space-8);
    font:        var(--studio-body-13-semi);
    color:       var(--studio-text);
    margin:      0;
  }

  &__option-note {
    font:      var(--studio-caption-12);
    color:     var(--studio-text-secondary);
    margin:    var(--studio-space-4) 0 0;
    max-width: 780px;
  }

  &__model-icon {
    margin: 2px 0 0;

    &--sent { color: var(--studio-success); }
    &--warn { color: var(--studio-warning); }
  }
}
</style>
