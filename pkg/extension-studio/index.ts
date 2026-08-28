import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import { ensureBrowser, ensureDefaultExtension } from './extensions';
import { ensureService } from './service';
import { ensureAgent } from './agent';
import { registerAgentOverlay } from './agent-overlay';
import { ensureApiRegistration, studioApiEntry } from './api-registry';
import {
  EDITOR_ROUTE, EXTENSION_STARTING_ROUTE, STUDIO_ROUTE, NEW_EXTENSION_ROUTE,
  REVIEW_ROUTE, FILES_ROUTE, REVIEW_QUEUE_ROUTE, REVIEW_CHANGE_ROUTE,
  VERIFICATION_ROUTE, BUILD_FAILED_ROUTE, SETTINGS_ROUTE, EDITOR_PRODUCT
} from './editor-product';

/**
 * Every Studio route says which product it belongs to, here, in its own definition.
 *
 * Rancher's top-level menu highlights an entry when `getProductFromRoute($route)` matches it,
 * and that reads `route.meta.product`. Without it the rail highlighted `/barn/extensions` and
 * nowhere else, because the only thing marking the entry was vue-router's own
 * `router-link-exact-active` on the one path the entry links to. Every other Studio screen
 * rendered with no section marked current, which four separate verifiers reported from four
 * different screens.
 *
 * The first attempt stamped this on afterwards, by walking `$plugin.routes` once the product was
 * registered. It did not work: driving the real thing showed the highlight still only on
 * `/barn/extensions`. Declaring it on the route is the version that survives, because the object
 * the router matches is the object that carries it, with nothing in between to copy it wrong.
 */
