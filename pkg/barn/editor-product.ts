import { IPlugin } from '@shell/core/types';

// A product registered in the 'management' store with no category shows up as a
// button in the side menu's top (multi-cluster) group, alongside Cluster
// Management and Continuous Delivery. It owns no resources - `to` points
// straight at the editor page registered in index.ts.
export const EDITOR_PRODUCT = 'barn-editor';
export const EDITOR_ROUTE = 'barn-editor';

/**
 * The Studio's front door: the list of extensions this cluster has (Figma screen 01).
 *
 * This is what the side-menu button opens now, rather than the editor. The editor is a view of
 * one extension, and landing straight in it meant the default extension was the only one most
 * people ever saw - there was no page on which the others existed.
 */
export const STUDIO_ROUTE = 'barn-studio';

/** Where a new extension is described before it is made (Figma screen 02). */
export const NEW_EXTENSION_ROUTE = 'barn-new-extension';

/**
 * The rest of the Studio's screens, each its own route because each is a full frame in the
 * design rather than a panel of one.
 *
 * 04 is the gate in front of publishing, 05 is the file browser with history beside it, 10 is
 * the brief agreed before any code is written, and 11-13 are the review side: what is waiting,
 * one change in detail, and whether it does the job.
 */
export const REVIEW_ROUTE = 'barn-review';
export const FILES_ROUTE = 'barn-files';
export const BRIEF_ROUTE = 'barn-brief';
export const REVIEW_QUEUE_ROUTE = 'barn-review-queue';
export const REVIEW_CHANGE_ROUTE = 'barn-review-change';
export const VERIFICATION_ROUTE = 'barn-verification';

/** Where a failed publish lands, with its log and a way back (Figma screen 08). */
export const BUILD_FAILED_ROUTE = 'barn-build-failed';

/**
 * The one page settings are edited on (Figma screen 09).
 *
 * A route rather than the dialog it replaces, because the design's caption for this frame is
 * "connection, permissions, access and data in one place" - and "in one place" is only true if
 * there is a place. The gear that used to open the token modal opens a signpost to this page
 * now (components/EditorSettingsModal.vue), so nothing else edits the same settings.
 *
 * Not registered as a nav entry in the rail: every Studio route uses the `plain` layout, which
 * draws Rancher's header and no product side nav, so a virtualType here would show up nowhere.
 */
export const SETTINGS_ROUTE = 'barn-settings';

/**
 * Where a newly created extension is watched while it comes up.
 *
 * A separate route rather than a state of the editor page, because the editor
 * has a terminal in the pod on one side and the dev server on the other, and
 * neither of those exists yet for the ten minutes this covers.
 */
export const EXTENSION_STARTING_ROUTE = 'barn-extension-starting';

/** Every route this product owns lives under here. */
const STUDIO_PATH_PREFIX = '/barn';

/**
 * Tell Rancher that all of `/barn/*` is this product, not just the one route the rail links to.
 *
 * The rail marks the section you are in with `active-menu-link`, and TopLevelMenu sets that
 * when `getProductFromRoute($route)` equals the entry's product name. `getProductFromRoute`
 * reads `meta.product` off the matched route, and none of the Studio's routes carried one - so
 * the only highlight the Studio ever had was vue-router's own `router-link-exact-active` on
 * `/barn/extensions`. Every other Studio screen - the workspace, the brief, the files, the
 * review queue, a change, verification, a failed build - rendered with nothing in the rail
 * marked current, which was reported from five of them independently.
 *
 * Stamped from here rather than written into each `addRoute` call in index.ts so there is one
 * place that decides what belongs to this product, and a route added later is covered without
 * anybody remembering to.
 *
 * In place rather than by replacing `meta`. A product's `init` runs a microtask after the
 * plugin's routes have been handed to vue-router, which holds this same object by reference;
 * assigning a fresh `meta` would update the plugin's copy and nothing the router resolves.
 */
function markStudioRoutes($plugin: IPlugin): void {
  const registered: { route?: { path?: string; meta?: Record<string, unknown> } }[] = ($plugin as any).routes || [];

  registered.forEach(({ route }) => {
    if (!route?.path?.startsWith(STUDIO_PATH_PREFIX)) {
      return;
    }

    if (!route.meta) {
      route.meta = {};
    }

    route.meta.product = EDITOR_PRODUCT;
  });
}

