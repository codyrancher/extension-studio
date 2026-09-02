<script>
// Studio settings: the GitHub connection, and who can use Studio.
//
// It used to carry four more cards - a sign-off matrix, the assistant's permission level, where
// previews run, and what is sent to the model. They are gone, and the reason is the same for
// all four: they described things this product does not decide. The matrix drew rows whose
// controls were fixed or dead, the permission level was reported rather than set, the preview
// runs where the pod is, and the model card documented a redaction nothing implements. A
// settings page that reassures you about a control nobody wrote is worse than no page at all,
// so what is left is the two that write something real.
//
// Two rules this page is written to, and both of them cost features:
//
//   1. There is no Save button anywhere. Everything that can be changed is written when it is
//      changed, which is only honest if the write is real - so a control that cannot be backed
//      is drawn disabled with the reason next to it rather than drawn live and dropped on the
//      floor.
//
//   2. Where the product does not do what the design promises, the page says what the product
//      does.
//
// What is persisted, and where:
//
//   - the GitHub credential: Secret `barn-settings` (extensions.ts owns it, write-only, never
//     read back into a page). A pod can read it, and `githubIdentity()` uses that to spend it
//     against GitHub and hand back the answer - the login, the scopes and the expiry - so this
//     page can state them without the token itself ever coming back into the browser.
//   - the custom role this page can grant: ConfigMap `barn-studio-settings` in namespace `barn`.
//
// The publish policy that used to be edited here still exists and still gates a push; it now
// runs on its defaults (`DEFAULT_POLICY`), which is what the matrix was fixed at anyway.
//
// Neither object is read or written here directly. Both go through `studio-settings.ts`, which
// is the one code path for them, so the dialog that asks for a credential mid-flow and this
// page cannot end up writing the same objects two different ways.
import {
  SButton, SBanner, SCard, SChip, SIcon, SField
} from '../components/ui';
import { rancherFetch } from '../api';
import {
  EXT_NS, extensionObject, listExtensions, githubIdentity, assistantLogin, SETTINGS_SECRET
} from '../extensions';
import {
  DEFAULT_POLICY, SETTINGS_OBJECT, STUDIO_NEEDS, TokenRejected, asSentence, githubErrorText,
  readStudioSettings, writeStudioSettings, connectGithub, disconnectGithub, githubConnected, detectPermission,
  connectionSummary, tokenRejected, readRole
} from '../studio-settings';
import {
  STUDIO_ROUTE, STUDIO_PAGE_ACTIONS, STUDIO_ACTION_SETTINGS, handleStudioPageAction
} from '../editor-product';
import pageActionsMixin from '@shell/mixins/page-actions';
import { toastError, toastSuccess } from '../toast';

// The same cluster every other object in this product lives in. Written out rather than
// imported because `extensions.ts` does not export it, and review.ts already does the same.
const EXT_BASE = '/k8s/clusters/local';

