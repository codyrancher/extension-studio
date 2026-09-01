// Every route this service has, in one table.
//
// One table rather than a switch and a hand-written document beside it, because the document
// is the part that rots: a route added to a switch is a route nobody outside can discover, and
// nothing about a stale OpenAPI file makes itself felt until somebody generates a client from
// it. Here the router matches out of this list and the document is rendered from it, so they
// cannot disagree, and scripts/check-service.mjs asserts the third thing that could still go
// wrong - a route with no handler, or a handler nothing routes to.
//
// `handler` is a name rather than a function so this file stays a description. handlers.mjs
// holds the functions and imports nothing from here, which is what keeps the cycle out.

/** A path parameter, spelled once for the matcher and for the document. */
const NAME_PARAM = {
  name:        'name',
  in:          'path',
  required:    true,
  description: 'The extension name, without the "-extension" suffix its objects carry.',
  schema:      { type: 'string' },
};


/** The pod parameter, for the one route that addresses a pod rather than an extension. */
const POD_PARAM = {
  name:        'pod',
  in:          'path',
  required:    true,
  description: 'A pod name in this namespace, as GET /v1/extensions/{name} reports it.',
  schema:      { type: 'string' },
};

// What both exec routes take, and then one field each that only one of them does.
//
// Split rather than shared, because the two routes do not accept the same body and a document
// that says they do is a document contradicting the code it is rendered from. It was shared, and
// each route then advertised the other's field: the by-pod route rejects `script` with a 400,
// and the by-name route accepts `container` and silently ignores it. Two shapes is the honest
// arrangement, and the descriptions no longer have to end with a sentence retracting themselves.
const COMMAND_FIELDS = {
  command: {
    type:        'array',
    description: 'argv, one element per argument. A joined string would be one argument containing spaces.',
  },
  timeoutMs: {
    type:        'integer',
    description: 'How long to wait before reporting the connection, rather than the command, as broken. Defaults to four minutes, which is what a package build in a pod legitimately takes.',
  },
};

const EXTENSION_COMMAND_BODY = {
  ...COMMAND_FIELDS,
  script: {
    type:        'string',
    description: 'Shell to run in the extension\'s package directory as the tree\'s owner, instead of "command". The service composes the privilege drop, the HOME and the directory lookup, which every caller used to compose for itself.',
  },
};

const POD_COMMAND_BODY = {
  ...COMMAND_FIELDS,
  container: {
    type:        'string',
    description: 'Which container in the pod to run it in. Defaults to an extension dev server\'s, which is the only container most pods here have.',
  },
};

const COMMAND_RESPONSES = {
  200: 'stdout, stderr, the exit code, and whether the failure was the command or the connection.',
  404: 'No running pod to run it in.',
};

