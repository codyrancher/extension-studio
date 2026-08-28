// The document, rendered from the routes rather than written beside them.
//
// Which means it cannot describe a route that does not exist, or miss one that does. What it
// still cannot do is describe the exec endpoint honestly: OpenAPI has no notion of a WebSocket,
// so that one appears as the GET it is on the wire, with a 101 in its responses and prose
// saying what happens next. The alternative was leaving the only streaming route out of the
// document entirely, which would be worse for the person reading it.
import { ROUTES } from './routes.mjs';

const SECURITY = [{ bearerAuth: [] }, { cookieAuth: [] }];

function operation(route) {
  const responses = {};

  for (const [status, description] of Object.entries(route.responses || {})) {
    responses[status] = { description };
  }

  return {
    operationId: route.operationId,
    summary:     route.summary,
    description: route.description,
    ...(route.parameters ? { parameters: route.parameters } : {}),
    ...(route.requestBody ? { requestBody: requestBody(route) } : {}),
    responses,
    // An empty array is not the same as leaving it out: it is how OpenAPI says "this one needs
    // nothing", which for /healthz is the fact worth publishing.
    security: route.auth ? SECURITY : [],
  };
}

function requestBody(route) {
  const properties = {};

  for (const [name, spec] of Object.entries(route.requestBody)) {
    properties[name] = { type: spec.type, description: spec.description };
  }

  return {
    required: true,
    content:  { 'application/json': { schema: { type: 'object', properties } } },
  };
}

/** The whole document, as a plain object ready for JSON.stringify. */
export function openapiDocument() {
  const paths = {};

  for (const route of ROUTES) {
    paths[route.path] = paths[route.path] || {};
    paths[route.path][route.method.toLowerCase()] = operation(route);
  }

  return {
    openapi: '3.1.0',
    info:    {
      title:       'Extension Studio API',
      version:     '1',
      description: [
        'Creating, listing, inspecting and deleting Rancher extensions that run as pods in this cluster,',
        'and one WebSocket that fronts every one of their exec streams.',
        '',
        'This service holds no credential. Every call is made to Rancher with the credential the caller sent,',
        'so what you may do here is exactly what your RBAC already allows and a request with no credential is',
        'refused with 401 before anything is read.',
      ].join('\n'),
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type:        'http',
          scheme:      'bearer',
          description: 'A Rancher API token, as "Bearer token-xxxxx:secret".',
        },
        cookieAuth: {
          type:        'apiKey',
          in:          'cookie',
          name:        'R_SESS',
          description: 'A signed-in dashboard session. Writes also need the X-Api-CSRF header Rancher requires of cookie-authenticated callers.',
        },
      },
    },
    security: SECURITY,
    paths,
  };
}
