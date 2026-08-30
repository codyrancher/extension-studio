#!/usr/bin/env bash
# Rebuild the package in place, at the version it already has.
#
#   scripts/dev-build.sh            once
#   scripts/dev-build.sh --watch    on every save
#
# The loop this replaces was: bump the version, run build-pkg, patch the UIPlugin at the new
# version, reload. That is a version and a kubectl write per iteration, and it left 33 versions
# and half a gigabyte in dist-pkg over one session's work.
#
# None of it is needed. The UIPlugin's endpoint is a fixed URL and it is created with
# `noCache: true`, so the browser re-fetches the bundle every load - rebuilding into the same
# directory is picked up by a page refresh on its own. A version bump only matters when
# publishing, where the version is what somebody installs.
#
# This is what build-pkg.sh runs, minus the version handling: same vue-cli-service invocation,
# same destination, plus --watch when asked.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
PKG=pkg/extension-studio
VERSION=$(node -p "require('./$PKG/package.json').version")
NAME="extension-studio-$VERSION"
DEST="$ROOT/dist-pkg/$NAME"

WATCH=""
[ "${1:-}" = "--watch" ] && WATCH="--watch"

# The shell's own build wants this symlink beside the package, and removes it afterwards. Under
# --watch the process does not end, so it is cleaned up on the way out instead of after.
cd "$PKG"
ln -sfn "$ROOT/node_modules/@rancher/shell" .shell
trap 'rm -f "$ROOT/$PKG/.shell"' EXIT

# Built to one side and swapped in, not written where the browser is reading.
#
# The bundle is served from a fixed URL, so a build that writes straight into $DEST leaves it
# truncated for as long as the build takes - and a page loaded in that window gets a partial
# script, the extension fails to initialise, and the chord opens nothing. That looks like the
# feature breaking rather than a build being half done, which is exactly how it was first
# reported. Swapping a finished directory in shrinks the window to a rename.
#
# --watch keeps the old behaviour on purpose: it rebuilds continuously, there is no moment when
# a build is "finished" to swap, and anyone running it is watching the output.
if [ -n "$WATCH" ]; then
  echo "building $NAME in place, watching"
  exec "$ROOT/node_modules/.bin/vue-cli-service" build \
    --name "$NAME" --target lib index.ts \
    --dest "$DEST" --formats umd-min --filename "$NAME" --watch
fi

STAGE="$DEST.building"
rm -rf "$STAGE"

echo "building $NAME"

"$ROOT/node_modules/.bin/vue-cli-service" build \
  --name "$NAME" --target lib index.ts \
  --dest "$STAGE" --formats umd-min --filename "$NAME"

# package.json and the rest of what build-pkg writes alongside the bundle.
[ -f "$DEST/package.json" ] && cp -f "$DEST/package.json" "$STAGE/package.json"

PREV="$DEST.previous"
rm -rf "$PREV"
[ -d "$DEST" ] && mv "$DEST" "$PREV"
mv "$STAGE" "$DEST"
rm -rf "$PREV"

echo "swapped in: $DEST"
