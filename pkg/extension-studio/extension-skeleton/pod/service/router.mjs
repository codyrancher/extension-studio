// Matching a request against the table in routes.mjs.
//
// Segment by segment rather than by regular expression. The one thing this has to get right is
// that `/v1/extensions/{name}` and `/v1/extensions/{name}/install` are different routes, and a
// pattern built by string substitution gets that wrong in the direction that is hard to see:
// `.+` swallows the slash, so an install request is answered by the route above it and the
// caller is told about an extension called "base/install".
import { ROUTES } from './routes.mjs';

const PARAM = /^\{(.+)\}$/;

function segments(path) {
  return path.split('/').filter(Boolean);
}

/**
 * The route a request is, and the path parameters it carried, or null.
 *
 * A path that matches on shape but not on method is reported separately, because 405 and 404
 * are different answers and a caller who POSTed to a GET route is helped by knowing which.
 */
export function match(method, pathname) {
  const parts = segments(pathname);
  let shape = null;

  for (const route of ROUTES) {
    const params = matchPath(route.path, parts);

    if (!params) {
      continue;
    }

    shape = route;

    if (route.method === method) {
      return { route, params };
    }
  }

  return shape ? { route: null, params: {}, allowed: allowedFor(shape.path) } : null;
}

function matchPath(pattern, parts) {
  const wanted = segments(pattern);

  if (wanted.length !== parts.length) {
    return null;
  }

  const params = {};

  for (let i = 0; i < wanted.length; i++) {
    const name = PARAM.exec(wanted[i]);

    if (name) {
      // An empty segment cannot be a parameter: `/v1/extensions//install` names nothing, and
      // letting it through creates a request for the extension called "".
      if (!parts[i]) {
        return null;
      }

      params[name[1]] = decodeURIComponent(parts[i]);
    } else if (wanted[i] !== parts[i]) {
      return null;
    }
  }

  return params;
}

function allowedFor(path) {
  return ROUTES.filter((route) => route.path === path).map((route) => route.method);
}
