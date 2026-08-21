import { IPlugin } from '@shell/core/types';

// A product registered in the 'management' store with no category shows up as a
// button in the side menu's top (multi-cluster) group, alongside Cluster
// Management and Continuous Delivery. It owns no resources — `to` points
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

/**
 * Where a newly created extension is watched while it comes up.
 *
 * A separate route rather than a state of the editor page, because the editor
 * has a terminal in the pod on one side and the dev server on the other, and
 * neither of those exists yet for the ten minutes this covers.
 */
export const EXTENSION_STARTING_ROUTE = 'barn-extension-starting';

export function init($plugin: IPlugin, store: any) {
  const { product } = $plugin.DSL(store, EDITOR_PRODUCT);

  // Widened because `removable` is honoured at runtime but missing from
  // TypeMapProduct. The dev build only warns about that; `yarn build-pkg`
  // type-checks and fails, which is the first thing that ever compiles this for
  // real.
  const options: Record<string, unknown> = {
    icon:                'flask',
    inStore:             'management',
    // Nothing to switch between — the page is the whole product.
    showClusterSwitcher: false,
    removable:           false,
    // After Cluster Management (-1) and Continuous Delivery (1).
    weight:              2,
    to:                  { name: STUDIO_ROUTE },
  };

  product(options);
}
