// Where a new extension appears, turned into the code that puts it there.
//
// Screen 02 asks "Where should it appear?" and calls it "the single hardest thing to fix
// later". Until this file existed the answer was recorded and thrown away: every extension got
// the base seed's product.ts byte for byte, whichever card was chosen, and the only trace of
// the decision was one line in BRIEF.md.
//
// The fix has to happen at creation time, because that is the only moment the answer is known
// and the tree does not exist yet. There is no pod to write into for minutes after the button
// is pressed, and the seed ConfigMap is the one thing the pod reads on the way up - so the
// decision is baked into the seed rather than applied to a tree afterwards. `ensureExtension`
// takes these as `extras` and lays them over the seed it was going to use.
//
// Three of the four cards produce real, different registrations. The fourth ("Not sure yet")
// deliberately produces a marked placeholder plus a question in the brief, because the thing
// that card promises - the assistant picking and explaining - cannot happen before the
// assistant exists, and seeding a guess dressed up as its answer would be a lie.
import { SEEDS } from './extension-seed.generated';

export interface Placement {
  id:    string;
  label: string;
  note:  string;
  /** What the brief records as the parent route, and what the generated code implements. */
  route: string;
  /** True for the one card that asks a follow-up question. */
  asksResource?: boolean;
}

export const PLACEMENTS: Placement[] = [
  {
    id: 'cluster', label: 'Inside a cluster', note: 'Cluster nav, below Storage', route: 'c-cluster',
  },
  {
    id: 'global', label: 'Top-level nav', note: 'Its own entry in the global menu', route: 'root',
  },
  {
    id:    'resource',
    label: 'On a resource',
    note:  'A new tab on a resource detail page',
    route: 'resource-detail',
    asksResource: true,
  },
  {
    id: 'unsure', label: 'Not sure yet', note: 'Let the assistant pick and explain', route: 'undecided',
  },
];

export function placementById(id: string): Placement {
  return PLACEMENTS.find((p) => p.id === id) || PLACEMENTS[0];
}

