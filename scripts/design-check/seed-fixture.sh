#!/bin/bash
# Give the pod the uncommitted work the measuring harness needs to see.
#
# Screens 04 and 12 draw a file list and a diff, and screen 05 draws a change count. With a clean
# working tree they correctly draw none of those, and `measure.mjs` reports a dozen selectors
# missing - which looks exactly like a rendering regression and is not one. That happened after a
# round of verifiers committed their scratch work and left the tree clean.
#
# So the fixture is part of the harness, not something a run can assume. This writes one modified
# tracked file and one new file, which between them produce an added row, a removed row and an
# untracked entry.
#
# `undo` puts it back. Run it when you are done, or the next person to open the Studio sees a
# change nobody made.
set -euo pipefail
POD='deploy/barn-base-extension'
MARK='harness fixture: delete this line'

case "${1:-seed}" in
  seed)
    kubectl -n barn exec $POD -- sh -c "cd /app/pkg/*/ && \
      printf '\n// %s\n' '$MARK' >> product.ts && \
      printf '# Harness fixture\n\nA new file, so the file list has an untracked row.\n' > HARNESS.md"
    echo "seeded: product.ts modified, HARNESS.md added"
    ;;
  undo)
    kubectl -n barn exec $POD -- sh -c "cd /app/pkg/*/ && \
      git checkout -- product.ts 2>/dev/null ; rm -f HARNESS.md ; git reset -q -- HARNESS.md 2>/dev/null ; true"
    echo "removed"
    ;;
  *) echo "usage: seed-fixture.sh [seed|undo]" >&2; exit 2 ;;
esac
kubectl -n barn exec $POD -- sh -c 'cd /app/pkg/*/ && git status --porcelain'
