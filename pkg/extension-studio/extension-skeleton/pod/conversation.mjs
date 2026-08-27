#!/usr/bin/env node
// The conversation, assembled where it lives.
//
//   node /seed/conversation.mjs [--since <iso>] [--limit <n>]
//
// Every message this extension's conversation contains, in order, as one JSON line. Every half
// of it comes out of the pod, because every half is already in the pod and none of it was ever
// the browser's to keep:
//
//   - what was asked   /app/.barn/provenance.jsonl, kind "prompt", written by the
//                      UserPromptSubmit hook as the prompt reaches claude
//   - what it left     the same file, kind "turn", written by the Stop hook with the commit
//                      and the files that turn touched
//   - what it said     claude's own transcripts under $HOME/.claude/projects
//
// It used to be assembled in the browser: the panel merged replies read from here with the
// user's own messages kept in sessionStorage. That is why the two halves could interleave
// wrongly, why a second tab saw half a conversation, and why clearing browser storage lost the
// side of it a person had actually written. The merge belongs on the side that has all three
// sources and one clock.
//
// The payload is escaped to ASCII on purpose. podExecResult decodes each exec frame with atob,
// which yields one character per byte, so a UTF-8 character would arrive as its bytes and
// render as mojibake. An escape is ASCII on the wire and the right character after JSON.parse.
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/app/.home';
const PROJECTS = path.join(HOME, '.claude', 'projects');
const PROVENANCE = '/app/.barn/provenance.jsonl';
const MARKER = 'BARN-CONVERSATION:';

/** One reply's prose, and the whole payload, both bounded: this is read on a poll. */
const TEXT_LIMIT = 2000;
const TOTAL_LIMIT = 60000;
/** How much of a transcript to read, and how many of them. */
const TAIL_BYTES = 1500000;
const FILES = 4;
const NON_ASCII = new RegExp('[' + '\\u0080-\\uffff' + ']', 'g');

function arg(name, fallback) {
  const at = process.argv.indexOf(name);

  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const since = arg('--since', '');
const limit = Math.max(1, Math.min(200, parseInt(arg('--limit', '60'), 10) || 60));

/**
 * The package this pod serves, found rather than named.
 *
 * One pod can hold conversations started in more than one directory - a terminal tab opened in
 * /app, say - and only the extension's own belong in its conversation.
 */
function packageDir() {
  try {
    const dirs = fs.readdirSync('/app/pkg', { withFileTypes: true }).filter((e) => e.isDirectory());

    return dirs.length ? path.join('/app/pkg', dirs[0].name) : '';
  } catch {
    return '';
  }
}

function readLines(file, bytes) {
  let fd;

  try {
    fd = fs.openSync(file, 'r');

    const size = fs.fstatSync(fd).size;
    const from = bytes ? Math.max(0, size - bytes) : 0;
    const buf = Buffer.alloc(size - from);

    fs.readSync(fd, buf, 0, buf.length, from);

    return buf.toString('utf8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch { /* already closed */ }
    }
  }
}

function transcripts() {
  const out = [];
  let dirs = [];

  try {
    dirs = fs.readdirSync(PROJECTS);
  } catch {
    return out;
  }

  for (const dir of dirs) {
    let names = [];

    try {
      names = fs.readdirSync(path.join(PROJECTS, dir));
    } catch {
      continue;
    }

    for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(PROJECTS, dir, name);

      try {
        out.push({ file, at: fs.statSync(file).mtimeMs });
      } catch { /* gone between readdir and stat */ }
    }
  }

  return out.sort((a, b) => a.at - b.at).slice(-FILES);
}

const PKG = packageDir();

// --- what was asked, and what each turn left -------------------------------
const asked = new Map();
const landed = new Map();

for (const line of readLines(PROVENANCE)) {
  let record;

  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }

  if (!record || typeof record !== 'object' || !record.turn) {
    continue;
  }

  if (record.kind === 'prompt') {
    asked.set(record.turn, record);
  } else if (record.kind === 'turn') {
    landed.set(record.turn, record);
  }
}

const messages = [];

for (const [turn, record] of asked) {
  const end = landed.get(turn);

  messages.push({
    id:      'prompt:' + turn,
    role:    'user',
    at:      record.at || '',
    text:    String(record.prompt || '').slice(0, TEXT_LIMIT),
    turn,
    session: record.session || '',
    who:     record.who || '',
    screen:  record.screen || '',
    // The turn's outcome rides on the message that started it, because that is the thing on
    // screen it belongs under. `ended` is what tells the panel a turn is no longer in flight.
    ended:   end ? end.at || '' : '',
    commit:  end ? end.commit || '' : '',
    files:   end && Array.isArray(end.files) ? end.files : [],
  });
}

// --- what it said ----------------------------------------------------------
let mode = '';
let version = '';
let session = '';

for (const entry of transcripts()) {
  for (const line of readLines(entry.file, TAIL_BYTES)) {
    let record;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!record || typeof record !== 'object') {
      continue;
    }

    if (PKG && record.cwd && record.cwd !== PKG) {
      continue;
    }

    if (record.version) {
      version = record.version;
    }

    if (record.sessionId) {
      session = record.sessionId;
    }

    if (record.permissionMode) {
      mode = record.permissionMode;
    }

    if (record.type !== 'assistant') {
      continue;
    }

    const content = record.message && Array.isArray(record.message.content) ? record.message.content : [];
    const text = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join('\n\n');

    if (!text) {
      continue;
    }

    messages.push({
      id:      'said:' + (record.uuid || (record.sessionId + ':' + record.timestamp)),
      role:    'assistant',
      at:      record.timestamp || '',
      text:    text.slice(0, TEXT_LIMIT),
      model:   (record.message && record.message.model) || '',
      error:   record.isApiErrorMessage ? String(record.error || 'the request failed') : '',
      session: record.sessionId || '',
    });
  }
}

// --- one conversation ------------------------------------------------------
messages.sort((a, b) => String(a.at).localeCompare(String(b.at)));

const fresh = since ? messages.filter((m) => String(m.at) >= since) : messages;

// Newest first until the budget runs out, then back into order. Older messages are dropped
// whole rather than truncated, so what is shown is what was said.
const kept = [];
let budget = TOTAL_LIMIT;

for (let i = fresh.length - 1; i >= 0 && kept.length < limit && budget > 0; i--) {
  kept.unshift(fresh[i]);
  budget -= fresh[i].text.length;
}

const answered = messages.filter((m) => m.role === 'assistant' && m.model && m.model !== '<synthetic>' && !m.error);

const payload = JSON.stringify({
  read:     true,
  dir:      PKG,
  session,
  version,
  mode,
  model:    answered.length ? answered[answered.length - 1].model : '',
  total:    fresh.length,
  messages: kept,
});

process.stdout.write(MARKER + payload.replace(NON_ASCII, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