/** `node-health-panel` -> `Node health panel`, for a nav label and an l10n string. */
export function titleFor(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/**
 * A resource type the tab can attach to.
 *
 * Kept to what a Kubernetes type id can be - lowercase, dots for the group, no spaces - so a
 * typo cannot become a syntax error in the file this writes.
 */
export function normalizeResource(input: string): string {
  return (input || '').trim().toLowerCase().replace(/[^a-z0-9./-]/g, '');
}

/**
 * Whoever is signed in at the moment the extension is created.
 *
 * `review.ts`'s `currentSigner` is what produces it, so the principal written into the brief is
 * the same string `signOutcome` later compares against. Deriving it a second way here would let
 * the two drift, and the gate would then refuse the person it was written for.
 */
export interface Requester {
  principal: string;
  name:      string;
  /** `YYYY-MM-DD`. Defaults to today, and is a parameter so this stays testable. */
  at?:       string;
}

export interface PlacementPlan {
  name:      string;
  placement: string;
  resource:  string;
  prompt:    string;
  outcome:   string;
  /** Absent when Rancher would not say who is signed in. See `whoAskedSection`. */
  asked?:    Requester | null;
}

const INSIDE_A_CLUSTER = `// Where it appears: inside a cluster, in the cluster explorer's own nav.
//
// Chosen on the New extension screen. \`inStore: 'cluster'\` is what does it: the shell reads
// that as "this product belongs to the explorer" (see rootProduct in shell/store/type-map.js)
// and files the entry under the cluster rather than in the global menu. The cluster switcher
// stays in the header because there is a cluster to switch.`;

const TOP_LEVEL = `// Where it appears: its own entry in the global menu.
//
// Chosen on the New extension screen. \`inStore: 'management'\` with the cluster switcher off
// is what makes a product top-level rather than something inside a cluster, and the route's
// \`cluster: '_'\` is the blank cluster a global page runs against.`;

const ON_A_RESOURCE = `// Where it appears: a new tab on a resource detail page.
//
// Chosen on the New extension screen, along with the resource. The registration that does it
// is \`plugin.addTab\` in index.ts; TAB_RESOURCE below is what it attaches to. The product and
// its page are kept as well, so the same component can be opened on its own while it is being
// written - the tab is where a user finds it, the page is where you work on it.`;

const UNDECIDED = `// Where it appears: NOT DECIDED YET.
//
// "Not sure yet" was chosen on the New extension screen, so this file is a placeholder rather
// than a decision: it registers a top-level entry so the extension runs, and nothing has
// weighed that against the alternatives. The brief's "Where it appears" section is a question
// waiting for an answer - pick one, change this file and routing/index.ts to match, and write
// the choice and the reason there.
//
//   inside a cluster   inStore: 'cluster', showClusterSwitcher: true, and drop cluster: '_'
//   top-level nav      inStore: 'management', showClusterSwitcher: false   (what this is)
//   a resource tab     plugin.addTab(TabLocation.RESOURCE_DETAIL, ...) in index.ts`;

function header(id: string): string {
  if (id === 'cluster') {
    return INSIDE_A_CLUSTER;
  }

  if (id === 'resource') {
    return ON_A_RESOURCE;
  }

  if (id === 'unsure') {
    return UNDECIDED;
  }

  return TOP_LEVEL;
}

function productTs(plan: PlacementPlan): string {
  const cluster = plan.placement === 'cluster';
  const label = titleFor(plan.name);
  const resourceConst = plan.placement === 'resource'
    ? `\n/** The resource whose detail page carries this extension's tab. See index.ts. */\nexport const TAB_RESOURCE = '${ plan.resource }';\nexport const TAB_LABEL = '${ label }';\n`
    : '';

  return `import { IPlugin } from '@shell/core/types';

${ header(plan.placement) }
export const PRODUCT_NAME = '${ plan.name }';
export const HOME_PAGE = 'home';
export const HOME_ROUTE = \`\${ PRODUCT_NAME }-c-cluster-\${ HOME_PAGE }\`;
${ resourceConst }
export function init($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, PRODUCT_NAME);

  product({
    icon:                'gear',
    inStore:             '${ cluster ? 'cluster' : 'management' }',
    showClusterSwitcher: ${ cluster ? 'true' : 'false' },
    removable:           false,
    weight:              100,
  });

  virtualType({
    label:      '${ label }',
    name:       HOME_PAGE,
    namespaced: false,
    weight:     100,
    route:      { name: HOME_ROUTE${ cluster ? '' : `, params: { cluster: '_' }` } },
  });

  basicType([HOME_PAGE]);
}
`;
}

function routingTs(plan: PlacementPlan): string {
  const cluster = plan.placement === 'cluster';
  const note = cluster
    ? `// A cluster-scoped page: \`meta.product\` names whose nav to show, and the cluster comes from
// the route rather than being pinned to the blank one - this page is about a real cluster.`
    : `// A top-level product's pages need the \`/{product}/c/:cluster/\` shape, and \`meta.product\` is
// what tells the shell whose nav to show. Without it the page renders with no side menu.`;

  return `import { RouteRecordRaw } from 'vue-router';
import { PRODUCT_NAME, HOME_PAGE, HOME_ROUTE } from '../product';
import Home from '../pages/Home.vue';

${ note }
const routes: RouteRecordRaw[] = [
  {
    name:      HOME_ROUTE,
    path:      \`/\${ PRODUCT_NAME }/c/:cluster/\${ HOME_PAGE }\`,
    component: Home,
    meta:      { product: PRODUCT_NAME${ cluster ? '' : `, cluster: '_'` } },
  },
];

export default routes;
`;
}

function indexTs(plan: PlacementPlan): string {
  if (plan.placement !== 'resource') {
    return '';
  }

  return `import { importTypes } from '@rancher/auto-import';
import { IPlugin, TabLocation } from '@shell/core/types';
import routes from './routing';
import { PRODUCT_NAME, TAB_RESOURCE, TAB_LABEL } from './product';

// The entry point. The dashboard calls this once, with a plugin object to register things on.
export default function(plugin: IPlugin): void {
  // Picks up models/, detail/, edit/ and list/ by filename, if you add any.
  importTypes(plugin);

  plugin.metadata = require('./package.json');

  plugin.addProduct(require('./product'));
  plugin.addRoutes(routes);

  // Where it appears. TabLocation.RESOURCE_DETAIL is the tab strip on a resource's detail
  // page, and \`when\` is what narrows it to one type - without it the tab would appear on
  // every resource in the product.
  plugin.addTab(
    TabLocation.RESOURCE_DETAIL,
    { resource: [TAB_RESOURCE] },
    {
      name:       \`\${ PRODUCT_NAME }-tab\`,
      label:      TAB_LABEL,
      weight:     -1,
      showHeader: true,
      component:  () => import('./pages/Home.vue'),
    }
  );
}
`;
}

function l10nYaml(plan: PlacementPlan): string {
  return `product:\n  ${ plan.name }: ${ titleFor(plan.name) }\n`;
}

/** The "Where it appears" section, in the shape brief.vue's own writer emits. */
export function placementSection(plan: PlacementPlan): string[] {
  const spec = placementById(plan.placement);

  if (plan.placement === 'unsure') {
    return [
      '',
      '## Where it appears',
      'Parent route: `undecided`',
      '',
      'Not decided. "Not sure yet" was chosen, so this is a question rather than an answer:',
      'pick one of `c-cluster` (inside a cluster), `root` (its own entry in the global menu) or',
      '`resource-detail` (a tab on a resource detail page), change `product.ts` and',
      '`routing/index.ts` to match, and replace this paragraph with the choice and why.',
      'Seeded as a top-level entry in the meantime so the extension runs.',
    ];
  }

  if (plan.placement === 'resource') {
    return [
      '',
      '## Where it appears',
      `Parent route: \`${ spec.route }\``,
      '',
      `A tab on the detail page of \`${ plan.resource }\`, registered with \`plugin.addTab\` in`,
      '`index.ts`.',
    ];
  }

  return [
    '',
    '## Where it appears',
    `Parent route: \`${ spec.route }\``,
    '',
    `${ spec.label } - ${ spec.note.toLowerCase() }. Registered in \`product.ts\`.`,
  ];
}

/**
 * `## Who asked`, written at creation because that is the only moment it is known.
 *
 * `review.ts` has always been able to read this section - `whoAsked` looks for a principal id
 * under it and `signOutcome` refuses an outcome sign-off from anybody else - but nothing in the
 * product wrote it, so the rule was inert. This is the write.
 *
 * Creation is the honest place for it. The person pressing "Draft the brief" is by construction
 * the person who wants the extension; the brief screen, by contrast, is a form anybody can open
 * later, so a requester recorded there would be whoever happened to have the page up, which is
 * exactly the "quietly satisfied by whoever is standing there" that `whoAsked` warns against.
 * Screen 10 also has "Skip the brief", and a section written only there is lost on that path.
 *
 * The principal is first on the line and followed by a space, because `whoAsked` takes the
 * first `scheme://...` run of non-space characters it finds - a trailing bracket or full stop
 * would be read as part of the id and would then never match the signer.
 *
 * No principal means no section. An empty `## Who asked` and a missing one both read back as
 * "never recorded", and the missing one does not claim to have tried.
 */
export function whoAskedSection(asked?: Requester | null): string[] {
  if (!asked?.principal) {
    return [];
  }

  const on = asked.at || new Date().toISOString().slice(0, 10);
  const name = asked.name?.trim();
  const who = name
    ? `${ asked.principal } - ${ name }, on ${ on }.`
    : `${ asked.principal } - on ${ on }.`;

  return [
    '',
    '## Who asked',
    who,
    '',
    'Recorded from whoever was signed in when this extension was created. The outcome sign-off',
    'is theirs to give: it asks whether the thing does the job that was asked for, and nobody',
    'else can answer that on their behalf.',
  ];
}

/**
 * The brief as it stands the moment the extension is created.
 *
 * Written now rather than left to screen 10, because screen 10 has a "Skip the brief" button
 * and everything typed on screen 02 went with it: the description and the problem statement
 * reached BRIEF.md only on the agree path, so skipping silently threw them away. Screen 10
 * reads BRIEF.md on mount and writes the same shape back, so a draft written here is the form
 * that screen opens on, and agreeing replaces it rather than colliding with it.
 *
 * The headings are exactly the ones brief.vue's `briefDocument` emits and its `parseBrief`
 * reads, in the same order, so the first save is a no-op rather than a reshuffle. Change one
 * without the other and the brief stops round-tripping.
 *
 * `## What you were handed` is the request as it was typed, and it is written here rather than
 * left for screen 10 for the same reason everything else is: screen 10's own card for it was
 * empty on arrival from the query alone, and a card that says "nothing was carried through"
 * about a request somebody typed one screen ago is the product losing their words.
 */
export function briefDraft(plan: PlacementPlan): string {
  const problem = plan.outcome.trim() || plan.prompt.trim();
  const changes = plan.prompt.trim();

  const lines = [
    `# ${ plan.name }`,
    '',
    '## What you were handed',
    plan.prompt.trim() || '_not stated_',
    ...whoAskedSection(plan.asked),
    '',
    '## The problem',
    problem || '_not stated_',
    '',
    '## Who has it',
    '_not stated_',
    '',
    '## Written for',
    '_not stated_',
    '',
    '## What changes for them',
    changes || '_not stated_',
    '',
    '## What we are deliberately not doing',
    '_not stated_',
    '',
    '## How we will know it worked',
    '_not stated_',
    '',
    '## Open questions',
    '_none open_',
    '',
    '## Prior art we are reusing',
    '_nothing chosen_',
    ...placementSection(plan),
    '',
    '---',
    '',
    'Written in the Extension Studio before any code existed.',
  ];

  return lines.join('\n');
}

/**
 * The note appended to the seed's CLAUDE.md so the brief is not a document nobody opens.
 *
 * claude reads CLAUDE.md at the start of every session in this tree, and until this was here
 * nothing pointed it at BRIEF.md - the brief was written into the package and then read only
 * by other screens of the Studio. The last paragraph is the one screen 02's own note promises:
 * the outcome field exists so a description that is really a solution can be challenged, and
 * this is where the challenging is asked for.
 */
const BRIEF_NOTE = `
## Read BRIEF.md first

\`BRIEF.md\`, beside this file, is what was agreed before any code existed: the problem, who has
it, what changes for them, what we are deliberately not doing, how we will know it worked, and
where the extension appears. It is the first thing to read in this tree and the thing to check
work against.

Two things it asks of you:

- **If "Where it appears" says \`undecided\`,** choose a placement before writing any UI, change
  \`product.ts\` and \`routing/index.ts\` to match, and write the choice and the reason into that
  section. It is a question left for you on purpose.
- **If "What changes for them" describes a solution rather than the problem in "The problem",**
  say so before building it. That is what the problem statement is there for, and it is where
  most of the rewrites come from.
`;

function claudeMd(plan: PlacementPlan, seed: string): string {
  const existing = SEEDS[seed]?.[`pkg/${ seed }/CLAUDE.md`] || '';

  if (!existing) {
    return '';
  }

  return `${ existing.replace(/\s+$/, '') }\n${ BRIEF_NOTE }`;
}

/**
 * Every file the answers on screen 02 decide, keyed by its path inside the package.
 *
 * Handed to `ensureExtension` as `extras`, which lays them over the seed on the way into the
 * ConfigMap. An empty string means "leave the seed's copy alone", which is how index.ts stays
 * the seed's for the three placements that do not add a tab.
 */
export function placementFiles(plan: PlacementPlan, seed: string): Record<string, string> {
  const out: Record<string, string> = {
    'product.ts':       productTs(plan),
    'routing/index.ts': routingTs(plan),
    'l10n/en-us.yaml':  l10nYaml(plan),
  };

  const index = indexTs(plan);

  if (index) {
    out['index.ts'] = index;
  }

  const claude = claudeMd(plan, seed);

  if (claude) {
    out['CLAUDE.md'] = claude;
  }

  return out;
}
