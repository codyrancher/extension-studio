#!/bin/sh
# The conversations this pod is holding: list them, or end one named on the command line.
#
# tmux is the list, and this is how it is asked. Nothing in the browser records which tabs were
# opened: a second browser tab has to see the same conversations as the first, and a reload has
# to find all of them, so the only answer that can be right is the pod's.
#
# Both verbs are one script because both need the same thing to be true first, and it is the
# thing that is easy to get wrong. A tmux server is per user, and shell.sh starts every session
# as the node user; the exec subresource arrives as root. Run as root, `tmux ls` asks root's
# server, which has never had a session in it and cheerfully reports none - and `kill-session`
# would say the session does not exist.
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh /seed/sessions.sh "$@"
fi

# `mc-` is the prefix shell.sh puts on every session it creates. It is added here and stripped
# below, so the caller only ever deals in the names it passes in.
if [ -n "$1" ]; then
  tmux kill-session -t "mc-$1" 2>/dev/null
  exit 0
fi

# No tmux server at all - a pod nobody has opened a terminal in yet - means no sessions, which
# tmux reports on stderr with a non-zero exit. That is an empty list rather than a failure,
# hence the redirect and the exit.
tmux ls -F '#{session_name}' 2>/dev/null | sed -n 's/^mc-//p'

exit 0
