#!/bin/bash
# One dev server for the whole session, for iterating without a build.
#
# `build-pkg` plus `install-barn.mjs` plus a browser reload is about a minute, and it is the wrong
# loop for changing a template and looking at it. The dev server compiles incrementally and hot
# reloads, so the loop is seconds. Reserve the build for integration: the installed bundle is what
# a user actually loads, and only that path exercises UIPlugin loading, the cache-buster and the
# `direct: true` endpoint.
#
# Why this is a script and not "run yarn dev":
#
#   * ONE instance. Three of them ran at once earlier and took the container to 700MB free of 64GB.
#     This refuses to start a second.
#   * NO restart loop. The thing that actually exhausted memory was a `while true; do yarn dev; done`
#     keeper: killing the server just spawned another, four times, until the keeper itself was found.
#     If this one dies, it stays dead and you look at the log.
#   * A memory ceiling, so a runaway compile is killed rather than taking the machine with it.
#
# usage: dev-server.sh [start|stop|status|log]
set -uo pipefail

PORT=8005
DIR=/workspace/magic-closet/barn
LOG=/tmp/claude-1000/-workspace/ac9b64f7-2a05-49e6-a23f-840e9655eaa0/scratchpad/dev-server.log
PIDF=/tmp/claude-1000/-workspace/ac9b64f7-2a05-49e6-a23f-840e9655eaa0/scratchpad/dev-server.pid

running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat $PIDF)) on :$PORT"; exit 0; fi
    if pgrep -f 'node_modules/.bin/vue-cli-service serve' >/dev/null 2>&1; then
      echo "a vue-cli-service is already running that this script does not own. Stop it first:" >&2
      ps -eo pid,rss,args | grep '[v]ue-cli-service serve' >&2
      exit 1
    fi
    cd "$DIR" || exit 1
    # 3GB ceiling: a dev build settles around 2GB, and a runaway one should die rather than swap.
    API=https://magic-closet-rancher HOST=0.0.0.0 PORT=$PORT NODE_TLS_REJECT_UNAUTHORIZED=0 \
      NODE_OPTIONS=--max-old-space-size=3072 \
      nohup ./node_modules/.bin/vue-cli-service serve > "$LOG" 2>&1 &
    echo $! > "$PIDF"
    echo "started (pid $(cat $PIDF)), log: $LOG"
    echo "waiting for the first compile..."
    for _ in $(seq 1 90); do
      grep -qE 'App running at|Compiled successfully' "$LOG" 2>/dev/null && break
      running || { echo "died during startup, last lines:"; tail -15 "$LOG"; exit 1; }
      sleep 2
    done
    grep -qE 'App running at|Compiled successfully' "$LOG" && echo "ready on http://localhost:$PORT" || echo "still compiling, watch $LOG"
    ;;
  stop)
    if running; then kill "$(cat $PIDF)" 2>/dev/null; sleep 2; kill -9 "$(cat $PIDF)" 2>/dev/null; fi
    rm -f "$PIDF"
    pkill -f 'node_modules/.bin/vue-cli-service serve' 2>/dev/null
    echo "stopped"
    ;;
  log)  tail -40 "$LOG" 2>/dev/null || echo "no log yet" ;;
  *)
    if running; then
      echo "running (pid $(cat $PIDF), $(ps -o rss= -p "$(cat $PIDF)" 2>/dev/null | awk '{printf "%.1fGB", $1/1048576}')) on :$PORT"
    else
      echo "not running"
    fi
    ;;
esac
