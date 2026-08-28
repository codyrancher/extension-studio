// Running one command in a pod and reporting everything about how it went.
//
// This is the half of the exec surface that is not a pipe. The streaming route in exec.mjs
// forwards bytes and understands nothing; this one has to understand the frames, because its
// caller wants an answer rather than a socket: stdout, stderr, the exit code, and whether the
// command failed or the connection did.
//
// That work used to be in the browser, in `podExecResult`, and it is the reason this route
// exists. Every pod interaction this product has - reading a file, running git, asking the
// assistant, taking a screenshot - goes through that one function, and every one of them was
// a browser tab opening a WebSocket to the apiserver, demultiplexing base64 channels, feeding
// two streaming UTF-8 decoders and parsing the apiserver's English for an exit code. Several
// tabs did it at once, each with its own copy of the state. Now they ask for the answer.
//
// Two things this deliberately keeps from the browser version, because both were bugs that were
// fixed there and would come straight back if reimplemented casually: the decoders are
// streaming, since a multi-byte character can straddle two frames; and a socket that closes
// without a status frame and without code 1000 is a transport failure rather than exit 0.
import crypto from 'node:crypto';
import { execPath, connectUpstream, handshakeRequest } from './exec.mjs';

/**
 * How long a command may go without finishing before it is treated as broken.
 *
 * Generous, because the slowest thing anybody runs through here is a package build in the pod
 * and that legitimately takes minutes. It is not a performance budget: it is the difference
 * between a caller that fails and a caller that waits forever.
 */
export const EXEC_TIMEOUT_MS = 240000;

/** The apiserver's channels. 0 is stdin, which this never opens. */
const STDOUT = '1';
const STDERR = '2';
const STATUS = '3';

/**
 * What the apiserver said on channel 3, as an exit code.
 *
 * Two wire formats, and which one arrives depends on the subprotocol that was negotiated.
 * Rancher's proxy accepts `base64.channel.k8s.io` and refuses `base64.v4.channel.k8s.io`, so
 * what arrives today is v1's prose:
 *
 *   command terminated with non-zero exit code: error executing command [...], exit code 3
 *
 * The v4 form is a metav1.Status as JSON and is read too, so this keeps working if the proxy
 * ever negotiates it. Nothing at all on channel 3 means the command succeeded: v1 sends the
 * frame only when something went wrong.
 */
export function statusExitCode(status) {
  const text = (status || '').trim();

  if (!text) {
    return 0;
  }

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);

      if (parsed?.status === 'Success') {
        return 0;
      }

      const cause = (parsed?.details?.causes || []).find((c) => c?.reason === 'ExitCode');
      const code = parseInt(cause?.message, 10);

      return Number.isFinite(code) ? code : -1;
    } catch { /* not the JSON form after all, so read it as prose below */ }
  }

  const prose = /exit code (\d+)/.exec(text);

  return prose ? parseInt(prose[1], 10) : -1;
}

/**
 * Pull whole WebSocket frames off a buffer.
 *
 * Enough of RFC 6455 to read what the apiserver sends and no more: text and binary frames,
 * continuations, and close. There is no ping answered and no frame ever sent, because this
 * opens no stdin and the apiserver closes the socket itself when the command ends. A masked
 * frame is handled anyway, since a proxy is allowed to send one and a garbled payload would be
 * a very confusing way to find out.
 */
export function readFrames(buffer) {
  const frames = [];
  let at = 0;

  while (buffer.length - at >= 2) {
    const first = buffer[at];
    const masked = (buffer[at + 1] & 0x80) !== 0;
    let length = buffer[at + 1] & 0x7f;
    let header = at + 2;

    if (length === 126) {
      if (buffer.length < header + 2) {
        break;
      }

      length = buffer.readUInt16BE(header);
      header += 2;
    } else if (length === 127) {
      if (buffer.length < header + 8) {
        break;
      }

      length = Number(buffer.readBigUInt64BE(header));
      header += 8;
    }

    const mask = masked ? buffer.subarray(header, header + 4) : null;

    header += masked ? 4 : 0;

    if (buffer.length < header + length) {
      break;
    }

    const payload = Buffer.from(buffer.subarray(header, header + length));

    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    at = header + length;
  }

  return { frames, rest: buffer.subarray(at) };
}

/**
 * Collects the three channels out of a stream of frames.
 *
 * Separated from the socket so the decoding can be checked without one. It is where the two
 * bugs worth keeping fixed live, so it is the part worth being able to test.
 */