const STUDIO_META = { product: EDITOR_PRODUCT };

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit, list from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  // Side-menu button (flask icon) -> the chrome-less editor page below.
  plugin.addProduct(require('./editor-product'));

  // So is the default extension's dev server (see extensions.ts): the seed
  // ConfigMap, the pod and its Service, created here so there is somewhere to
  // edit from the moment this bundle loads rather than behind a toggle. First
  // boot installs and compiles for a couple of minutes; the pod is only ready
  // once it can serve. Any others are made from the header's box, on demand.
  //
  // The catch is not decoration. A plugin is initialised on every page load, including the
  // login page, where nobody is authenticated and every one of these calls comes back 401 -
  // and an un-caught rejection there is an unhandled rejection, which in a dev build raises
  // webpack's error overlay over the login form and makes the dashboard unusable. There is
  // nothing to report either way: if the objects cannot be made now, the editor's own install
  // checklist makes them when somebody opens it.
  // The service the rest of this bundle talks to, first: every screen's reads and writes go
  // through it now, so a cluster without it is a Studio that loads and can do nothing. Started
  // before the extension it will be asked about, and caught for the reason above - on the login
  // page this is a 401 like the others.
  ensureService().catch(() => {});

  // And say so in the registry, so another extension can find this API without being told about
  // it. The Studio registers itself through exactly the mechanism anything else would use; there
  // is no special case for it, which is the only way to know the mechanism works.
  ensureApiRegistration(studioApiEntry()).catch(() => {});

  ensureDefaultExtension().catch(() => {});

  // The one agent pod, made the same way and caught for the same reason. It is not per
  // extension: the extension pods have a claude each, pointed at one tree, and this is the one
  // that can see all of them at once. Started here so it is already installing tmux and claude
  // by the time somebody first presses the chord.
  ensureAgent().catch(() => {});

  // And the chord that opens a terminal into it, from any page in Rancher. This function runs on
  // every page load of the whole dashboard, which is exactly the hook a global key handler needs
  // and the reason there is no new mechanism here. Who it is offered to, and why that is not
  // everybody, is in agent-overlay.ts.
  registerAgentOverlay();

  // And the browser those extensions are looked at in (see ensureBrowser): one
  // Chromium for the namespace, with CDP open on its Service, so a claude in an
  // extension pod can open the page it just changed and see what it did rather
  // than describing what it should have done. Created the same way and for the
  // same reason as the pod above - here rather than behind a toggle, so it is
  // already warming up by the time anybody opens the editor. Caught for the reason above.
  ensureBrowser().catch(() => {});

  /**
   * Rancher's own Extensions page, replaced with the same page plus a way into the Studio.
   *
   * Registered under Rancher's route name, so this wins for every existing link to Extensions
   * without any of them knowing: the menu entry, a bookmark, the redirect after installing
   * something. The component renders `@shell`'s page rather than reimplementing it, so what is
   * below the banner is whatever that dashboard ships.
   *
   * This is the only way into the Studio now that its product is `public: false` and has no
   * entry in the top-level menu. If this route ever fails to take effect, the Studio is still
   * at /barn/extensions - it is unlisted, not unreachable.
   */
  plugin.addRoute({
    name:      'c-cluster-uiplugins',
    path:      '/c/:cluster/uiplugins',
    component: () => import('./pages/rancher-extensions.vue'),
  });

  // The Studio's front door: every extension this cluster has (Figma screen 01). The banner on
  // Rancher's Extensions page points here, and each row opens the editor below.
  plugin.addRoute('plain', {
    name:      STUDIO_ROUTE,
    path:      '/extension-studio/extensions',
    meta:      STUDIO_META,
    component: () => import('./pages/extensions.vue'),
  });

  // Describing a new one before it exists (Figma screen 02).
  plugin.addRoute('plain', {
    name:      NEW_EXTENSION_ROUTE,
    path:      '/extension-studio/extensions/new',
    meta:      STUDIO_META,
    component: () => import('./pages/new-extension.vue'),
  });

  // The rest of the Studio. Each is a full frame in the design, so each is a route: the brief
  // agreed before any code exists, the gate in front of publishing, the file browser, and the
  // three review screens - plus the one page every setting is edited on, which is a route for
  // the same reason: the design's screen 09 is a frame, and the modal it replaces was not a
  // place anybody could link to.
  //
  // Each import is written out rather than built from a template literal: webpack turns a
  // template-literal import into a context module over the whole pages directory, which pulls
  // every page into the graph whether or not a route reaches it.
  [
    { name: REVIEW_ROUTE, path: '/extension-studio/extensions/:extension/review', component: () => import('./pages/review.vue') },
    { name: FILES_ROUTE, path: '/extension-studio/extensions/:extension/files', component: () => import('./pages/files.vue') },
    { name: REVIEW_QUEUE_ROUTE, path: '/extension-studio/review', component: () => import('./pages/review-queue.vue') },
    { name: REVIEW_CHANGE_ROUTE, path: '/extension-studio/review/:extension/:change', component: () => import('./pages/review-change.vue') },
    { name: VERIFICATION_ROUTE, path: '/extension-studio/extensions/:extension/verification', component: () => import('./pages/verification.vue') },
    { name: BUILD_FAILED_ROUTE, path: '/extension-studio/extensions/:extension/build-failed', component: () => import('./pages/build-failed.vue') },
    { name: SETTINGS_ROUTE, path: '/extension-studio/settings', component: () => import('./pages/settings.vue') },
  ].forEach((route) => plugin.addRoute('plain', { ...route, meta: STUDIO_META }));

  // The editor itself: two panes under Rancher's own header.
  //
  // 'plain' rather than 'blank'. Blank renders the route and nothing else, which meant the
  // editor had to carry a Back button to be escapable at all, and a page whose only way out
  // is a button it drew itself is a dead end when that button is the thing you are editing.
  // Plain draws the header and the top-level menu, so leaving is the same click it is
  // everywhere else in Rancher.
  //
  // 'default' would have been the other candidate and is wrong: it renders nothing until
  // `clusterReady`, and this route has no cluster in it.
  //
  // The extension is a path segment rather than a query, and optional: `/barn/editor` is the
  // default one, which is what the side-menu button and every existing link point at.
  plugin.addRoute('plain', {
    name:      EDITOR_ROUTE,
    path:      '/extension-studio/editor/:extension?',
    meta:      STUDIO_META,
    component: () => import('./pages/editor.vue'),
  });

  // Where a newly created extension is watched while its pod pulls, installs and compiles.
  plugin.addRoute('plain', {
    name:      EXTENSION_STARTING_ROUTE,
    meta:      STUDIO_META,
    path:      '/extension-studio/extension/:extension/starting',
    component: () => import('./pages/extension-starting.vue'),
  });

  // Nothing is registered into Rancher's header from here. This used to claim NavHeaderRight
  // with an Editor button and the extension box, and that slot is a poor place for them: it is
  // a single global slot, so the last extension to claim it silently wins, and it is rendered
  // on every page in Rancher whether or not any of this is what you are doing.
  //
  // The flask in the side rail is the way in (see editor-product.ts), and the extension box
  // lives on the editor's own toolbar, where it is next to the thing it changes.
  //
  // The one thing the Studio does put in the header is the kebab the design draws on screens
  // 01, 02 and 11, and it is registered by the pages rather than here for exactly the reason
  // above: `@shell/mixins/page-actions` commits a menu when a page mounts and clears it when
  // that page leaves, so the menu belongs to the screen instead of to all of Rancher. See
  // STUDIO_PAGE_ACTIONS in editor-product.ts.
}
