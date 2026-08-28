// One WebSocket in front of every extension pod's exec stream.
//
// What a caller has to do today is three things in order: list the pods in the namespace, pick
// the running one whose `app` label matches, and assemble an apiserver subresource URL with the
// container name and five query parameters on it. That is knowledge about this namespace's
// layout, held by everyone who wants a shell, and it is wrong the moment a pod is replaced.
// Here it is one name.
//
// The splice below is raw sockets on both sides, and that is the design rather than an
// optimisation. Decoding the stream would mean this service knowing that channel 0 is stdin and
// that frames are base64, which is exactly the knowledge that makes a proxy version-locked to
// its protocol: `base64.channel.k8s.io` today, `v4.channel.k8s.io` when Rancher's proxy
// negotiates it, and a resize frame nobody here has to recognise. Bytes in, bytes out.
import tls from 'node:tls';
import net from 'node:net';
import { EXT_BASE, EXT_NS, EXT_CONTAINER } from './names.mjs';
import { RANCHER_URL } from './rancher.mjs';

/**
 * The exec subresource for one pod, path and query.
 *
 * The commands are repeated parameters, not a joined string. This is argv: `command=sh&
 * command=-c&command=ls` runs `sh -c ls`, and `command=sh,-c,ls` asks the kubelet to run a
 * single binary whose name contains two commas.
 */
export function execPath(pod, command, interactive) {
  const params = new URLSearchParams({
    container: EXT_CONTAINER,
    stdin:     interactive ? '1' : '0',
    stdout:    '1',
    stderr:    '1',
    tty:       interactive ? '1' : '0',
  });

  for (const arg of command) {
    params.append('command', arg);
  }

  return `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/pods/${ pod }/exec?${ params }`;
}

/** The argv a caller asked for, in the order they sent it. */
export function commandFrom(searchParams) {
  return searchParams.getAll('command');
}

/**
 * A refusal written straight onto the socket.
 *
 * The upgrade has already been accepted by node at this point, so there is no ServerResponse to
 * reach for. A WebSocket client sees this as a failed handshake, which is what it should see;
 * curl sees the sentence.
 */
export function refuse(socket, status, reason, message) {
  const body = JSON.stringify({ message });

  socket.end(
    `HTTP/1.1 ${ status } ${ reason }\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${ Buffer.byteLength(body) }\r\n` +
    'Connection: close\r\n\r\n' +
    body,
  );
}

/**
 * The upgrade request, spelled out rather than made with a WebSocket client.
 *
 * node has a WebSocket, and it cannot be given headers: the standard constructor takes a URL
 * and a subprotocol list and nothing else, and undici's header extension is not something to
 * bet a credential path on. Writing the request is nine lines and it is the only way to put the
 * caller's cookie on it.
 */
export function handshakeRequest(path, host, cred, { key, protocol }) {
  const lines = [
    `GET ${ path } HTTP/1.1`,
    `Host: ${ host }`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${ key }`,
  ];

  // Whatever was asked for, unchanged. Choosing a subprotocol here would make this a
  // participant in a negotiation it has no stake in.
  if (protocol) {
    lines.push(`Sec-WebSocket-Protocol: ${ protocol }`);
  }

  for (const [name, value] of Object.entries(cred)) {
    lines.push(`${ name }: ${ value }`);
  }

  // No Origin header. The caller's would name this service, which Rancher has never heard of,
  // and inventing one would be this service asserting something about where the request came
  // from. Rancher does not require it for a cookie-authenticated upgrade.
  return `${ lines.join('\r\n') }\r\n\r\n`;
}

/**
 * A socket to Rancher, TLS or not, with the one thing that has to be said about the certificate.
 */
export function connectUpstream() {
  const target = new URL(RANCHER_URL);
  const options = {
    host:               target.hostname,
    port:               Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    // Rancher serves a certificate for its own name and is reached here by the node's address,
    // so verification cannot succeed and there is nothing to verify it against. The same reason
    // the browser pod runs with --ignore-certificate-errors.
    rejectUnauthorized: false,
    servername:         target.hostname,
  };
  const secure = target.protocol === 'https:';

  return {
    socket: secure ? tls.connect(options) : net.connect(options),
    host:   target.host,
    ready:  secure ? 'secureConnect' : 'connect',
  };
}

/**
 * Open the stream upstream and join the two sockets together.
 *
 * The upstream response head is forwarded verbatim, including its status line, so a caller who
 * was refused sees the apiserver's refusal rather than ours. Once the head is through, neither
 * side is read again by this process; `pipe` hands the bytes across and either end closing
 * takes the other with it.
 */
export function proxyExec(req, socket, head, cred, path) {
  const { socket: upstream, host, ready } = connectUpstream();

  let handshake = Buffer.alloc(0);
  let spliced = false;

  const fail = (message) => {
    if (!spliced && !socket.destroyed) {
      refuse(socket, 502, 'Bad Gateway', message);
    }

    upstream.destroy();
  };

  upstream.on('error', (e) => fail(`the exec stream to Rancher failed: ${ e?.message || e }`));
  socket.on('error', () => upstream.destroy());

  upstream.on(ready, () => {
    upstream.write(handshakeRequest(path, host, cred, {
      key:      req.headers['sec-websocket-key'] || '',
      protocol: req.headers['sec-websocket-protocol'],
    }));

    // Anything the client already sent past its own headers. node read it for us and would
    // otherwise drop it, which for a client that opened talking is a lost first frame.
    if (head?.length) {
      upstream.write(head);
    }
  });

  upstream.on('data', (chunk) => {
    if (spliced) {
      return;
    }

    handshake = Buffer.concat([handshake, chunk]);

    const end = handshake.indexOf('\r\n\r\n');

    if (end === -1) {
      // A response head this long is not one: it is something that is not HTTP on the other
      // end, and buffering it forever is how a proxy leaks memory quietly.
      if (handshake.length > 65536) {
        fail('Rancher answered the exec upgrade with something that is not an HTTP response.');
      }

      return;
    }

    spliced = true;
    socket.write(handshake.subarray(0, end + 4));

    const rest = handshake.subarray(end + 4);

    if (rest.length) {
      socket.write(rest);
    }

    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}
