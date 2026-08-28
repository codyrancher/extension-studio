// Composing what actually gets run inside a pod.
//
// Three pieces of knowledge that were in the browser and belong here, because all three are
// facts about the pod rather than about the screen that wanted something from it: who a command
// has to run as, where the extension's package is, and how to quote an argument so a name with
// an apostrophe in it does not become two words.
//
// The other copy is pkg/extension-studio/extensions.ts, which still composes these for the
// calls that have not moved. The shapes are duplicated rather than shared because a browser
// bundle cannot import this file, and both are short enough to read side by side.
/** The tmux session the workspace's terminal attaches to. `mc-` is the prefix shell.sh uses. */
export const ASSISTANT_SESSION = 'mc-editor';

/** One shell argument, whatever is in it. */
export function shellQuote(value) {
  return `'${ String(value).split("'").join(`'\\''`) }'`;
}

/**
 * A command run in the pod as the user that owns the tree.
 *
 * The exec subresource runs as the container's user, which is root, and everything under /app
 * belongs to uid 1000: boot.sh hands it over so that claude, which refuses to run as root, can
 * edit what the dev server is watching. Two things go wrong without this drop. git refuses a
 * tree it calls "dubious ownership", and a file written here comes out root-owned, which claude
 * then cannot edit - a failure that surfaces minutes later in a pane nobody was watching.
 *
 * HOME with it. setpriv changes the uid and not the environment, so HOME would stay /root and
 * git then warns on every call that it cannot read /root/.config/git.
 */
export function asPodUser(script) {
  const withHome = `export HOME=/app/.home; ${ script }`;

  return ['/bin/sh', '-c', `setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c ${ shellQuote(withHome) }`];
}

/**
 * The package directory an extension owns, resolved by its own name first.
 *
 * This was once a glob over /app/pkg taking the first directory, on the reasoning that a pod
 * holds exactly one package. True of a pod created after extensions started being renamed off
 * their seed, and false of every pod created before it: `demo`'s pod holds both `/app/pkg/base`
 * and `/app/pkg/demo`, and the glob takes them alphabetically, so every read and write for
 * `demo` was operating on `base`'s tree. Named lookup first; the glob stays for an imported
 * repository whose package keeps the name it had upstream.
 *
 * Not exported: inPackageCommand below is the way in, so nothing composes a cd of its own that
 * skips the setpriv drop or the braces around the script.
 */
function packageDir(name) {
  const quoted = shellQuote(name).replace(/^'|'$/g, '');

  return `"$(d=/app/pkg/${ quoted } ; [ -d "$d" ] && printf %s "$d" || ls -d /app/pkg/*/ | head -1)"`;
}

/**
 * A script run in the extension's package directory, as the tree's owner.
 *
 * Braces rather than a bare `&&`. Several of these scripts are `;`-separated lists, and
 * `cd X && a ; b` only guards `a`: a failed cd would run the rest of the list wherever the
 * shell happened to be, which for `git init` means initialising a repository in /.
 */
export function inPackageCommand(name, script) {
  return asPodUser(`cd ${ packageDir(name) } && { ${ script } ; }`);
}