export const ROUTES = [
  {
    method:      'GET',
    path:        '/healthz',
    handler:     'health',
    auth:        false,
    operationId: 'health',
    summary:     'Liveness.',
    description: 'Answers as long as the process is listening, with the fingerprint of the source this pod is running so a stale deployment can be spotted without reading its ConfigMap. No credential, because a probe has none and a liveness check that can fail on authorization restarts healthy pods.',
    responses:   { 200: 'The service is up, and which source it is.' },
  },
  {
    method:      'GET',
    path:        '/openapi.json',
    handler:     'openapiDocument',
    auth:        false,
    operationId: 'openapi',
    summary:     'This document.',
    description: 'Served by the service it describes, so what a caller reads is what is running rather than what was published.',
    responses:   { 200: 'The OpenAPI 3.1 document.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions',
    handler:     'listExtensions',
    auth:        true,
    operationId: 'listExtensions',
    summary:     'Every extension in the cluster, with its readiness.',
    description: 'Read from the Deployments rather than from a list this service keeps, because the cluster is the list: one made by hand, or from the dashboard, is one this should report.',
    responses:   { 200: 'The extensions this caller can see.' },
  },
  {
    method:      'POST',
    path:        '/v1/extensions',
    handler:     'createExtension',
    auth:        true,
    operationId: 'createExtension',
    summary:     'Create an extension, reporting every step.',
    description: 'Runs the install steps in order, each one reading the cluster before it writes, so a repeat converges instead of failing. The answer lists every step and what happened to it, including the ones that failed.',
    requestBody: {
      name: {
        type:        'string',
        description: 'What to call it. Normalized the way the dashboard normalizes it, so "My Thing" creates "my-thing".',
      },
      from: {
        type:        'string',
        description: 'An extension already in this cluster whose seed ConfigMap is copied. Defaults to "base".',
      },
      files: {
        type:        'object',
        description: 'A tree to seed from, as path to contents, used instead of "from". Paths are flattened into ConfigMap keys here.',
      },
    },
    responses: {
      200: 'The steps, each "created", "present" or "failed". A failed one carries the status Rancher refused it with.',
      400: 'The name was missing or normalized to nothing.',
      401: 'Every step was refused because nothing was asked on anybody\'s behalf, so nothing was attempted.',
      403: 'Every step was refused by your RBAC. A mixed answer is a 200 with the failures named in the list.',
      404: 'The extension named by "from" has no seed in this cluster.',
    },
  },
  {
    method:      'GET',
    path:        '/v1/apis',
    handler:     'listApis',
    auth:        true,
    operationId: 'listApis',
    summary:     'Which extensions in this cluster say they offer an API.',
    description: 'A convenience over the registry, which is a set of label-selected ConfigMaps that can be listed directly without this service being involved at all. What this adds is resolution: each entry\'s documentation URL is fetched as the caller, and an entry that does not answer comes back marked rather than dropped, because hiding a broken entry turns "this API is broken" into "this API does not exist". The registry vouches for nothing: anything that can write a ConfigMap in this namespace can add an entry.',
    responses:   { 200: 'Every entry, each with whether its documentation resolved and why not.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}',
    handler:     'getExtension',
    auth:        true,
    operationId: 'getExtension',
    parameters:  [NAME_PARAM],
    summary:     'One extension and its state.',
    description: 'Its readiness, the pod serving it, where to point a browser at it, what it was seeded from, and everything needed to open its source without probing for it: the container, the package directory inside the pod, what that package calls itself, and the path to the guide that pod carries. The last three routinely disagree with the extension\'s name - an extension created from another is a copy of that one\'s tree, so a new `apps-plus` is served out of `/app/pkg/base` by a package still called `base`, and if its tree has since been renamed it is `/app/pkg/apps-plus` again. The tree is read from the running pod so that a rename is reflected; it falls back to what the extension was seeded with when the pod is not up.',
    responses:   { 200: 'The extension.', 404: 'No Deployment by that name in this namespace.' },
  },
  {
    method:      'DELETE',
    path:        '/v1/extensions/{name}',
    handler:     'deleteExtension',
    auth:        true,
    operationId: 'deleteExtension',
    parameters:  [NAME_PARAM],
    summary:     'Remove an extension.',
    description: 'Its own Deployment, Service and seed only. The namespace, the ServiceAccount and the ClusterRoleBinding are shared with every other extension and are left standing.',
    responses:   {
      200: 'What was deleted and what was already gone.',
      401: 'Every delete was refused because nothing was asked on anybody\'s behalf, so nothing was attempted.',
      403: 'Every delete was refused by your RBAC. A mixed answer is a 200 with the failures named in the list.',
    },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/install',
    handler:     'extensionInstallState',
    auth:        true,
    operationId: 'extensionInstallState',
    parameters:  [NAME_PARAM],
    summary:     'What exists and what does not, without making anything.',
    description: 'The same step list a create runs, reported as "present", "missing" or "unknown", an unknown one carrying the status Rancher answered with. Nothing is created, so a step this caller may not read is "unknown" with the reason on it rather than "missing": Rancher answers a namespace you cannot see with 403, and reporting that as missing would invite a reinstall of something that is standing. Safe to poll, and the way to find out why an extension is half made.',
    responses:   { 200: 'Every step and whether its object is there, or why we could not find out.' },
  },
  {
    method:      'POST',
    path:        '/v1/extensions/{name}/exec',
    handler:     'runInExtension',
    auth:        true,
    operationId: 'runInExtension',
    parameters:  [NAME_PARAM],
    requestBody: EXTENSION_COMMAND_BODY,
    summary:     'Run one command in the extension\'s pod and report how it went.',
    description: 'The same stream as the WebSocket on this path, read to the end and answered as JSON. The service resolves the pod, demultiplexes the apiserver\'s channels, decodes them and reads the exit code out of the status frame, which is the work every browser tab used to do for itself.',
    responses:   COMMAND_RESPONSES,
  },
  {
    method:      'POST',
    path:        '/v1/pods/{pod}/exec',
    handler:     'runInNamedPod',
    auth:        true,
    operationId: 'runInPod',
    parameters:  [POD_PARAM],
    requestBody: POD_COMMAND_BODY,
    summary:     'The same, for a caller that already knows the pod.',
    description: 'Exists because that is the shape the browser has: a pod is resolved once and then several commands are run in it, and re-resolving it per command would be a round trip per read.',
    responses:   COMMAND_RESPONSES,
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/conversation',
    handler:     'extensionConversation',
    auth:        true,
    operationId: 'extensionConversation',
    parameters:  [
      NAME_PARAM,
      {
        name: 'since', in: 'query', required: false, description: 'Only messages after this ISO timestamp.', schema: { type: 'string' },
      },
      {
        name: 'limit', in: 'query', required: false, description: 'How many messages, 1 to 200. Defaults to 60.', schema: { type: 'integer' },
      },
    ],
    summary:     'The conversation, assembled in the pod and parsed here.',
    description: 'One of the reads several browser tabs each poll independently today, which is where a single owner pays for itself. The assembly is pod/conversation.mjs, which merges claude\'s transcripts with the provenance log; this runs it and returns the JSON rather than a shell transcript with a marker line in it.',
    responses:   { 200: 'The conversation, or an empty one when the pod has nothing to say yet.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/pane',
    handler:     'extensionPane',
    auth:        true,
    operationId: 'extensionPane',
    parameters:  [
      NAME_PARAM,
      {
        name: 'lines', in: 'query', required: false, description: 'How much of the foot of the pane, 4 to 60. Defaults to 20.', schema: { type: 'integer' },
      },
    ],
    summary:     'What the assistant is showing right now.',
    description: 'The visible pane rather than the scrollback, stripped to ASCII. Polled by every screen that shows what the assistant is doing, which is why it is a route rather than a shell command each of them composes.',
    responses:   { 200: 'The pane text, empty when there is no session yet.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/approval',
    handler:     'extensionApproval',
    auth:        true,
    operationId: 'extensionApproval',
    parameters:  [NAME_PARAM],
    summary:     'How far review has got, and what is waiting.',
    description: 'The commits the approval pointer has not reached. `read` is false when the pod could not be asked: "nothing is waiting" and "this could not find out" are different answers and only one of them may open the publish gate, so they are separate fields rather than one optimistic boolean.',
    responses:   { 200: 'The approved commit, the pending ones, and whether this was a reading at all.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/changes',
    handler:     'extensionChanges',
    auth:        true,
    operationId: 'extensionChanges',
    parameters:  [
      NAME_PARAM,
      {
        name:        'since',
        in:          'query',
        required:    false,
        description: 'Measure from this commit instead of from the baseline, for "what landed while I was away". Refused when it is no longer in the branch.',
        schema:      { type: 'string' },
      },
    ],
    summary:     'The change, file by file, with line counts.',
    description: 'Measured from the baseline: the last published version, failing that the last approved change set, failing that the tree the extension started as. Untracked files are included and reported as additions.',
    responses:   { 200: 'One row per file.', 400: 'The "since" value is not a commit.', 404: 'That commit is no longer in the branch.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/provenance',
    handler:     'extensionProvenance',
    auth:        true,
    operationId: 'extensionProvenance',
    parameters:  [NAME_PARAM],
    summary:     'Where the change under review came from.',
    description: 'The last commit, and when a file in the working tree was last written. Best-effort and empty on failure, because a masthead is not worth a broken page.',
    responses:   { 200: 'The commit, and the edit time.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/turns',
    handler:     'extensionTurns',
    auth:        true,
    operationId: 'extensionTurns',
    parameters:  [
      NAME_PARAM,
      {
        name: 'limit', in: 'query', required: false, description: 'How many turns, 1 to 200. Defaults to 25.', schema: { type: 'integer' },
      },
    ],
    summary:     'The turns the pod recorded, newest first.',
    description: 'What was asked, what it touched and what it committed, as pod/barn-provenance.mjs recorded it while it happened.',
    responses:   { 200: 'The turns.' },
  },
  {
    method:      'GET',
    path:        '/v1/extensions/{name}/exec',
    handler:     'execStream',
    auth:        true,
    upgrade:     true,
    operationId: 'execExtension',
    parameters:  [
      NAME_PARAM,
      {
        name:        'command',
        in:          'query',
        required:    true,
        description: 'Repeated once per argument, because it is argv. Joining them with commas produces one argument containing commas, which is a command nothing in the pod has.',
        schema:      { type: 'array', items: { type: 'string' } },
      },
      {
        name:        'tty',
        in:          'query',
        required:    false,
        description: '1 for an interactive shell, which also opens stdin. Anything else runs the command with neither.',
        schema:      { type: 'string' },
      },
    ],
    summary:     'A WebSocket onto the extension pod, addressed by extension name.',
    description: 'Resolves the running pod, opens the apiserver exec stream with the caller\'s credential and splices the two sockets. The base64.channel.k8s.io subprotocol is passed through untouched: this is a pipe, not a parser, and it does not decode a single frame.',
    responses:   { 101: 'The stream, on whichever subprotocol the apiserver agreed to.', 404: 'No running pod for that extension yet.' },
  },
];