export function channelReader() {
  const out = new TextDecoder('utf-8');
  const err = new TextDecoder('utf-8');
  const state = { stdout: '', stderr: '', status: '' };

  return {
    /** One frame's payload, which is a channel digit followed by base64. */
    take(payload) {
      const text = payload.toString('latin1');

      if (!text.length) {
        return;
      }

      const channel = text[0];
      const bytes = Buffer.from(text.slice(1), 'base64');

      if (channel === STDOUT) {
        state.stdout += out.decode(bytes, { stream: true });
      } else if (channel === STDERR) {
        state.stderr += err.decode(bytes, { stream: true });
      } else if (channel === STATUS) {
        // Always ASCII, so it needs no streaming decoder, but it does need decoding from the
        // same bytes as the rest.
        state.status += new TextDecoder('utf-8').decode(bytes);
      }
    },
    /** Flush: a decoder holding a partial sequence emits it rather than losing it. */
    finish() {
      return {
        stdout: state.stdout + out.decode(),
        stderr: state.stderr + err.decode(),
        status: state.status,
      };
    },
  };
}

/** The status out of an HTTP status line, or 0 when there is not one to read. */
function statusLineCode(head) {
  const found = /^HTTP\/1\.1 (\d{3})/.exec(head || '');

  return found ? Number(found[1]) : 0;
}

/** Whatever the two ends produced, as the result a caller reads. */
function settlement(reader, closeCode, timedOutAfter) {
  const { stdout, stderr, status } = reader.finish();

  if (timedOutAfter) {
    return {
      stdout,
      stderr,
      status:     `the exec did not finish within ${ Math.round(timedOutAfter / 1000) }s`,
      code:       -1,
      transport:  true,
      httpStatus: 0,
    };
  }

  // A clean 1000 with no status frame is the only shape that means success. Anything else with
  // nothing on channel 3 is the connection failing rather than the command, which is a
  // different sentence for a screen to say and must not be reported as exit 0.
  const broke = !status && closeCode !== 1000;

  return {
    stdout,
    stderr,
    status:     status || (broke ? `the exec connection closed without running the command (${ closeCode })` : ''),
    code:       broke ? -1 : statusExitCode(status),
    transport:  broke,
    // Upgraded, so whatever went wrong afterwards was not the apiserver refusing the request.
    httpStatus: 0,
  };
}

/**
 * Run one command in one pod as the caller and resolve with how it went.
 *
 * Resolves rather than rejects for a non-zero exit, because a non-zero exit is a fact rather
 * than an error: plenty of callers run commands that are expected to fail (`git rev-parse
 * --verify -q` on a ref that does not exist, a grep that matches nothing). Whether the code
 * matters is the caller's decision.
 */
export function runInPod(cred, pod, command, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const { socket, host, ready } = connectUpstream();
    const reader = channelReader();
    let buffer = Buffer.alloc(0);
    let message = null;
    let upgraded = false;
    let settled = false;
    let timer = null;

    const settle = (closeCode, timedOutAfter) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer) {
        clearTimeout(timer);
      }

      socket.destroy();
      resolve(settlement(reader, closeCode, timedOutAfter));
    };

    socket.on(ready, () => {
      socket.write(handshakeRequest(execPath(pod, command, false), host, cred, {
        key:      crypto.randomBytes(16).toString('base64'),
        protocol: 'base64.channel.k8s.io',
      }));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');

        if (end === -1) {
          return;
        }

        const head = buffer.subarray(0, end).toString('latin1');

        buffer = buffer.subarray(end + 4);

        if (!/^HTTP\/1\.1 101/.test(head)) {
          // Not an upgrade, so there are no frames to read and the status line is the whole of
          // what happened. Reported as a transport failure with the line in it, because "403"
          // is the answer and "exit -1" is not.
          //
          // `httpStatus` carries that number out as a number, because a caller has to be able to
          // tell a refused exec from a broken one and reading it back out of English is not a
          // test anybody should have to write twice. Zero when the failure had no status at all,
          // which is every other way this promise settles.
          settled = true;
          socket.destroy();
          resolve({
            stdout:     '',
            stderr:     '',
            status:     `the pod exec was refused: ${ head.split('\r\n')[0] }`,
            code:       -1,
            transport:  true,
            httpStatus: statusLineCode(head),
          });

          return;
        }

        upgraded = true;
      }

      const { frames, rest } = readFrames(buffer);

      buffer = rest;

      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          settle(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1006);

          return;
        }

        // Fragments are joined before they are read, not after. The channel digit is on the
        // first fragment only and base64 is decoded four characters at a time, so handing a
        // continuation to the reader on its own would lose the channel and corrupt the payload.
        message = message === null ? frame.payload : Buffer.concat([message, frame.payload]);

        if (frame.fin) {
          reader.take(message);
          message = null;
        }
      }
    });

    socket.on('error', () => settle(0));
    socket.on('close', () => settle(1006));

    if (timeoutMs > 0) {
      // A socket that opens and then goes quiet, which is the failure that has no event of its
      // own. Without this the promise never settles and the screen waiting on it waits for the
      // rest of the session.
      timer = setTimeout(() => settle(0, timeoutMs), timeoutMs);
    }
  });
}
