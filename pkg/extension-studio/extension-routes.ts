// Which route renders which file, read out of the extension's own routing table.
//
// It lived inside the Files screen, which was the only thing that needed it. Two screens need
// it now - Files, to say where a file surfaces, and Changes, to know which page a change set's
// picture should be a picture of - and a parser that two screens depend on is a module, not a
// private function in one of them.
/**
 * Which route renders which file, read out of the extension's own routing table.
 *
 * The designer calls this a required output of the screen ("where each file surfaces in the
 * UI"), and it is derived rather than declared: `routing/index.ts` imports a component and
 * names the path it is mounted at, so the mapping is already written down - in two files, in
 * template literals, which is the only reason it needs any code at all.
 *
 * Deliberately narrow. It resolves the constants those two files actually use (`PRODUCT_NAME`,
 * `HOME_PAGE`, and anything else declared as a string literal in product.ts) and gives up on
 * anything else, returning nothing rather than a path with `${ ... }` still in it. A wrong
 * route here would send somebody to a blank page and blame their file for it.
 */
export interface ExtensionRoute {
  /** The path the route is mounted at, with every constant it names resolved. */
  path:  string;
  /** The file the route renders, relative to the package root. */
  file:  string;
  /** The route's name, resolved when product.ts declares it as a constant. */
  route: string;
}

export function routesFromSource(routing: string, product: string): ExtensionRoute[] {
  // The string constants product.ts declares, resolved against each other so `HOME_ROUTE`,
  // which is written as a template of the two above it, comes out as a route name rather than
  // as its own source.
  const constants: Record<string, string> = {};
  const fill = (text: string): string => text.replace(/\$\{\s*(\w+)\s*\}/g, (whole, key) => constants[key] ?? whole);

  (product || '').split('\n').forEach((line: string) => {
    const m = /export\s+const\s+(\w+)\s*=\s*[`'"]([^`'"]*)[`'"]/.exec(line);

    if (m) {
      constants[m[1]] = fill(m[2]);
    }
  });

  // `import Home from '../pages/Home.vue'` - the local name, and the path it resolves to from
  // inside `routing/`, which is where this file sits.
  const components: Record<string, string> = {};

  (routing || '').split('\n').forEach((line: string) => {
    const m = /^\s*import\s+(\w+)\s+from\s+'(\.[^']+)'/.exec(line);

    if (m) {
      components[m[1]] = m[2].replace(/^\.\.\//, '').replace(/^\.\//, 'routing/');
    }
  });

  // Line by line rather than by matching the object, because both the things worth reading are
  // template literals: `${ PRODUCT_NAME }` puts braces inside the braces, and so does the
  // `meta: { ... }` on the line below, so an object matched by its brackets stops at the first
  // of them and finds nothing.
  const out: ExtensionRoute[] = [];
  let current: Record<string, string> | null = null;

  (routing || '').split('\n').forEach((line: string) => {
    if (/^\s*\{\s*$/.test(line)) {
      current = {};

      return;
    }

    if (!current) {
      return;
    }

    const path = /path:\s*[`'"]([^`'"]*)[`'"]/.exec(line);
    const component = /component:\s*(\w+)/.exec(line);
    const name = /name:\s*([\w]+)/.exec(line);

    if (path) {
      current!.path = path[1];
    }

    if (component) {
      current!.component = component[1];
    }

    if (name && current!.name === undefined) {
      current!.name = name[1];
    }

    if (/^\s*\},?\s*$/.test(line)) {
      const resolved = fill(current!.path || '');

      // A path this cannot finish resolving is dropped rather than shown with `${ ... }` still
      // in it. A wrong route sends somebody to a blank page and blames their file for it.
      if (resolved && !resolved.includes('${') && components[current!.component]) {
        out.push({
          path: resolved,
          file: components[current!.component],
          route: constants[current!.name] || current!.name || '',
        });
      }

      current = null;
    }
  });

  return out;
}
