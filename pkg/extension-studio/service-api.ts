// Calling the Extension Studio API from the browser.
//
// Where the service is, and how a page reaches it. Both answers are load-bearing enough to be
// the whole of this file, because getting either wrong is a service that works perfectly and
// cannot be used.
//
// The route in is the apiserver's service proxy, on Rancher's own origin, which is the same
// path an extension's dev server is served at. That is not a preference. It is the only route
// that carries the caller, and it was settled by experiment rather than by reading: a request
// through this proxy arrives at the service with its `Cookie` header intact - `R_SESS`, `CSRF`
// and all - and with its `Authorization` header gone, because Rancher consumes that one to
// authenticate the request and does not pass it on.
//
// So the browser needs no new credential and no new code to send one. It already has a session
// cookie for this origin, the origin is the same, and the cookie arrives. The service forwards
// it to Rancher and every read and write happens as whoever is looking at the page, which is
// exactly what happened when the page did the work itself.
//
// A consequence worth writing down: a caller from outside a browser has to use a token, and a
// token cannot arrive through this proxy. Those callers talk to the Service directly inside the
// cluster, or through `kubectl port-forward`. The service accepts both shapes; only this path
// is limited to the cookie.
import { rancherFetch } from './api';

/** One name for the ConfigMap, the Deployment and the Service. */
export const API_OBJECT = 'extension-studio-api';

/**
 * The port. Not 8005, which is every extension's dev server, so that a Service pointed at the
 * wrong selector fails to connect rather than answering with somebody else's dashboard.
 */
export const API_PORT = 8006;

export const API_PORTS = [{ name: 'http', port: API_PORT, targetPort: 'http' }];

const API_NS = 'extension-studio';
const API_CLUSTER = 'local';

/** Where the service answers, as seen from a page. */
export const API_BASE =
  `/k8s/clusters/${ API_CLUSTER }/api/v1/namespaces/${ API_NS }/services/http:${ API_OBJECT }:${ API_PORT }/proxy`;

/**
 * One call to the service, as JSON, that throws with the service's own sentence.
 *
 * Straight through `rancherFetch`, which already does the two things this needs: the CSRF
 * header on writes, which Rancher requires of a cookie-authenticated caller and which the
 * experiment above confirmed reaches the service, and an error carrying `message` rather than
 * an HTTP number. The service's errors are written to be shown, so passing them through is the
 * whole of the error handling.
 */
export function serviceFetch(path: string, init?: RequestInit): Promise<any> {
  return rancherFetch(`${ API_BASE }${ path }`, init);
}

/** A POST with a JSON body, which is most of what this service is asked for. */
export function servicePost(path: string, body: Record<string, unknown>): Promise<any> {
  return serviceFetch(path, { method: 'POST', body: JSON.stringify(body) });
}

/** Path-safe, for the one segment that is user input. */
export function apiName(name: string): string {
  return encodeURIComponent(name);
}
