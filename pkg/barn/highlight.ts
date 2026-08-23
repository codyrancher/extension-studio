// Syntax colouring for the Files screen's code pane.
//
// Small on purpose. The alternative is a highlighter library, and the three that would do this
// properly (highlight.js, prism, shiki) are between 30kB and a grammar-per-language download
// each, added to an extension bundle whose whole job is to be loaded into somebody else's
// Rancher at runtime. What this pane shows is one package's own source - TypeScript, Vue,
// JSON, YAML, markdown, the odd shell script - and a scanner that knows comments, strings,
// numbers and keywords covers all of it.
//
// It tokenises the whole file rather than a line at a time, because the two things that most
// need colouring - a block comment and a template literal - do not end on the line they start
// on, and a per-line scanner gets them wrong in the way that is most distracting: half a
// comment coloured, the rest read as code.

/** A run of characters with one colour. `c` is '' for text that gets the pane's own colour. */
export interface Token {
  t: string;
  c: string;
}

export type Line = Token[];

const KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace',
  'never', 'new', 'null', 'number', 'of', 'private', 'protected', 'public', 'readonly',
  'return', 'set', 'static', 'string', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'type', 'typeof', 'undefined', 'unknown', 'var', 'void', 'while', 'yield',
  // The shell keywords, for the pod scripts in the tree.
  'echo', 'elif', 'esac', 'exit', 'exec', 'fi', 'then', 'local', 'unset',
]);

/** Which scanner a path gets. Everything that is not markdown or YAML is scanned as code. */
export function modeFor(path: string): 'markdown' | 'yaml' | 'code' {
  const ext = (path.split('.').pop() || '').toLowerCase();

  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }

  if (ext === 'yaml' || ext === 'yml') {
    return 'yaml';
  }

  return 'code';
}

/** `#` starts a comment in these and is a colour or a private field in the others. */
function hashComments(path: string): boolean {
  const name = path.split('/').pop() || '';
  const ext = (name.split('.').pop() || '').toLowerCase();

  return ext === 'sh' || ext === 'bash' || ext === 'conf' || !name.includes('.');
}

function codePattern(hash: boolean): RegExp {
  return new RegExp([
    '(/\\*[\\s\\S]*?(?:\\*/|$))',                 // block comment
    '(<!--[\\s\\S]*?(?:-->|$))',                  // html comment (a .vue template)
    '(//[^\\n]*)',                                // line comment
    hash ? '(#[^\\n]*)' : '([^\\s\\S])',              // shell line comment, or a group that cannot match
    '(\'(?:\\\\.|[^\'\\\\\\n])*\'?)',             // 'string'
    '("(?:\\\\.|[^"\\\\\\n])*"?)',                // "string"
    '(`(?:\\\\.|[^`\\\\])*`?)',                   // `template literal`, which may span lines
    '(\\b\\d[\\w.]*)',                            // number
    '([A-Za-z_$][\\w$]*)',                        // word
  ].join('|'), 'g');
}

/**
 * Split a scanned run into lines, so a block comment or a template literal keeps its colour
 * across every line it covers.
 */
function push(lines: Line[], text: string, cls: string): void {
  const parts = text.split('\n');

  parts.forEach((part, i) => {
    if (i > 0) {
      lines.push([]);
    }

    if (part) {
      lines[lines.length - 1].push({ t: part, c: cls });
    }
  });
}

function scanCode(text: string, hash: boolean): Line[] {
  const lines: Line[] = [[]];
  const re = codePattern(hash);
  let last = 0;
  let m = re.exec(text);

  while (m) {
    if (m.index > last) {
      push(lines, text.slice(last, m.index), '');
    }

    const [whole, block, html, line, shell, single, double, backtick, num, word] = m;

    if (block || html || line || shell) {
      push(lines, whole, 'comment');
    } else if (single || double || backtick) {
      push(lines, whole, 'string');
    } else if (num) {
      push(lines, whole, 'number');
    } else if (word) {
      push(lines, whole, KEYWORDS.has(word) ? 'keyword' : '');
    } else {
      push(lines, whole, '');
    }

    last = m.index + whole.length;
    // A pattern that matched nothing would spin here forever. It cannot, because every
    // alternative above consumes at least one character - but a future edit to one of them
    // could, and an infinite loop in a render path is a hung tab rather than a wrong colour.
    re.lastIndex = Math.max(re.lastIndex, last + (whole.length ? 0 : 1));
    m = re.exec(text);
  }

  if (last < text.length) {
    push(lines, text.slice(last), '');
  }

  return lines;
}

const YAML_KEY = /^(\s*(?:-\s+)?)([\w.\-/]+)(\s*:)/;
const QUOTED = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/;

function scanYaml(text: string): Line[] {
  return text.split('\n').map((raw) => {
    const out: Line = [];
    const comment = raw.indexOf('#');
    const code = comment >= 0 ? raw.slice(0, comment) : raw;
    const rest = comment >= 0 ? raw.slice(comment) : '';
    let body = code;

    const key = YAML_KEY.exec(code);

    if (key) {
      out.push({ t: key[1], c: '' }, { t: key[2], c: 'keyword' }, { t: key[3], c: '' });
      body = code.slice(key[0].length);
    }

    body.split(QUOTED).forEach((part, i) => {
      if (part) {
        out.push({ t: part, c: i % 2 ? 'string' : '' });
      }
    });

    if (rest) {
      out.push({ t: rest, c: 'comment' });
    }

    return out;
  });
}

const MD_HEADING = /^#{1,6}\s/;
const MD_BULLET = /^(\s*(?:[-*+]|\d+\.)\s)/;
const MD_INLINE = /(`[^`]*`|\[[^\]]*\]\([^)]*\))/;

function scanMarkdown(text: string): Line[] {
  let fenced = false;

  return text.split('\n').map((raw) => {
    if (raw.trimStart().startsWith('```')) {
      fenced = !fenced;

      return [{ t: raw, c: 'meta' }];
    }

    if (fenced) {
      return raw ? [{ t: raw, c: 'string' }] : [];
    }

    if (MD_HEADING.test(raw)) {
      return [{ t: raw, c: 'keyword' }];
    }

    const out: Line = [];
    let body = raw;
    const bullet = MD_BULLET.exec(raw);

    if (bullet) {
      out.push({ t: bullet[1], c: 'meta' });
      body = raw.slice(bullet[1].length);
    }

    body.split(MD_INLINE).forEach((part, i) => {
      if (part) {
        out.push({ t: part, c: i % 2 ? 'string' : '' });
      }
    });

    return out;
  });
}

/**
 * One entry per line of `text`, each a list of coloured runs.
 *
 * The line count matches `text.split('\n')` exactly, so the gutter and the code stay in step:
 * the pane numbers from the same array this returns.
 */
export function highlight(text: string, path: string): Line[] {
  if (!text) {
    return [];
  }

  const body = text.replace(/\n$/, '');
  const mode = modeFor(path);

  if (mode === 'markdown') {
    return scanMarkdown(body);
  }

  if (mode === 'yaml') {
    return scanYaml(body);
  }

  return scanCode(body, hashComments(path));
}