export default {
  name: 'BarnSettings',

  components: {
    SButton, SBanner, SCard, SChip, SIcon, SField
  },

  /**
   * Rancher's header kebab, which this screen drew nothing into (Figma 53:1740).
   *
   * Same reason as the other four Studio pages: `Header.vue` renders `HeaderPageActionMenu`
   * whenever the mounted page has committed a non-empty `pageActions`, and the `plain` layout
   * these routes use commits none - so on this route the kebab the design draws was missing
   * because nothing had filled it in. See editor-product.ts for what is in the menu and why.
   */
  mixins: [pageActionsMixin],

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

      // What the assistant may do without asking, and whether it can do anything at all.
      // `assistantsRead` is separate from an empty list because "no pod answered" and "there
      // are no pods" are different sentences.
      permission:    { level: '', detail: '' },
      assistants:    [],
      assistantsRead: false,

      // Where previews run.
      cluster:    { name: 'local', version: '' },
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
    /**
     * The custom row's answer, which has one state the fixed rows do not: nothing chosen yet.
     *
     * That is not "no", and it must not be drawn as one - the row is a question with no subject
     * until a role is picked.
     */
    customAnswer() {
      if (this.customLoading) {
        return {
          state: 'reading', tone: 'unknown', icon: 'info', label: 'Reading'
        };
      }

      if (!this.customReading) {
        return {
          state: 'unasked', tone: 'unknown', icon: 'info', label: 'Not asked'
        };
      }

      return this.answerFor(this.customReading.reading);
    },


    /**
     * Whether the assistant has a credential to work with, said the way the workspace says it.
     *
     * The same fact in two places used to be two different facts. The workspace's session strip
     * reports the claude in the extension's pod (`assistantLogin`), and this page reported only
     * the GitHub token - so a reader who came here to find out why nothing was answering their
     * prompts found a green "Connected" about a different credential entirely. Two surfaces
     * disagreeing about "the connection" is the failure the one-place rule exists to stop, and
     * the fix is for this page to state the assistant's connection rather than for the strip to
     * stop stating it: the strip is where somebody is when it matters.
     *
     * Read per pod and not once, because that is how the credential is held. The strip answers
     * for the extension you are looking at; this page has no extension, so it asks every pod and
     * only says one sentence when they agree. A mixed answer names the ones that are signed in
     * rather than rounding to either end of it.
     *
     * `tone`: on | warn | off, which are the three the row's dot already has.
     */
    assistantState() {
      if (!this.assistantsRead) {
        return {
          tone:   'off',
          label:  'Reading the assistant sessions',
          detail: 'Asking each extension pod whether its claude has a credential to work with.',
        };
      }

      if (!this.assistants.length) {
        return {
          tone:   'off',
          label:  'No extension to ask',
          detail: 'The assistant runs in an extension\'s pod, and this Rancher has no extension, so there is no session to report.',
        };
      }

      const read = this.assistants.filter((each) => each.login.read);
      const inCount = read.filter((each) => each.login.signedIn);

      if (!read.length) {
        return {
          tone:   'off',
          label:  'Cannot tell whether the assistant is signed in',
          detail: `No pod answered when asked about its claude credentials (${ this.assistants.map((each) => each.name).join(', ') }), so this says nothing rather than guessing.`,
        };
      }

      const unread = this.assistants.length - read.length;
      const aside = unread ? ` ${ unread } more pod${ unread === 1 ? '' : 's' } did not answer.` : '';

      if (!inCount.length) {
        return {
          tone:   'warn',
          label:  'The assistant is not signed in',
          detail: `No credential in any of these pods (${ read.map((each) => each.name).join(', ') }): no OAuth credentials file, no API key in the environment and no account in .claude.json. Every prompt sent from the workspace comes back "Not logged in", and the workspace's own session strip says the same. Run /login in the terminal there; this page cannot do it, because the credential lives in the pod.${ aside }`,
        };
      }

      const named = inCount.map((each) => each.login.account).filter(Boolean);
      const who = named.length ? ` as ${ [...new Set(named)].join(', ') }` : '';

      if (inCount.length === read.length) {
        return {
          tone:   'on',
          label:  `The assistant is signed in${ who }`,
          detail: `Read from the credential the claude in each pod is running with (${ read.map((each) => each.name).join(', ') }). An API key names nobody, so a signed-in pod with no address here is running on one.${ aside }`,
        };
      }

      const out = read.filter((each) => !each.login.signedIn).map((each) => each.name);

      return {
        tone:   'warn',
        label:  `Signed in${ who } in some pods, not all`,
        detail: `${ inCount.map((each) => each.name).join(', ') } ${ inCount.length === 1 ? 'has' : 'have' } a credential; ${ out.join(', ') } ${ out.length === 1 ? 'does' : 'do' } not, so prompts sent from ${ out.length === 1 ? 'that workspace' : 'those workspaces' } come back "Not logged in". The credential is per pod, so /login has to be run in each.${ aside }`,
      };
    },

    /**
     * What the header kebab offers here.
     *
     * Minus "Studio settings", because this is Studio settings. A menu item that navigates to
     * the page you are standing on is a control that does nothing, and the review queue filters
     * its own entry out for the same reason. Filtered from the shared list rather than declared
     * as a second one, so the labels and destinations cannot drift between screens.
     */
    pageActions() {
      return STUDIO_PAGE_ACTIONS.filter((each) => each.action !== STUDIO_ACTION_SETTINGS);
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
    /**
     * The same reading as a glyph and a word, for the left of the row.
     *
     * Three states, and the third is the one that has to stay separate: "nobody could read this
     * role's rules" is not "this role is short of something". It gets its own glyph and its own
     * word so an unread role cannot be misread as a refused one.
     */
    answerFor(reading) {
      if (!reading) {
        return {
          state: 'unread', tone: 'unknown', icon: 'info', label: 'Not read'
        };
      }

      return reading.capable ?
        {
          state: 'yes', tone: 'yes', icon: 'check', label: 'Can use Studio'
        } :
        {
          state: 'no', tone: 'no', icon: 'warning', label: 'Cannot use Studio'
        };
    },
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
      await Promise.all([
        this.readAccess(),
        this.readIdentity(),
      ]);
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
          // "always" is the word the design puts on this row (21:906), and it is the one row
          // where it is literally true: the global role is cluster-admin everywhere, so there
          // is no reading to do and nothing that could come back other than yes.
          answer:  {
            state: 'always', tone: 'yes', icon: 'check', label: 'Always'
          },
          role:   { resource: 'management.cattle.io.globalrole', id: 'admin' },
          detail: 'Global role admin, which is cluster-admin on every cluster this Rancher has. Shown as met because Rancher already says so; nothing here granted it and nothing here can take it away.',
        },
        {
          id:      'cluster-owners',
          label:   'Cluster Owners',
          count:   this.sayPeople(owners.count),
          allowed: owners.reading ? owners.reading.capable : false,
          answer:  this.answerFor(owners.reading),
          role:    { resource: 'management.cattle.io.roletemplate', id: 'cluster-owner' },
          detail:  `On the local cluster. ${ this.roleSentence(owners.reading) }`,
        },
        {
          id:      'cluster-members',
          label:   'Cluster Members',
          count:   this.sayPeople(members.count),
          allowed: members.reading ? members.reading.capable : false,
          answer:  this.answerFor(members.reading),
          role:    { resource: 'management.cattle.io.roletemplate', id: 'cluster-member' },
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
     * Rancher's own page for the role behind a row.
     *
     * The one real action this card has. Studio cannot grant or revoke - see the banner - but
     * the rules that decide the answer are editable in this Rancher, and sending somebody there
     * is honest in a way a dead checkbox is not: the page they land on is the page that would
     * change the answer, with Rancher's own warnings on it. `local` rather than a resolved
     * cluster id because Rancher's auth product is pinned to `local` (shell/config/product/auth)
     * and every other object in this product lives there too.
     */
    openRole(role) {
      this.$router.push({
        name:   'c-cluster-auth-roles-resource-id',
        params: { cluster: 'local', resource: role.resource, id: role.id },
      });
    },

    /**
     * A reading, as the sentence under the row.
     *
     * Three outcomes and they are three different facts: the role can do all of it, the role is
     * missing some of it (and which), or nobody could read the role's rules. The third must not
     * be worded like the second - "not read" over an unread role is not a statement that the
     * role is short of anything.
     */
    roleSentence(reading) {
      if (!reading) {
        return 'Rancher would not say what this role may do, so this cannot answer for it.';
      }

      if (reading.capable) {
        return `Rancher's RBAC lets this role ${ this.needsSentence }, so somebody holding it can use Studio. That is already true; nothing here granted it and nothing here can take it away.`;
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

    handlePageAction(action) {
      handleStudioPageAction(this, action);
    },

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

      <!-- Who can use Studio (21:897) -->
      <SCard title="Who can use Studio" icon="user" data-testid="settings-access">
        <div class="settings__section">
          <p class="settings__note" data-testid="settings-access-intro">
            Studio can write to this Rancher, so treat access like cluster admin.
          </p>

          <SBanner type="warning" data-testid="settings-access-ungated">
            Every row here is a question asked of Rancher, not a switch Studio owns. Opening the
            pages is ungated - they are registered with no permission gate, so anybody signed in
            can reach them - and everything after that is Kubernetes RBAC, because every read and
            write goes through the cluster proxy carrying the session of whoever is looking. So
            each row asks that role's own rules whether somebody holding it could
            {{ needsSentence }} - the third of those being the terminal, which is how every file
            in an extension gets written. A role that cannot gets a Studio that renders and then
            403s.
            <template v-if="accessNote"> {{ accessNote }}</template>
          </SBanner>

          <SBanner type="info" data-testid="settings-access-no-grant">
            The design draws these as checkboxes and there is nothing for a checkbox to write.
            Studio has no allow-list, so a grant would have to widen the role itself - and the
            third of the three needs is exec into a pod bound to cluster-admin, so granting
            "Cluster Members" would quietly make every cluster member an administrator of this
            cluster. That change belongs in Rancher's own role editor, with Rancher's own
            warnings on it, which is where "Rules" on each row goes. So these rows answer rather
            than offer: a control that cannot act is worse here than a reading that is plainly a
            reading.
          </SBanner>

          <div
            v-for="row in access"
            :key="row.id"
            class="settings__row settings__row--tight"
            :data-testid="`settings-access-${ row.id }`"
          >
            <!--
              An answer, not a control. This used to be a disabled checkbox and that was the
              wrong shape twice over: a checkbox is a promise that ticking it does something,
              and greying it out says "not now" where the truth is "not ever, from here". The
              same glyph pair the model card uses says the same thing without offering
              anything. The testid stays on this element - it is the reading somebody checking
              the row has to be able to address - and `data-answer` carries the state a
              `checked` property used to.
            -->
            <span
              class="settings__answer"
              :class="`settings__answer--${ row.answer.tone }`"
              :data-testid="`settings-access-${ row.id }-check`"
              :data-answer="row.answer.state"
              :aria-label="`${ row.label }: ${ row.answer.label }`"
            >
              <SIcon :name="row.answer.icon" :size="14" />
              {{ row.answer.label }}
            </span>

            <div class="settings__row-text">
              <p class="settings__row-head">
                {{ row.label }}
              </p>
              <p v-if="row.detail" class="settings__row-note">
                {{ row.detail }}
              </p>
            </div>

            <!--
              The real action the row can offer. Studio cannot grant or revoke this, but the
              rules that decide it are a page in this Rancher, so the row points at it rather
              than at a control of its own. That is also where the warnings about widening a
              role live, which is the argument in the banner above made navigable.
            -->
            <SButton
              v-if="row.role"
              variant="ghost"
              size="sm"
              icon="external"
              :data-testid="`settings-access-${ row.id }-rules`"
              @click="openRole(row.role)"
            >
              Rules
            </SButton>

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
            <span
              class="settings__answer"
              :class="`settings__answer--${ customAnswer.tone }`"
              data-testid="settings-access-custom-role-check"
              :data-answer="customAnswer.state"
              :aria-label="`Custom role: ${ customAnswer.label }`"
            >
              <SIcon :name="customAnswer.icon" :size="14" />
              {{ customAnswer.label }}
            </span>

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

            <SButton
              v-if="customReading"
              variant="ghost"
              size="sm"
              icon="external"
              data-testid="settings-access-custom-role-rules"
              @click="openRole({ resource: 'management.cattle.io.roletemplate', id: customReading.id })"
            >
              Rules
            </SButton>

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

  &__radio {
    margin: 2px 0 0;
    flex:   0 0 auto;
  }

  // The access rows' answer. Reads as a state and not as a control: no box, no focus ring,
  // nothing to click. Same glyph pair as the model card below, so "met" and "not met" look the
  // same wherever this page states one.
  &__answer {
    display:     inline-flex;
    align-items: center;
    gap:         var(--studio-space-4);
    flex:        0 0 auto;
    min-width:   124px;
    margin:      2px 0 0;
    font:        var(--studio-caption-12);

    &--yes     { color: var(--studio-success); }
    &--no      { color: var(--studio-warning); }
    &--unknown { color: var(--studio-text-tertiary); }
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
