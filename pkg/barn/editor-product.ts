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