export function init($plugin: IPlugin, store: any) {
  const { product } = $plugin.DSL(store, EDITOR_PRODUCT);

  // Widened because `removable` is honoured at runtime but missing from
  // TypeMapProduct. The dev build only warns about that; `yarn build-pkg`
  // type-checks and fails, which is the first thing that ever compiles this for
  // real.
  const options: Record<string, unknown> = {
    // The puzzle, which is what the design marks selected in the rail (53:1284) and what a
    // person looking for extensions looks for. Rancher's own Extensions page carries the same
    // icon one section further down; the labels tell them apart, and only one of them is ever
    // the highlighted one.
    icon:                'extension',
    inStore:             'management',
    // Nothing to switch between - the page is the whole product.
    showClusterSwitcher: false,
    removable:           false,
    // After Cluster Management (-1) and Continuous Delivery (1).
    weight:              2,
    to:                  { name: STUDIO_ROUTE },
  };

  product(options);

  // After the product is registered, never before: a route whose meta names a product Rancher
  // does not know about is a fail-whale ("product not found") rather than an unhighlighted
  // rail. Both calls are synchronous and in this order, so no navigation can land between them.
  markStudioRoutes($plugin);
}

/**
 * The Studio's global actions, and the header kebab they hang under.
 *
 * The design draws a kebab in the header on screens 01, 02 and 11 (nodes 53:1306, 53:1430,
 * 53:1926) and does not draw what is inside it. Verifiers looked for it on all three of those
 * screens over two waves and found nothing, because barn renders no header - but Rancher does render one, and it already has
 * this exact control: `HeaderPageActionMenu` (an `icon-actions` kebab, testid
 * `page-actions-menu-action-button`) sits beside the notification bell and the user menu, and
 * `Header.vue` shows it whenever whatever is currently mounted has committed a non-empty
 * `pageActions` into the root store. Two things in Rancher do: its home page, and its default
 * layout, which is why the kebab is there on a cluster explorer route and offers "Set as login
 * page". The Studio's screens use the `plain` layout, which commits nothing, so on every one
 * of them the kebab the design draws was missing because nothing had filled it in.
 *
 * `@shell/mixins/page-actions` is how a page fills it: it commits on `created` and clears on
 * `beforeUnmount`, so the menu belongs to the page rather than to every page in Rancher. That
 * is the distinction that made `NavHeaderRight` the wrong home for the old header controls
 * (see index.ts) and it is why this one is acceptable.
 *
 * What is in it is the part that had to be earned rather than drawn. Each entry is somewhere
 * Studio-wide that the screen you are standing on has no other way to reach:
 *
 *   - The review queue is the sharpest case. `/barn/review` is linked from screen 12 and
 *     screen 13 only, both of which are reached *through* it, and it has no rail entry - so
 *     from the Studio's own front door there was no way to it at all.
 *   - Settings is a route with no nav entry by design (see SETTINGS_ROUTE above); screen 01 has
 *     a button for it in its masthead and screen 02 has nothing.
 *   - Rancher's Extensions page is where a published extension actually ends up. Screen 01
 *     reaches it from its breadcrumb; screen 02 does not.
 *
 * Nothing that only makes sense on one screen is here, and nothing here is invented: all three
 * are pages this product already has.
 */
export const STUDIO_ACTION_QUEUE = 'barn-page-action-queue';
export const STUDIO_ACTION_SETTINGS = 'barn-page-action-settings';
export const STUDIO_ACTION_INSTALLED = 'barn-page-action-installed';

export const STUDIO_PAGE_ACTIONS = [
  { label: 'Review queue', action: STUDIO_ACTION_QUEUE },
  { label: 'Studio settings', action: STUDIO_ACTION_SETTINGS },
  { divider: true },
  { label: 'Installed extensions', action: STUDIO_ACTION_INSTALLED },
];

/**
 * Run one of them, from whichever page opened the menu.
 *
 * Takes the component rather than living on it so the two screens that offer the menu cannot
 * drift into offering the same labels with different destinations.
 *
 * The cluster for Rancher's Extensions page is resolved the way the side menu resolves it, so
 * this and screen 01's "Extensions" breadcrumb land on the same URL; `_` is Rancher's
 * cluster-less cluster id and is the fallback when nothing is loaded.
 */
export function handleStudioPageAction(vm: any, action: { action?: string }): void {
  switch (action?.action) {
  case STUDIO_ACTION_QUEUE:
    vm.$router.push({ name: REVIEW_QUEUE_ROUTE });
    break;

  case STUDIO_ACTION_SETTINGS:
    vm.$router.push({ name: SETTINGS_ROUTE });
    break;

  case STUDIO_ACTION_INSTALLED: {
    const cluster = vm.$store.getters['clusterId'] || vm.$store.getters['defaultClusterId'] || '_';

    vm.$router.push({ name: 'c-cluster-uiplugins', params: { cluster } });
    break;
  }

  // no default
  }
}
